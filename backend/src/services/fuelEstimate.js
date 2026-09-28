function getFuelDefaults() {
  return {
    litersPer100Km: Number(process.env.FUEL_LITERS_PER_100KM) || 9.5,
    priceSar: Number(process.env.FUEL_PRICE_SAR) || 2.18,
  };
}

/**
 * @param {number} distanceKm
 * @returns {{ liters: number, costSar: number, litersPer100Km: number, priceSar: number }}
 */
function estimateFuel(distanceKm) {
  const { litersPer100Km, priceSar } = getFuelDefaults();
  const distance = Math.max(0, Number(distanceKm) || 0);
  const liters = Math.round(((distance * litersPer100Km) / 100) * 100) / 100;
  const costSar = Math.round(liters * priceSar * 100) / 100;
  return { liters, costSar, litersPer100Km, priceSar };
}

module.exports = { estimateFuel, getFuelDefaults };
