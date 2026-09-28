/**
 * Deterministic mock congestion forecast for Riyadh peak-hour patterns.
 * Minute-level curves so 15-minute departure slots are distinguishable.
 * Responses are always labeled source:"mock" — not a live AI forecast.
 */

const MOCK_DISCLAIMER =
  "Mock prediction for development — not a live AI forecast.";

/**
 * Smooth triangular peak: 0 outside [start,end], 1 at center.
 */
function peakWeight(hourDecimal, start, end) {
  if (hourDecimal < start || hourDecimal > end) return 0;
  const mid = (start + end) / 2;
  const half = (end - start) / 2;
  return Math.max(0, 1 - Math.abs(hourDecimal - mid) / half);
}

/**
 * Riyadh-style continuous congestion curve (0–100) by fractional hour.
 * Morning peak ~07:30, evening peak ~17:30, quiet overnight.
 */
function scoreForMoment(whenDate) {
  const hourDecimal =
    whenDate.getHours() +
    whenDate.getMinutes() / 60 +
    whenDate.getSeconds() / 3600;

  // 0 = Sun … 6 = Sat; Saudi weekend is Fri+Sat
  const isWeekend = whenDate.getDay() === 5 || whenDate.getDay() === 6;

  const morning = peakWeight(hourDecimal, 6.0, 9.5);
  const midday = peakWeight(hourDecimal, 11.5, 13.5) * 0.35;
  const evening = peakWeight(hourDecimal, 15.0, 20.5);
  const lateNight =
    hourDecimal >= 22 || hourDecimal <= 5
      ? 0.08
      : peakWeight(hourDecimal, 21.5, 23.5) * 0.15;

  const peak = Math.max(morning, evening, midday, lateNight);
  // Base free-flow floor + peak contribution
  let baseScore = 12 + peak * 78;

  // Mild midday baseline traffic in the city
  if (hourDecimal >= 9.5 && hourDecimal <= 15 && peak < 0.2) {
    baseScore = Math.max(baseScore, 38);
  }

  let confidence = 0.62 + peak * 0.28;

  if (isWeekend) {
    // Weekend: weaker morning commute, stronger evening leisure
    baseScore = baseScore * 0.72 + evening * 12;
    confidence = Math.min(confidence + 0.04, 0.95);
  }

  return {
    baseScore: Math.min(100, Math.max(5, baseScore)),
    confidence: Math.min(0.95, Math.max(0.55, confidence)),
  };
}

function levelFromScore(predictionScore) {
  if (predictionScore >= 68) return "high";
  if (predictionScore >= 36) return "medium";
  return "low";
}

/**
 * @param {{ lat: number, lng: number, when?: Date|string|number }} input
 */
async function predictCongestion({ lat, lng, when } = {}) {
  const whenDate = when ? new Date(when) : new Date();
  const safeDate = Number.isNaN(whenDate.getTime()) ? new Date() : whenDate;

  const { baseScore, confidence } = scoreForMoment(safeDate);

  // Small stable location variance (not random)
  const locationVariance =
    ((Math.abs(Number(lat) || 0) * 1000 + Math.abs(Number(lng) || 0) * 1000) %
      9) -
    4;

  // Tiny minute jitter so adjacent slots never look identical when hours match
  const minuteNudge = (safeDate.getMinutes() % 15) * 0.15;

  const predictionScore = Math.min(
    100,
    Math.max(5, Math.round(baseScore + locationVariance + minuteNudge))
  );
  const level = levelFromScore(predictionScore);

  return {
    source: "mock",
    disclaimer: MOCK_DISCLAIMER,
    level,
    predictedTrafficLevel: level,
    predictionScore,
    congestionScore: predictionScore / 100,
    confidence,
    confidenceLabel: `${Math.round(confidence * 100)}%`,
    when: safeDate.toISOString(),
  };
}

module.exports = {
  predictCongestion,
  MOCK_DISCLAIMER,
  scoreForMoment,
};
