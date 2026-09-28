/**
 * External AI traffic prediction provider.
 * Calls PREDICTION_API_URL when configured; falls back to mock on failure.
 */
const axios = require("axios");
const mock = require("./mockPredictionProvider");

/**
 * Expected upstream shape (any extra fields are ignored):
 * { level, predictionScore, confidence, congestionScore? }
 */
async function predictCongestion({ lat, lng, when } = {}) {
  const apiUrl = process.env.PREDICTION_API_URL;
  if (!apiUrl) {
    const fallback = await mock.predictCongestion({ lat, lng, when });
    return {
      ...fallback,
      source: "mock",
      disclaimer:
        "PREDICTION_API_URL is not set — using mock prediction provider.",
    };
  }

  try {
    const whenIso = when ? new Date(when).toISOString() : new Date().toISOString();
    const response = await axios.get(apiUrl, {
      params: { lat, lng, when: whenIso },
      timeout: 8000,
    });

    const data = response.data || {};
    const predictionScore = Number(data.predictionScore ?? data.score ?? 50);
    const confidence = Number(data.confidence ?? 0.7);
    const level =
      data.level ||
      data.predictedTrafficLevel ||
      (predictionScore >= 68
        ? "high"
        : predictionScore >= 36
        ? "medium"
        : "low");

    return {
      source: "external",
      disclaimer: null,
      level,
      predictedTrafficLevel: level,
      predictionScore: Math.min(100, Math.max(0, Math.round(predictionScore))),
      congestionScore:
        typeof data.congestionScore === "number"
          ? data.congestionScore
          : predictionScore / 100,
      confidence: Math.min(1, Math.max(0, confidence)),
      confidenceLabel: `${Math.round(
        Math.min(1, Math.max(0, confidence)) * 100
      )}%`,
      when: whenIso,
    };
  } catch (err) {
    console.warn(
      "[prediction] External provider failed, falling back to mock:",
      err.message
    );
    const fallback = await mock.predictCongestion({ lat, lng, when });
    return {
      ...fallback,
      disclaimer: `External prediction unavailable (${err.message}). Showing mock prediction.`,
    };
  }
}

module.exports = { predictCongestion };
