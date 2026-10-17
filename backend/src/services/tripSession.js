const ACTIVE = "active";
const COMPLETED = "completed";
const CANCELLED = "cancelled";

function hasEndpoints(route) {
  if (!route) return false;
  const values = [route.startLat, route.startLng, route.endLat, route.endLng].map(Number);
  return values.every((n) => Number.isFinite(n));
}

function canStartTrip(session, route) {
  if (session && session.status === ACTIVE) {
    return { ok: false, code: "already_active" };
  }
  const distance = Number(route && route.distanceKm);
  if (!route || !Number.isFinite(distance) || distance <= 0 || !hasEndpoints(route)) {
    return { ok: false, code: "invalid_route" };
  }
  return { ok: true };
}

function startTrip(session, route, now = new Date()) {
  const check = canStartTrip(session, route);
  if (!check.ok) return { ok: false, code: check.code, session: session || null };
  return {
    ok: true,
    session: {
      status: ACTIVE,
      originName: route.originName || null,
      destName: route.destName || null,
      startLat: Number(route.startLat),
      startLng: Number(route.startLng),
      endLat: Number(route.endLat),
      endLng: Number(route.endLng),
      chosenRouteLabel: route.chosenRouteLabel || null,
      distanceKm: Number(route.distanceKm),
      travelTimeMinutes: route.travelTimeMinutes ?? null,
      routeHealthScore: route.routeHealthScore ?? null,
      startedAt: now.toISOString(),
      endedAt: null,
    },
  };
}

function finishTrip(session, outcome, now = new Date()) {
  if (!session || session.status !== ACTIVE) {
    return { ok: false, code: "not_active", session: session || null };
  }
  if (outcome !== COMPLETED && outcome !== CANCELLED) {
    return { ok: false, code: "invalid_outcome", session };
  }
  return {
    ok: true,
    session: {
      ...session,
      status: outcome,
      endedAt: now.toISOString(),
    },
  };
}

module.exports = {
  canStartTrip,
  startTrip,
  finishTrip,
  ACTIVE,
  COMPLETED,
  CANCELLED,
};
