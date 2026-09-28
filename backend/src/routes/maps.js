const express = require("express");
const {
  fetchRoutes,
  searchPlaces,
  geocode,
  generateRiyadhGrid,
  fetchFlowForPoint,
  RIYADH_CENTER,
} = require("../services/tomtomRouting");

const router = express.Router();

const TRAFFIC_CACHE_TTL_MS = 5 * 60 * 1000;
let lastTrafficData = null;
let lastFetchTime = 0;
let inflightTrafficFetch = null;

router.get("/traffic", async (req, res) => {
  const now = Date.now();

  if (lastTrafficData !== null && now - lastFetchTime < TRAFFIC_CACHE_TTL_MS) {
    return res.json(lastTrafficData);
  }

  if (inflightTrafficFetch !== null) {
    try {
      return res.json(await inflightTrafficFetch);
    } catch (_err) {
      if (lastTrafficData !== null) return res.json(lastTrafficData);
      return res.status(502).json({ error: "Traffic data temporarily unavailable." });
    }
  }

  inflightTrafficFetch = (async () => {
    const grid = generateRiyadhGrid();
    const results = await Promise.all(
      grid.map(({ lat, lng }) => fetchFlowForPoint(lat, lng))
    );
    return {
      center: RIYADH_CENTER,
      updatedAt: new Date(),
      points: results,
    };
  })();

  try {
    const fresh = await inflightTrafficFetch;
    lastTrafficData = fresh;
    lastFetchTime = Date.now();
    return res.json(fresh);
  } catch (err) {
    console.error("[traffic]", err.message);
    if (lastTrafficData !== null) return res.json(lastTrafficData);
    return res.status(502).json({ error: "Traffic data temporarily unavailable." });
  } finally {
    inflightTrafficFetch = null;
  }
});

router.get("/geocode", async (req, res) => {
  const q = (req.query.q || "").trim();
  if (q.length < 2) {
    return res.status(400).json({ error: "q must be at least 2 characters" });
  }
  const result = await geocode(q);
  if (!result) return res.status(404).json({ error: "No results found" });
  return res.json(result);
});

router.get("/search-places", async (req, res) => {
  const query = (req.query.query || "").trim();
  if (query.length < 2) {
    return res.status(400).json({ error: "query must be at least 2 characters" });
  }
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  const results = await searchPlaces(
    query,
    Number.isFinite(lat) ? lat : undefined,
    Number.isFinite(lon) ? lon : undefined
  );
  return res.json(results);
});

router.post("/recommend-route", async (req, res) => {
  const { startLat, startLng, endLat, endLng, departAt } = req.body || {};
  const coords = [startLat, startLng, endLat, endLng].map(Number);
  if (coords.some(Number.isNaN)) {
    return res.status(400).json({
      error: "startLat, startLng, endLat, endLng must be valid numbers",
    });
  }
  const [fromLat, fromLng, toLat, toLng] = coords;
  const routes = await fetchRoutes(fromLat, fromLng, toLat, toLng, departAt || null);
  const recommendedIndex = Math.max(
    0,
    routes.findIndex((r) => r.isRecommended)
  );
  return res.json({
    routes,
    recommendedIndex,
    ...routes[recommendedIndex],
  });
});

router.get("/incidents", async (_req, res) => {
  // Pre-trip planner does not require live incident clustering; return empty list.
  return res.json({ incidents: [] });
});

module.exports = router;
