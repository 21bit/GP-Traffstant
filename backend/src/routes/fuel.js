const express = require("express");
const { buildFuelEstimate, getFuelGrades } = require("../services/fuelEstimate");

const router = express.Router();

router.get("/fuel-prices", (_req, res) => {
  res.json(getFuelGrades());
});

router.post("/fuel-estimate", async (req, res) => {
  try {
    const result = await buildFuelEstimate(req.body || {});
    return res.json(result);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error("[fuel-estimate]", err);
    return res.status(status).json({
      error: err.message || "Fuel estimate failed.",
      code: err.code || "FUEL_ESTIMATE_FAILED",
    });
  }
});

module.exports = router;
