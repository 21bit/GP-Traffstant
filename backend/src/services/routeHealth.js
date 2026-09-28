/**
 * Composite Route Health Score (0–100). Higher = healthier / easier trip.
 * Factors: traffic delay ratio, traffic level, corridor prediction, incidents.
 */

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * @param {{
 *   travelTimeInSeconds?: number,
 *   trafficDelay?: number,
 *   trafficLevel?: string,
 *   lengthInMeters?: number,
 * }} route
 * @param {{ level?: string, predictionScore?: number }} prediction
 * @param {number} [incidentCount=0]
 */
function computeRouteHealthScore(route, prediction = {}, incidentCount = 0) {
  const travelSeconds = Math.max(
    1,
    Number(route.travelTimeInSeconds) ||
      (Number(route.travelTime) || 1) * 60
  );
  const delayMinutes = Number(route.trafficDelay) || 0;
  const delaySeconds = delayMinutes * 60;
  const delayRatio = delaySeconds / travelSeconds;

  // Start from 100 and subtract penalties
  let score = 100;

  // Delay ratio: up to -40
  score -= clamp(delayRatio * 100, 0, 40);

  // Traffic level: up to -25
  if (route.trafficLevel === "high") score -= 25;
  else if (route.trafficLevel === "medium") score -= 12;

  // Corridor prediction: up to -20
  const predScore = Number(prediction.predictionScore);
  if (Number.isFinite(predScore)) {
    score -= clamp((predScore / 100) * 20, 0, 20);
  } else if (prediction.level === "high") {
    score -= 18;
  } else if (prediction.level === "medium") {
    score -= 9;
  }

  // Incidents near corridor: -4 each, max -16
  score -= clamp(Number(incidentCount) * 4, 0, 16);

  return Math.round(clamp(score, 5, 100));
}

module.exports = { computeRouteHealthScore };
