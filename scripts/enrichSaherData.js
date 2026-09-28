/**
 * enrichSaherData.js — One-time data-enrichment pipeline.
 *
 * Reads the curated Saher (speed / red-light) camera coordinates from
 *   frontend/Riyadh_Intersections.csv
 * resolves the real posted speed limit at each coordinate via:
 *
 *   1. OpenStreetMap Overpass API   — preferred (free, accurate maxspeed tag).
 *   2. TomTom Flow Segment Data    — fallback when OSM has no maxspeed.
 *   3. 80 km/h                     — final fallback (Riyadh urban default).
 *
 * Writes the cleaned dataset to:
 *   frontend/src/data/saherCameras.json
 *
 * Output schema per entry:
 *   { id: "saher_001", lat: 24.6915, lng: 46.6720, speedLimit: 80 }
 *
 * USAGE
 * ─────
 *   # Optional: enable the TomTom fallback by setting an API key.
 *   $env:TOMTOM_API_KEY="<your_key>"      # PowerShell
 *   export TOMTOM_API_KEY=<your_key>      # bash
 *
 *   node scripts/enrichSaherData.js
 *
 * Requires Node.js 18+ (uses the built-in global `fetch`).
 */

"use strict";

const fs = require("fs");
const path = require("path");

// ─── Paths ────────────────────────────────────────────────────────────────────

const CSV_INPUT_PATH  = path.resolve(__dirname, "../frontend/Riyadh_Intersections.csv");
const JSON_OUTPUT_DIR = path.resolve(__dirname, "../frontend/src/data");
const JSON_OUTPUT_PATH = path.join(JSON_OUTPUT_DIR, "saherCameras.json");

// ─── Tunables ────────────────────────────────────────────────────────────────

// Search radius (m) to find the nearest highway way for a given camera point.
// 30 m comfortably covers GPS noise on a multi-lane arterial.
const NEAREST_ROAD_RADIUS_METERS = 30;

// Min delay between successive remote calls.  Overpass's public endpoint
// rejects burst traffic and the policy guidance is "be nice".  1.2 s leaves
// a comfortable margin for ~92 cameras (~2 minutes total).
const REQUEST_THROTTLE_MS = 1200;

// HTTP request timeout.  Overpass is sometimes slow; 20 s avoids spurious
// failures while still aborting genuinely stalled requests.
const REQUEST_TIMEOUT_MS = 20000;

// Riyadh urban default — used only when both Overpass and TomTom decline.
const FALLBACK_SPEED_LIMIT_KMH = 80;

// Allowed speed-limit range.  Anything outside this is treated as garbage
// (Overpass occasionally returns "signals" or huge numbers from rogue edits).
const MIN_VALID_SPEED_LIMIT = 30;
const MAX_VALID_SPEED_LIMIT = 140;

const TOMTOM_API_KEY = process.env.TOMTOM_API_KEY || process.env.REACT_APP_TOMTOM_API_KEY;

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Pause execution for `ms` milliseconds.
 * Used between API calls to respect Overpass's fair-use throttling guidance.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Best-effort fetch with a hard timeout.  Returns the parsed JSON or throws.
 */
const fetchJsonWithTimeout = async (url, init = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Parse the very small Riyadh_Intersections.csv shape.
 *
 *   #,Description,Latitude,Longitude
 *   1,Takhassusi St ...,24.691516,46.672050
 *
 * The CSV has no embedded commas that need quoting, so a plain split is safe.
 */
const parseSaherCsv = (rawCsv) => {
  const lines = rawCsv.split(/\r?\n/).filter((line) => line.trim().length > 0);

  // Drop header row (first row containing literal "Latitude").
  const dataLines = lines.slice(1);

  const records = [];
  for (const line of dataLines) {
    const cells = line.split(",");
    if (cells.length < 4) continue;

    const indexCell = cells[0].trim();
    const description = cells.slice(1, cells.length - 2).join(",").trim();
    const latitudeCell = cells[cells.length - 2].trim();
    const longitudeCell = cells[cells.length - 1].trim();

    const indexNumber = parseInt(indexCell, 10);
    const latitude = parseFloat(latitudeCell);
    const longitude = parseFloat(longitudeCell);

    if (!Number.isFinite(indexNumber) || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      continue;
    }

    records.push({
      id: `saher_${String(indexNumber).padStart(3, "0")}`,
      description,
      lat: latitude,
      lng: longitude,
    });
  }
  return records;
};

/**
 * Coerce a raw OSM `maxspeed` tag value to an integer km/h.
 *
 * Accepts shapes like:
 *   "80"        → 80
 *   "80 km/h"   → 80
 *   "50 mph"    → 80   (converted)
 *
 * Returns null when the tag cannot be parsed or falls outside the valid range.
 */
const normalizeOsmMaxspeed = (rawValue) => {
  if (typeof rawValue !== "string") return null;

  const trimmed = rawValue.trim().toLowerCase();
  const numericMatch = trimmed.match(/(\d+(?:\.\d+)?)/);
  if (!numericMatch) return null;

  let kmh = parseFloat(numericMatch[1]);
  if (trimmed.includes("mph")) {
    kmh = kmh * 1.609344;
  }
  const rounded = Math.round(kmh / 5) * 5;

  if (rounded < MIN_VALID_SPEED_LIMIT || rounded > MAX_VALID_SPEED_LIMIT) {
    return null;
  }
  return rounded;
};

/**
 * Aggregate multiple OSM speed-limit candidates into a single representative
 * value.  Picks the median so a single rogue OSM edit can't skew the result.
 */
const pickRepresentativeSpeedLimit = (candidates) => {
  const sorted = [...candidates].sort((a, b) => a - b);
  const middleIndex = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middleIndex - 1] + sorted[middleIndex]) / 2 / 5) * 5
    : sorted[middleIndex];
};

// ─── External API calls ──────────────────────────────────────────────────────

/**
 * Query OpenStreetMap Overpass for the maxspeed tag(s) of any highway way
 * within NEAREST_ROAD_RADIUS_METERS of (lat, lng).  Returns an integer km/h
 * speed limit or null when no usable data is found.
 */
const fetchSpeedLimitFromOverpass = async (lat, lng) => {
  const overpassQuery = `
    [out:json][timeout:15];
    (
      way(around:${NEAREST_ROAD_RADIUS_METERS},${lat},${lng})["highway"]["maxspeed"];
    );
    out tags;
  `.trim();

  const url = "https://overpass-api.de/api/interpreter";
  const body = `data=${encodeURIComponent(overpassQuery)}`;

  let payload;
  try {
    payload = await fetchJsonWithTimeout(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Trafstant-SaherEnrichmentScript/1.0",
      },
      body,
    });
  } catch (err) {
    console.warn(`  ↳ Overpass error: ${err.message}`);
    return null;
  }

  const elements = Array.isArray(payload?.elements) ? payload.elements : [];
  if (elements.length === 0) return null;

  const candidates = [];
  for (const element of elements) {
    const normalized = normalizeOsmMaxspeed(element?.tags?.maxspeed);
    if (normalized != null) candidates.push(normalized);
  }
  if (candidates.length === 0) return null;

  return pickRepresentativeSpeedLimit(candidates);
};

/**
 * Query TomTom Flow Segment Data for `freeFlowSpeed` — the maximum un-congested
 * speed on the segment.  Used as a proxy for the posted limit when OSM lacks
 * a maxspeed tag.  Returns an integer km/h or null when the API declines.
 */
const fetchSpeedLimitFromTomTom = async (lat, lng) => {
  if (!TOMTOM_API_KEY) return null;

  const url = "https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json"
    + `?key=${encodeURIComponent(TOMTOM_API_KEY)}`
    + `&point=${lat},${lng}`
    + "&unit=kmh";

  let payload;
  try {
    payload = await fetchJsonWithTimeout(url);
  } catch (err) {
    console.warn(`  ↳ TomTom error: ${err.message}`);
    return null;
  }

  const freeFlowSpeed = payload?.flowSegmentData?.freeFlowSpeed;
  if (!Number.isFinite(freeFlowSpeed)) return null;

  const rounded = Math.round(freeFlowSpeed / 5) * 5;
  if (rounded < MIN_VALID_SPEED_LIMIT || rounded > MAX_VALID_SPEED_LIMIT) return null;
  return rounded;
};

/**
 * Resolve a single camera's speed limit, trying each source in priority order.
 */
const resolveSpeedLimit = async (lat, lng) => {
  const fromOverpass = await fetchSpeedLimitFromOverpass(lat, lng);
  if (fromOverpass != null) {
    return { speedLimit: fromOverpass, source: "overpass" };
  }

  const fromTomTom = await fetchSpeedLimitFromTomTom(lat, lng);
  if (fromTomTom != null) {
    return { speedLimit: fromTomTom, source: "tomtom" };
  }

  return { speedLimit: FALLBACK_SPEED_LIMIT_KMH, source: "fallback" };
};

// ─── Main entry point ────────────────────────────────────────────────────────

const main = async () => {
  console.log("► Reading CSV:", CSV_INPUT_PATH);
  if (!fs.existsSync(CSV_INPUT_PATH)) {
    console.error("✗ CSV not found. Aborting.");
    process.exit(1);
  }

  const rawCsv = fs.readFileSync(CSV_INPUT_PATH, "utf8");
  const records = parseSaherCsv(rawCsv);
  console.log(`► Parsed ${records.length} camera coordinates.`);

  if (!TOMTOM_API_KEY) {
    console.log("ℹ TOMTOM_API_KEY not set — TomTom fallback disabled (Overpass + 80 km/h only).");
  }

  fs.mkdirSync(JSON_OUTPUT_DIR, { recursive: true });

  const enrichedCameras = [];
  const sourceCounts = { overpass: 0, tomtom: 0, fallback: 0 };

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const progressLabel = `[${i + 1}/${records.length}]`;
    console.log(`${progressLabel} ${record.id}  (${record.lat}, ${record.lng})  — ${record.description.slice(0, 56)}`);

    let resolved;
    try {
      resolved = await resolveSpeedLimit(record.lat, record.lng);
    } catch (err) {
      console.warn(`  ↳ unexpected error: ${err.message}`);
      resolved = { speedLimit: FALLBACK_SPEED_LIMIT_KMH, source: "fallback" };
    }

    sourceCounts[resolved.source] = (sourceCounts[resolved.source] ?? 0) + 1;
    console.log(`  ↳ ${resolved.speedLimit} km/h  (source: ${resolved.source})`);

    enrichedCameras.push({
      id: record.id,
      lat: record.lat,
      lng: record.lng,
      speedLimit: resolved.speedLimit,
    });

    // Throttle every request EXCEPT the very last one.
    if (i < records.length - 1) {
      await sleep(REQUEST_THROTTLE_MS);
    }
  }

  fs.writeFileSync(JSON_OUTPUT_PATH, JSON.stringify(enrichedCameras, null, 2) + "\n", "utf8");

  console.log("");
  console.log(`✓ Wrote ${enrichedCameras.length} cameras to ${JSON_OUTPUT_PATH}`);
  console.log(`  Sources — overpass: ${sourceCounts.overpass}, tomtom: ${sourceCounts.tomtom}, fallback: ${sourceCounts.fallback}`);
};

main().catch((err) => {
  console.error("✗ Fatal:", err);
  process.exit(1);
});
