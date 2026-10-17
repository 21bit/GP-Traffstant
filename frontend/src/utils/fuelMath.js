/**
 * Same formula as backend/src/services/fuelEstimate.js:
 * liters = distanceKm / kmPerLiter
 * cost = liters * pricePerLiter
 */
export function calculateTripFuel(distanceKm, kmPerLiter, pricePerLiterSar) {
  const distance = Number(distanceKm);
  const efficiency = Number(kmPerLiter);
  const price = Number(pricePerLiterSar);
  if (!(distance > 0) || !(efficiency > 0) || !(price > 0)) return null;
  const liters = Math.round((distance / efficiency) * 100) / 100;
  const costSar = Math.round(liters * price * 100) / 100;
  return { liters, costSar, distanceKm: distance, kmPerLiter: efficiency, pricePerLiterSar: price };
}
