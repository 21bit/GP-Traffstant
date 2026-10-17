/** Popular passenger vehicles in Saudi Arabia. Extend this list in place. */
export const OTHER_VEHICLE = "__other__";

export const VEHICLE_CATALOG = [
  {
    manufacturer: "Toyota",
    models: ["Corolla", "Camry", "Yaris", "Hilux", "Land Cruiser"],
  },
  {
    manufacturer: "Hyundai",
    models: ["Accent", "Elantra", "Sonata", "Tucson"],
  },
  {
    manufacturer: "Chevrolet",
    models: ["Tahoe", "Captiva", "Malibu"],
  },
  {
    manufacturer: "Nissan",
    models: ["Sunny", "Altima", "Patrol"],
  },
  {
    manufacturer: "Kia",
    models: ["Pegas", "K5", "Sportage"],
  },
];

export function modelYears() {
  const latest = new Date().getFullYear() + 1;
  const years = [];
  for (let year = latest; year >= 2005; year -= 1) years.push(year);
  return years;
}
