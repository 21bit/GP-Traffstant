/**
 * Configured Saudi gasoline prices in SAR per liter.
 *
 * These are maintained values, not a live price feed. When Aramco publishes
 * a new monthly list, update the defaults below (or set FUEL_PRICE_91 and
 * FUEL_PRICE_95 in backend/.env) and change `reviewedOn`.
 *
 * Source: https://www.aramco.com/en/what-we-do/energy-products/retail-fuels
 * Reviewed against the October 2026 list on 2026-10-11:
 *   Gasoline 91 = 2.18 SAR/L
 *   Gasoline 95 = 2.33 SAR/L
 */

const SOURCE_URL =
  "https://www.aramco.com/en/what-we-do/energy-products/retail-fuels";
const REVIEWED_ON = "2026-10-11";

const DEFAULTS = {
  "91": 2.18,
  "95": 2.33,
};

function readOverride(envName, fallback) {
  const raw = process.env[envName];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

function getFuelGrades() {
  return {
    source: SOURCE_URL,
    reviewedOn: REVIEWED_ON,
    currency: "SAR",
    disclaimer:
      "Prices are the configured Aramco gasoline rates for this deployment. Update them when the official monthly list changes. They are not retrieved on each request.",
    grades: {
      "91": {
        id: "91",
        label: "Gasoline 91",
        pricePerLiterSar: readOverride("FUEL_PRICE_91", DEFAULTS["91"]),
      },
      "95": {
        id: "95",
        label: "Gasoline 95",
        pricePerLiterSar: readOverride("FUEL_PRICE_95", DEFAULTS["95"]),
      },
    },
  };
}

function getFuelGrade(gradeId) {
  const catalog = getFuelGrades();
  const grade = catalog.grades[String(gradeId || "")];
  if (!grade) {
    const err = new Error("Choose gasoline grade 91 or 95.");
    err.status = 400;
    err.code = "INVALID_GRADE";
    throw err;
  }
  return { ...grade, source: catalog.source, reviewedOn: catalog.reviewedOn };
}

module.exports = { getFuelGrades, getFuelGrade, SOURCE_URL, REVIEWED_ON };
