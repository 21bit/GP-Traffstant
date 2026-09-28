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

function normalizeRealRoute(routeData) {
  const route = routeData.legs.flatMap((leg) =>
    leg.points.map((p) => [p.latitude, p.longitude])
  );
  const summary = routeData.summary;
  const distanceKm = (summary.lengthInMeters / 1000).toFixed(1);
  const travelTimeMin = Math.ceil(summary.travelTimeInSeconds / 60);
  const delayMin = Math.ceil((summary.trafficDelayInSeconds || 0) / 60);
  const delayRatio =
    (summary.trafficDelayInSeconds || 0) /
    Math.max(summary.travelTimeInSeconds, 1);

  let trafficLevel = "low";
  if (delayRatio > 0.3) trafficLevel = "high";
  else if (delayRatio > 0.1) trafficLevel = "medium";

  return {
    route,
    coordinates: route,
    trafficLevel,
    distance: distanceKm,
    travelTime: travelTimeMin,
    trafficDelay: delayMin,
    lengthInMeters: summary.lengthInMeters,
    travelTimeInSeconds: summary.travelTimeInSeconds,
    source: "tomtom",
  };
}

function scoreRoute(routeInfo) {
  const trafficPenalty =
    routeInfo.trafficLevel === "high"
      ? 30
      : routeInfo.trafficLevel === "medium"
      ? 10
      : 0;
  return (
    routeInfo.travelTime + trafficPenalty + routeInfo.trafficDelay * 2
  );
}

function labelAndColorRoutes(routes) {
  if (routes.length === 0) return [];

  const recommendedIdx = routes.reduce(
    (best, r, i) => (scoreRoute(r) < scoreRoute(routes[best]) ? i : best),
    0
  );

  const leastTrafficIdx = routes.reduce((best, r, i) => {
    const rank = (level) =>
      level === "high" ? 2 : level === "medium" ? 1 : 0;
    return rank(r.trafficLevel) < rank(routes[best].trafficLevel) ? i : best;
  }, 0);

  const shortestIdx = routes.reduce(
    (best, r, i) =>
      parseFloat(r.distance) < parseFloat(routes[best].distance) ? i : best,
    0
  );

  const assignedLabels = new Set();

  return routes.map((r, i) => {
    let label = "Alternative";
    let color = "#94a3b8";

    if (i === recommendedIdx && !assignedLabels.has("recommended")) {
      label = "Recommended";
      color = "#0D9488";
      assignedLabels.add("recommended");
    } else if (i === leastTrafficIdx && !assignedLabels.has("leastTraffic")) {
      label = "Least Traffic";
      color = "#22c55e";
      assignedLabels.add("leastTraffic");
    } else if (i === shortestIdx && !assignedLabels.has("shortest")) {
      label = "Shortest";
      color = "#94a3b8";
      assignedLabels.add("shortest");
    }

    return {
      ...r,
      id: `route-${i}-${label}`,
      label,
      color,
      isRecommended: i === recommendedIdx,
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
};
