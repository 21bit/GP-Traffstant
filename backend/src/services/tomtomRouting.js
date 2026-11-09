const axios = require("axios");

const RIYADH_CENTER = { lat: 24.7136, lng: 46.6753 };

function getTomTomKey() {
  return process.env.TOMTOM_API_KEY || "";
}

function haversineDistanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function isNonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function toNonNegativeNumber(value) {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return isNonNegativeNumber(n) ? n : null;
}

/**
 * TomTom summary.travelTimeInSeconds is traffic-aware when traffic=true.
 * Prefer seconds for ranking precision; fall back to minute field.
 */
function getTravelTimeSeconds(route) {
  const seconds = toNonNegativeNumber(route.travelTimeInSeconds);
  if (seconds != null) return seconds;
  const minutes = toNonNegativeNumber(route.travelTime);
  return minutes == null ? null : minutes * 60;
}

/**
 * Prefer lengthInMeters; fall back to distance (km string/number).
 */
function getLengthMeters(route) {
  const meters = toNonNegativeNumber(route.lengthInMeters);
  if (meters != null) return meters;
  const km = toNonNegativeNumber(
    typeof route.distance === "string" ? parseFloat(route.distance) : route.distance
  );
  return km == null ? null : km * 1000;
}

/**
 * Congestion comparable for Least Traffic.
 * TomTom Routing does not return a congestion-level enum; trafficDelayInSeconds
 * is the verified delay field (traffic-aware travel time minus no-traffic time).
 * Derived trafficLevel is only a fallback for fixtures that supply level without delay.
 * Missing delay is never treated as zero congestion.
 */
function getCongestionComparable(route) {
  const delaySeconds = toNonNegativeNumber(route.trafficDelayInSeconds);
  if (delaySeconds != null) {
    return { kind: "delaySeconds", value: delaySeconds };
  }
  const delayMinutes = toNonNegativeNumber(route.trafficDelay);
  if (delayMinutes != null) {
    return { kind: "delayMinutes", value: delayMinutes };
  }
  if (
    route.trafficLevel === "low" ||
    route.trafficLevel === "medium" ||
    route.trafficLevel === "high"
  ) {
    const rank =
      route.trafficLevel === "high" ? 2 : route.trafficLevel === "medium" ? 1 : 0;
    return { kind: "level", value: rank };
  }
  return null;
}

function deriveTrafficLevel(delaySeconds, travelTimeSeconds) {
  if (delaySeconds == null || travelTimeSeconds == null) return "unknown";
  if (travelTimeSeconds <= 0) {
    return delaySeconds > 0 ? "high" : "low";
  }
  const delayRatio = delaySeconds / travelTimeSeconds;
  if (delayRatio > 0.3) return "high";
  if (delayRatio > 0.1) return "medium";
  return "low";
}

function normalizeRealRoute(routeData) {
  const legs = Array.isArray(routeData?.legs) ? routeData.legs : [];
  const route = legs.flatMap((leg) =>
    (leg.points || []).map((p) => [p.latitude, p.longitude])
  );
  const summary = routeData?.summary || {};

  const lengthInMeters = toNonNegativeNumber(summary.lengthInMeters);
  const travelTimeInSeconds = toNonNegativeNumber(summary.travelTimeInSeconds);
  const trafficDelayInSeconds = toNonNegativeNumber(summary.trafficDelayInSeconds);
  const trafficLevel = deriveTrafficLevel(
    trafficDelayInSeconds,
    travelTimeInSeconds
  );

  return {
    route,
    coordinates: route,
    trafficLevel,
    distance: lengthInMeters == null ? null : (lengthInMeters / 1000).toFixed(1),
    travelTime:
      travelTimeInSeconds == null ? null : Math.ceil(travelTimeInSeconds / 60),
    trafficDelay:
      trafficDelayInSeconds == null
        ? null
        : Math.ceil(trafficDelayInSeconds / 60),
    lengthInMeters,
    travelTimeInSeconds,
    trafficDelayInSeconds,
    trafficDataAvailable: trafficDelayInSeconds != null,
    source: "tomtom",
  };
}

const ROUTE_GREEN = "#22C55E";
const ROUTE_YELLOW = "#F59E0B";
const ROUTE_RED = "#EF4444";

function trafficBurden(route) {
  const level =
    route.trafficLevel === "high"
      ? 2
      : route.trafficLevel === "medium"
      ? 1
      : route.trafficLevel === "low"
      ? 0
      : 1;
  const delay =
    toNonNegativeNumber(route.trafficDelayInSeconds) != null
      ? toNonNegativeNumber(route.trafficDelayInSeconds) / 60
      : toNonNegativeNumber(route.trafficDelay);
  const travel = getTravelTimeSeconds(route);
  return (
    level * 10000 +
    (delay == null ? 5000 : delay * 100) +
    (travel == null ? 1e9 : travel)
  );
}

function colorsByTraffic(routes) {
  const colors = routes.map(() => ROUTE_YELLOW);
  if (routes.length === 0) return colors;

  const order = routes
    .map((route, index) => ({
      index,
      burden: trafficBurden(route),
      travel: getTravelTimeSeconds(route) ?? Number.POSITIVE_INFINITY,
    }))
    .sort((a, b) => a.burden - b.burden || a.travel - b.travel || a.index - b.index);

  colors[order[0].index] = ROUTE_GREEN;
  if (order.length > 1) colors[order[order.length - 1].index] = ROUTE_RED;
  return colors;
}

/**
 * Recommended: lowest traffic-aware travel time (TomTom travelTimeInSeconds).
 * Tie-break: shorter distance, then lower route index.
 */
function findRecommendedIndex(routes) {
  let best = -1;
  for (let i = 0; i < routes.length; i++) {
    const travel = getTravelTimeSeconds(routes[i]);
    if (travel == null) continue;
    if (best < 0) {
      best = i;
      continue;
    }
    const bestTravel = getTravelTimeSeconds(routes[best]);
    if (travel < bestTravel) {
      best = i;
      continue;
    }
    if (travel > bestTravel) continue;
    const dist = getLengthMeters(routes[i]);
    const bestDist = getLengthMeters(routes[best]);
    if (dist != null && bestDist != null && dist < bestDist) best = i;
    else if (dist != null && bestDist == null) best = i;
  }
  return best;
}

/**
 * Least Traffic: lowest verified traffic delay when available.
 * Fallback: derived/explicit trafficLevel only when delay is absent.
 * Tie-break: lower traffic-aware travel time, then lower route index.
 */
function findLeastTrafficIndex(routes) {
  let best = -1;
  let bestMetric = null;
  for (let i = 0; i < routes.length; i++) {
    const metric = getCongestionComparable(routes[i]);
    if (metric == null) continue;
    if (best < 0) {
      best = i;
      bestMetric = metric;
      continue;
    }
    if (metric.kind !== bestMetric.kind) {
      // Prefer delay-based metrics over level-only fallbacks.
      const rankKind = (kind) =>
        kind === "delaySeconds" || kind === "delayMinutes" ? 0 : 1;
      if (rankKind(metric.kind) < rankKind(bestMetric.kind)) {
        best = i;
        bestMetric = metric;
        continue;
      }
      if (rankKind(metric.kind) > rankKind(bestMetric.kind)) continue;
    }
    if (metric.value < bestMetric.value) {
      best = i;
      bestMetric = metric;
      continue;
    }
    if (metric.value > bestMetric.value) continue;
    const travel = getTravelTimeSeconds(routes[i]);
    const bestTravel = getTravelTimeSeconds(routes[best]);
    if (travel != null && bestTravel != null && travel < bestTravel) {
      best = i;
      bestMetric = metric;
    } else if (travel != null && bestTravel == null) {
      best = i;
      bestMetric = metric;
    }
  }
  return best;
}

/**
 * Shortest: lowest physical distance.
 * Tie-break: lower traffic-aware travel time, then lower route index.
 */
function findShortestIndex(routes) {
  let best = -1;
  for (let i = 0; i < routes.length; i++) {
    const dist = getLengthMeters(routes[i]);
    if (dist == null) continue;
    if (best < 0) {
      best = i;
      continue;
    }
    const bestDist = getLengthMeters(routes[best]);
    if (dist < bestDist) {
      best = i;
      continue;
    }
    if (dist > bestDist) continue;
    const travel = getTravelTimeSeconds(routes[i]);
    const bestTravel = getTravelTimeSeconds(routes[best]);
    if (travel != null && bestTravel != null && travel < bestTravel) best = i;
    else if (travel != null && bestTravel == null) best = i;
  }
  return best;
}

function labelAndColorRoutes(routes) {
  if (!Array.isArray(routes) || routes.length === 0) return [];

  const trafficColors = colorsByTraffic(routes);
  const recommendedIdx = findRecommendedIndex(routes);
  const leastTrafficIdx = findLeastTrafficIndex(routes);
  const shortestIdx = findShortestIndex(routes);

  // One category label per route. Category priority on a shared winner:
  // Recommended > Least Traffic > Shortest. Categories that select an
  // already-labeled route are omitted (no duplicate category display).
  return routes.map((r, i) => {
    let label = "Alternative";
    const color = trafficColors[i];

    if (i === recommendedIdx && recommendedIdx >= 0) {
      label = "Recommended";
    } else if (i === leastTrafficIdx && leastTrafficIdx >= 0) {
      label = "Least Traffic";
    } else if (i === shortestIdx && shortestIdx >= 0) {
      label = "Shortest";
    }

    return {
      ...r,
      id: `route-${i}-${label}`,
      label,
      color,
      isRecommended: recommendedIdx >= 0 && i === recommendedIdx,
    };
  });
}

function buildSyntheticRoutes(fromLat, fromLng, toLat, toLng) {
  const steps = 15;
  const offsets = [-0.025, 0, 0.025];
  const distanceKm = haversineDistanceKm(fromLat, fromLng, toLat, toLng);
  const baseTravelMin = Math.ceil((distanceKm / 50) * 60);

  return offsets.map((offset, i) => {
    const path = Array.from({ length: steps + 1 }, (_, step) => {
      const t = step / steps;
      return [
        fromLat + (toLat - fromLat) * t + offset * (1 - 2 * Math.abs(t - 0.5)),
        fromLng + (toLng - fromLng) * t,
      ];
    });

    const trafficLevel = i === 0 ? "medium" : i === 1 ? "low" : "high";
    const multiplier =
      trafficLevel === "high" ? 1.35 : trafficLevel === "medium" ? 1.15 : 1;
    const travelTime = Math.ceil(baseTravelMin * multiplier);
    const trafficDelay = travelTime - baseTravelMin;
    const distanceVariant = distanceKm * (1 + (i - 1) * 0.05);

    return {
      route: path,
      coordinates: path,
      trafficLevel,
      distance: distanceVariant.toFixed(1),
      travelTime,
      trafficDelay,
      lengthInMeters: Math.round(distanceVariant * 1000),
      travelTimeInSeconds: travelTime * 60,
      trafficDelayInSeconds: trafficDelay * 60,
      trafficDataAvailable: true,
      source: "synthetic",
    };
  });
}

/**
 * Fetch traffic-aware routes for a departure time (null = now).
 */
async function fetchRoutes(fromLat, fromLng, toLat, toLng, departAt = null) {
  const key = getTomTomKey();
  const safeDepartAt = (() => {
    if (!departAt) return null;
    const ts = Date.parse(departAt);
    if (Number.isNaN(ts)) return null;
    // TomTom accepts near-future; allow "now" ISO strings within 60s past
    if (ts < Date.now() - 60_000) return null;
    return new Date(Math.max(ts, Date.now() + 1000)).toISOString();
  })();

  if (!key) {
    console.warn("[tomtomRouting] No TOMTOM_API_KEY — using synthetic routes.");
    return labelAndColorRoutes(
      buildSyntheticRoutes(fromLat, fromLng, toLat, toLng)
    );
  }

  try {
    const url = `https://api.tomtom.com/routing/1/calculateRoute/${fromLat},${fromLng}:${toLat},${toLng}/json`;
    const response = await axios.get(url, {
      params: {
        key,
        routeType: "fastest",
        traffic: true,
        computeTravelTimeFor: "all",
        avoid: "unpavedRoads",
        travelMode: "car",
        maxAlternatives: 2,
        language: "ar",
        ...(safeDepartAt ? { departAt: safeDepartAt } : {}),
      },
      timeout: 15000,
    });

    const rawRoutes = response.data.routes || [];
    if (rawRoutes.length === 0) throw new Error("No routes returned by TomTom");

    return labelAndColorRoutes(rawRoutes.map(normalizeRealRoute));
  } catch (err) {
    console.warn(
      "[tomtomRouting] TomTom failed, synthetic fallback:",
      err.response?.status || err.message
    );
    return labelAndColorRoutes(
      buildSyntheticRoutes(fromLat, fromLng, toLat, toLng)
    );
  }
}

async function searchPlaces(query, biasLat, biasLon) {
  const key = getTomTomKey();
  if (!key || !query || query.length < 2) return [];

  const lat = Number.isFinite(biasLat) ? biasLat : RIYADH_CENTER.lat;
  const lon = Number.isFinite(biasLon) ? biasLon : RIYADH_CENTER.lng;

  try {
    const response = await axios.get(
      `https://api.tomtom.com/search/2/search/${encodeURIComponent(query)}.json`,
      {
        params: {
          key,
          countrySet: "SA",
          limit: 12,
          lat,
          lon,
          language: "ar",
        },
        timeout: 6000,
      }
    );

    return (response.data?.results || [])
      .filter(
        (r) =>
          Number.isFinite(r.position?.lat) && Number.isFinite(r.position?.lon)
      )
      .map((r) => ({
        name: r.poi?.name || r.address?.freeformAddress || query,
        lat: r.position.lat,
        lng: r.position.lon,
        distance: typeof r.dist === "number" ? Math.round(r.dist) : null,
        neighborhood:
          r.address?.municipalitySubdivision ||
          r.address?.municipality ||
          "",
        address: r.address?.freeformAddress || "",
        source: "tomtom",
      }));
  } catch (err) {
    console.warn("[searchPlaces]", err.message);
    return [];
  }
}

async function geocode(query) {
  const results = await searchPlaces(query);
  if (results.length === 0) return null;
  const top = results[0];
  return {
    name: top.name,
    city: top.neighborhood || "الرياض",
    lat: top.lat,
    lng: top.lng,
  };
}

function kmToDegrees(km) {
  return km / 111;
}

function generateRiyadhGrid() {
  const center = RIYADH_CENTER;
  const radiusKm = 10;
  const stepKm = 3;
  const step = kmToDegrees(stepKm);
  const radius = kmToDegrees(radiusKm);
  const points = [];
  for (let lat = center.lat - radius; lat <= center.lat + radius; lat += step) {
    for (let lng = center.lng - radius; lng <= center.lng + radius; lng += step) {
      points.push({ lat, lng });
    }
  }
  return points;
}

function computeDensity(currentSpeed, freeFlowSpeed) {
  if (!freeFlowSpeed || freeFlowSpeed <= 0) return "unknown";
  const ratio = currentSpeed / freeFlowSpeed;
  if (ratio < 0.4) return "high";
  if (ratio < 0.7) return "medium";
  return "low";
}

async function fetchFlowForPoint(lat, lng) {
  const key = getTomTomKey();
  if (!key) return { lat, lng, density: "unknown" };
  try {
    const response = await axios.get(
      "https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json",
      {
        params: { key, point: `${lat},${lng}`, unit: "kmh" },
        timeout: 5000,
      }
    );
    const data = response.data.flowSegmentData;
    return {
      lat,
      lng,
      currentSpeed: data.currentSpeed,
      freeFlowSpeed: data.freeFlowSpeed,
      density: computeDensity(data.currentSpeed, data.freeFlowSpeed),
    };
  } catch (_err) {
    return { lat, lng, density: "unknown" };
  }
}

module.exports = {
  RIYADH_CENTER,
  fetchRoutes,
  searchPlaces,
  geocode,
  generateRiyadhGrid,
  fetchFlowForPoint,
  haversineDistanceKm,
  labelAndColorRoutes,
  computeDensity,
  normalizeRealRoute,
  getTravelTimeSeconds,
  getLengthMeters,
  getCongestionComparable,
  findRecommendedIndex,
  findLeastTrafficIndex,
  findShortestIndex,
};
