function hasEndpoints(route) {
  if (!route) return false;
  return [route.startLat, route.startLng, route.endLat, route.endLng]
    .map(Number)
    .every((n) => Number.isFinite(n));
}

export function canStartTrip(session, route) {
  if (session && session.status === "active") {
    return { ok: false, code: "already_active" };
  }
  const distance = Number(route && route.distanceKm);
  if (!route || !(distance > 0) || !hasEndpoints(route)) {
    return { ok: false, code: "invalid_route" };
  }
  return { ok: true };
}

export function startTrip(session, route, now = new Date()) {
  const check = canStartTrip(session, route);
  if (!check.ok) return { ok: false, code: check.code, session: session || null };
  return {
    ok: true,
    session: {
      status: "active",
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
      fuelLiters: route.fuelLiters ?? null,
      fuelCostSar: route.fuelCostSar ?? null,
      startedAt: now.toISOString(),
      endedAt: null,
      id: null,
      persisted: false,
    },
  };
}

export function finishTrip(session, outcome, now = new Date()) {
  if (!session || session.status !== "active") {
    return { ok: false, code: "not_active", session: session || null };
  }
  if (outcome !== "completed" && outcome !== "cancelled") {
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
