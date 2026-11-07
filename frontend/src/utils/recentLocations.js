const MAX_RECENT = 5;

function placeKey(place) {
  return `${Number(place.lat).toFixed(5)},${Number(place.lng).toFixed(5)}`;
}

/**
 * Keep the last five distinct places, newest first.
 */
export function pushRecentLocation(list, place) {
  if (!place || !Number.isFinite(Number(place.lat)) || !Number.isFinite(Number(place.lng))) {
    return list || [];
  }
  const next = {
    name: place.name || "",
    lat: Number(place.lat),
    lng: Number(place.lng),
    neighborhood: place.neighborhood || "",
  };
  const key = placeKey(next);
  const filtered = (list || []).filter((item) => placeKey(item) !== key);
  return [next, ...filtered].slice(0, MAX_RECENT);
}

/**
 * Seed recent locations from trip history (origin + destination), newest first.
 */
export function recentFromTrips(trips) {
  const seeded = [];
  for (const trip of trips || []) {
    if (trip.originName && Number.isFinite(trip.startLat) && Number.isFinite(trip.startLng)) {
      seeded.push({
        name: trip.originName,
        lat: trip.startLat,
        lng: trip.startLng,
      });
    }
    if (trip.destName && Number.isFinite(trip.endLat) && Number.isFinite(trip.endLng)) {
      seeded.push({
        name: trip.destName,
        lat: trip.endLat,
        lng: trip.endLng,
      });
    }
  }
  let result = [];
  for (const place of seeded) {
    result = pushRecentLocation(result, place);
  }
  return result;
}
