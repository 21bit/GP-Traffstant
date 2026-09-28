/**
 * Prediction provider facade.
 * PREDICTION_PROVIDER=mock|external (default: mock)
 */
const mock = require("./mockPredictionProvider");
const external = require("./externalPredictionProvider");

function getProviderName() {
  const raw = (process.env.PREDICTION_PROVIDER || "mock").toLowerCase().trim();
  return raw === "external" ? "external" : "mock";
}

async function predictCongestion(input) {
  const name = getProviderName();
  if (name === "external") {
    return external.predictCongestion(input);
  }
  return mock.predictCongestion(input);
}

module.exports = {
  predictCongestion,
  getProviderName,
};
