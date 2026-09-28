const { predictCongestion } = require("../providers/predictionProvider");
const { computeRouteHealthScore } = require("./routeHealth");
const { estimateFuel } = require("./fuelEstimate");
const { fetchRoutes } = require("./tomtomRouting");

const DEFAULT_SLOTS = [0, 15, 30, 45, 60];

function midPoint(startLat, startLng, endLat, endLng) {
  return {
    lat: (startLat + endLat) / 2,
    lng: (startLng + endLng) / 2,
  };
}

function enrichRoute(route, prediction, incidentCount = 0) {
  const distanceKm = parseFloat(route.distance) || 0;
  const routeHealthScore = computeRouteHealthScore(
    route,
    prediction,
    incidentCount
  );
  const fuelEstimate = estimateFuel(distanceKm);

  return {
    id: route.id,
    label: route.label,
    color: route.color,
    isRecommended: Boolean(route.isRecommended),
    coordinates: route.coordinates || route.route || [],
    travelTimeMinutes: route.travelTime,
    distanceKm: Math.round(distanceKm * 10) / 10,
    trafficLevel: route.trafficLevel,
    trafficDelayMinutes: route.trafficDelay || 0,
    routeHealthScore,
    fuelEstimate,
    source: route.source || "tomtom",
    lengthInMeters: route.lengthInMeters,
    travelTimeInSeconds: route.travelTimeInSeconds,
  };
}

/**
 * Congestion 0–1 for a departure slot from TomTom travel delay + prediction.
 * TomTom delay ratio is the primary (route-accurate) signal.
 */
function congestionForSlot(route, prediction) {
  const travelMin = Math.max(1, Number(route.travelTime) || 1);
  const delayMin = Math.max(0, Number(route.trafficDelay) || 0);
  const freeFlowMin = Math.max(1, travelMin - delayMin);

  // How much slower than free-flow (capped)
  const etaInflation = Math.min(1, Math.max(0, (travelMin - freeFlowMin) / freeFlowMin));
  const delayRatio = Math.min(1, delayMin / travelMin);

  const levelBoost =
    route.trafficLevel === "high"
      ? 0.2
      : route.trafficLevel === "medium"
      ? 0.1
      : 0;

  const tomtomScore = Math.min(1, etaInflation * 0.55 + delayRatio * 0.35 + levelBoost);

  const predictionScore =
    typeof prediction?.congestionScore === "number"
      ? prediction.congestionScore
      : 0.5;

  // Prefer live/route ETA signal; prediction fills gaps when delay fields are thin
  const blended = tomtomScore * 0.7 + predictionScore * 0.3;
  return Math.round(Math.min(1, Math.max(0.05, blended)) * 100) / 100;
}

function levelFromCongestion(score) {
  if (score >= 0.68) return "high";
  if (score >= 0.36) return "medium";
  return "low";
}

function buildRecommendation(departureComparison, prediction) {
  if (!departureComparison.length) {
    return {
      action: "leave_now",
      waitMinutes: 0,
      reason: "No departure alternatives available. Leave when ready.",
      estimatedTimeSavedMinutes: 0,
    };
  }

  const nowSlot = departureComparison[0];
  const bestSlot = departureComparison.reduce((best, slot) =>
    slot.etaMinutes < best.etaMinutes ? slot : best
  );

  const saved = Math.max(0, nowSlot.etaMinutes - bestSlot.etaMinutes);

  if (bestSlot.offsetMinutes > 0 && saved >= 5) {
    return {
      action: "wait",
      waitMinutes: bestSlot.offsetMinutes,
      reason: `Waiting ${bestSlot.offsetMinutes} minutes may reduce travel time by about ${saved} minutes based on predicted conditions.`,
      estimatedTimeSavedMinutes: saved,
    };
  }

  if (prediction.level === "high" && saved < 5) {
    return {
      action: "leave_now",
      waitMinutes: 0,
      reason:
        "Congestion is high now and nearby departure windows look similar — leaving now is reasonable.",
      estimatedTimeSavedMinutes: 0,
    };
  }

  return {
    action: "leave_now",
    waitMinutes: 0,
    reason: "Current departure offers the best or near-best travel time.",
    estimatedTimeSavedMinutes: 0,
  };
}

/**
 * Full pre-trip decision: routes now, departure comparison, prediction, fuel.
 */
async function buildTripDecision({
  startLat,
  startLng,
  endLat,
  endLng,
  departureSlotsMinutes,
}) {
  const slots =
    Array.isArray(departureSlotsMinutes) && departureSlotsMinutes.length
      ? departureSlotsMinutes
          .map(Number)
          .filter((n) => Number.isFinite(n) && n >= 0)
      : DEFAULT_SLOTS;

  const uniqueSlots = [...new Set(slots)].sort((a, b) => a - b);
  const corridor = midPoint(startLat, startLng, endLat, endLng);

  const nowPrediction = await predictCongestion({
    lat: corridor.lat,
    lng: corridor.lng,
    when: new Date(),
  });

  const nowRoutesRaw = await fetchRoutes(
    startLat,
    startLng,
    endLat,
    endLng,
    null
  );
  const routes = nowRoutesRaw.map((r) => enrichRoute(r, nowPrediction));

  const departureComparison = [];
  for (const offset of uniqueSlots) {
    const departAt =
      offset === 0
        ? null
        : new Date(Date.now() + offset * 60 * 1000).toISOString();

    const slotRoutes =
      offset === 0
        ? nowRoutesRaw
        : await fetchRoutes(startLat, startLng, endLat, endLng, departAt);

    const best = slotRoutes.reduce((a, b) =>
      a.travelTime <= b.travelTime ? a : b
    );

    const slotPrediction = await predictCongestion({
      lat: corridor.lat,
      lng: corridor.lng,
      when: new Date(Date.now() + offset * 60_000),
    });

    const congestionScore = congestionForSlot(best, slotPrediction);
    const health = computeRouteHealthScore(best, slotPrediction);

    departureComparison.push({
      offsetMinutes: offset,
      departAt: new Date(Date.now() + offset * 60_000).toISOString(),
      etaMinutes: best.travelTime,
      trafficDelayMinutes: best.trafficDelay || 0,
      routeHealthScore: health,
      trafficLevel: best.trafficLevel,
      congestionScore,
      level: levelFromCongestion(congestionScore),
    });
  }

  // Trends graph uses the same TomTom-backed slot metrics (not a separate mock-only series)
  const bestEta = Math.min(
    ...departureComparison.map((s) => s.etaMinutes),
    Infinity
  );
  const bestOffset = departureComparison.find(
    (s) => s.etaMinutes === bestEta
  )?.offsetMinutes;

  const trends = departureComparison.map((slot) => ({
    offsetMinutes: slot.offsetMinutes,
    congestionScore: slot.congestionScore,
    level: slot.level,
    etaMinutes: slot.etaMinutes,
    trafficDelayMinutes: slot.trafficDelayMinutes,
    predictionScore: Math.round(slot.congestionScore * 100),
    isBestDeparture: slot.offsetMinutes === bestOffset,
  }));

  const recommendation = buildRecommendation(
    departureComparison,
    nowPrediction
  );

  return {
    recommendation,
    routes,
    recommendedIndex: Math.max(
      0,
      routes.findIndex((r) => r.isRecommended)
    ),
    departureComparison,
    trends,
    prediction: {
      source: nowPrediction.source,
      disclaimer: nowPrediction.disclaimer,
      level: nowPrediction.level,
      predictionScore: nowPrediction.predictionScore,
      confidence: nowPrediction.confidence,
      confidenceLabel: nowPrediction.confidenceLabel,
    },
  };
}

module.exports = { buildTripDecision, DEFAULT_SLOTS, congestionForSlot };
