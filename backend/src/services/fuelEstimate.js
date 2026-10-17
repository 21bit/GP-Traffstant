const { getFuelGrade, getFuelGrades } = require("../config/fuelPrices");
const { estimateVehicleEfficiency } = require("./vehicleEfficiency");

function round2(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Deterministic trip fuel math. The AI service never calculates this.
 * liters = distanceKm / kmPerLiter
 * costSar = liters * pricePerLiterSar
 */
function calculateTripFuel({ distanceKm, kmPerLiter, pricePerLiterSar }) {
  const distance = Number(distanceKm);
  const efficiency = Number(kmPerLiter);
  const price = Number(pricePerLiterSar);

  if (!Number.isFinite(distance) || distance <= 0) {
    const err = new Error("Route distance must be a positive number of kilometers.");
    err.status = 400;
    err.code = "INVALID_DISTANCE";
    throw err;
  }
  if (!Number.isFinite(efficiency) || efficiency <= 0) {
    const err = new Error("Fuel efficiency must be a positive number of km/L.");
    err.status = 400;
    err.code = "INVALID_EFFICIENCY";
    throw err;
  }
  if (!Number.isFinite(price) || price <= 0) {
    const err = new Error("Fuel price must be a positive number of SAR per liter.");
    err.status = 400;
    err.code = "INVALID_PRICE";
    throw err;
  }

  const liters = round2(distance / efficiency);
  const costSar = round2(liters * price);
  return {
    liters,
    costSar,
    distanceKm: round2(distance),
    kmPerLiter: efficiency,
    pricePerLiterSar: price,
  };
}

/**
 * Resolve vehicle efficiency, then calculate consumption and cost in this process.
 * Pass `kmPerLiter` to recalculate for another route without calling the AI again.
 */
async function buildFuelEstimate(body = {}, options = {}) {
  const grade = getFuelGrade(body.fuelGrade || "91");
  const distanceKm = body.distanceKm;

  let efficiency;
  if (body.kmPerLiter !== undefined && body.kmPerLiter !== null && body.kmPerLiter !== "") {
    const kmPerLiter = Number(body.kmPerLiter);
    if (!Number.isFinite(kmPerLiter) || kmPerLiter <= 0) {
      const err = new Error("Fuel efficiency must be a positive number of km/L.");
      err.status = 400;
      err.code = "INVALID_EFFICIENCY";
      throw err;
    }
    efficiency = {
      status: "ok",
      kmPerLiter,
      basis: body.basis || "approximation",
      explanation: body.explanation || "",
      confidence: body.confidence || null,
      cached: true,
    };
  } else {
    efficiency = await estimateVehicleEfficiency(body.vehicle, options);
  }

  const price = {
    grade: grade.id,
    label: grade.label,
    pricePerLiterSar: grade.pricePerLiterSar,
    source: grade.source,
    reviewedOn: grade.reviewedOn,
    currency: "SAR",
  };

  if (!efficiency.kmPerLiter) {
    return {
      status: efficiency.status || "unavailable",
      efficiency,
      fuel: null,
      price,
      estimateDisclaimer:
        "كفاءة المركبة وتكلفة الوقود تقديرات وليست استهلاكاً مضموناً على الطريق.",
    };
  }

  if (body.vehicle?.fuelType === "diesel" || body.fuelType === "diesel") {
    return {
      status: "ok",
      efficiency,
      fuel: null,
      price,
      costStatus: "unavailable",
      costReason: "diesel_price_not_configured",
      estimateDisclaimer:
        "كفاءة المركبة تقدير. أسعار 91 و95 خاصة بالبنزين، لذلك لا تُحسب تكلفة الديزل من هذه الأسعار.",
    };
  }

  const fuel = calculateTripFuel({
    distanceKm,
    kmPerLiter: efficiency.kmPerLiter,
    pricePerLiterSar: grade.pricePerLiterSar,
  });

  return {
    status: "ok",
    efficiency,
    fuel,
    price,
    costStatus: "ok",
    estimateDisclaimer:
      "كفاءة المركبة وتكلفة الوقود تقديرات مبنية على وصف المركبة والسعر المُعدّ، وليست استهلاكاً مضموناً.",
  };
}

module.exports = {
  calculateTripFuel,
  buildFuelEstimate,
  getFuelGrades,
};
