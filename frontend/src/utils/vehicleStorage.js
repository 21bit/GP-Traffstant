const STORAGE_KEY = "traffstant_vehicles";
const SELECTED_KEY = "traffstant_selected_vehicle";

function createLocalId() {
  return `local_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export function readLocalVehicles() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (_err) {
    return [];
  }
}

export function writeLocalVehicles(vehicles) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(vehicles));
}

export function readSelectedVehicleId() {
  return localStorage.getItem(SELECTED_KEY) || null;
}

export function writeSelectedVehicleId(id) {
  if (id == null) localStorage.removeItem(SELECTED_KEY);
  else localStorage.setItem(SELECTED_KEY, String(id));
}

export function vehicleDisplayName(vehicle) {
  if (!vehicle) return "";
  const year = vehicle.year ? ` ${vehicle.year}` : "";
  const name = [vehicle.manufacturer, vehicle.model].filter(Boolean).join(" ");
  if (name) return `${name}${year}`.trim();
  if (vehicle.engineDisplacementL) return `${vehicle.engineDisplacementL}L`;
  if (vehicle.modifications) return vehicle.modifications.slice(0, 40);
  return vehicle.modified ? "مركبة معدّلة" : "مركبة";
}

export function toEstimatePayload(vehicle) {
  if (!vehicle) return null;
  return {
    modified: Boolean(vehicle.modified),
    manufacturer: vehicle.manufacturer || "",
    model: vehicle.model || "",
    year: vehicle.year || null,
    engineDisplacementL: vehicle.engineDisplacementL ?? null,
    fuelType: vehicle.fuelType || "gasoline",
    transmission: vehicle.transmission || "",
    forcedInduction: vehicle.forcedInduction || "unknown",
    modifications: vehicle.modifications || "",
  };
}

export function upsertLocalVehicle(vehicles, payload, editingId = null) {
  const list = [...vehicles];
  if (editingId) {
    const idx = list.findIndex((v) => String(v.id) === String(editingId));
    if (idx >= 0) {
      const next = {
        ...list[idx],
        ...payload,
        id: list[idx].id,
        updatedAt: new Date().toISOString(),
      };
      if (payload.isDefault) {
        list.forEach((v, i) => {
          if (i !== idx) v.isDefault = false;
        });
      }
      list[idx] = next;
      return { vehicles: list, vehicle: next };
    }
  }

  const vehicle = {
    id: createLocalId(),
    ...payload,
    isDefault: payload.isDefault || list.length === 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (vehicle.isDefault) {
    list.forEach((v) => {
      v.isDefault = false;
    });
  }
  list.unshift(vehicle);
  return { vehicles: list, vehicle };
}

export function removeLocalVehicle(vehicles, id) {
  const remaining = vehicles.filter((v) => String(v.id) !== String(id));
  const removed = vehicles.find((v) => String(v.id) === String(id));
  if (removed?.isDefault && remaining.length > 0) {
    remaining[0] = { ...remaining[0], isDefault: true };
  }
  return remaining;
}

export function setLocalDefault(vehicles, id) {
  return vehicles.map((v) => ({
    ...v,
    isDefault: String(v.id) === String(id),
  }));
}
