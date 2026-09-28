const express = require("express");
const { buildTripDecision } = require("../services/decisionService");
const { predictCongestion } = require("../providers/predictionProvider");

const router = express.Router();

router.post("/trip-decision", async (req, res) => {
  try {
    const { startLat, startLng, endLat, endLng, departureSlotsMinutes } =
      req.body || {};

    const coords = [startLat, startLng, endLat, endLng].map(Number);
    if (coords.some(Number.isNaN)) {
      return res.status(400).json({
        error: "startLat, startLng, endLat, endLng must be valid numbers",
      });
    }

    const [fromLat, fromLng, toLat, toLng] = coords;
    const decision = await buildTripDecision({
      startLat: fromLat,
      startLng: fromLng,
      endLat: toLat,
      endLng: toLng,
      departureSlotsMinutes,
    });

    return res.json(decision);
  } catch (err) {
    console.error("[trip-decision]", err);
    return res.status(500).json({ error: "Failed to build trip decision." });
  }
});

router.get("/traffic-prediction", async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    return res.status(400).json({ error: "lat and lng are required numbers" });
  }

  const prediction = await predictCongestion({ lat, lng, when: new Date() });
  return res.json({
    predictedTrafficLevel: prediction.level,
    predictionScore: prediction.predictionScore,
    confidence: prediction.confidenceLabel,
    predictedTraffic: prediction.level,
    source: prediction.source,
    disclaimer: prediction.disclaimer,
  });
});

module.exports = router;
