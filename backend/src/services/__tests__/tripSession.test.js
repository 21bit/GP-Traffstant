const { canStartTrip, startTrip, finishTrip } = require("../tripSession");

const route = {
  originName: "العليا",
  destName: "المطار",
  startLat: 24.71,
  startLng: 46.67,
  endLat: 24.95,
  endLng: 46.7,
  chosenRouteLabel: "Fastest Route",
  distanceKm: 32.4,
};

describe("trip session", () => {
  test("starts a valid route and records the start timestamp", () => {
    const now = new Date("2026-10-17T12:00:00.000Z");
    const result = startTrip(null, route, now);
    expect(result.ok).toBe(true);
    expect(result.session.status).toBe("active");
    expect(result.session.distanceKm).toBe(32.4);
    expect(result.session.startedAt).toBe(now.toISOString());
    expect(result.session.originName).toBe("العليا");
  });

  test("rejects a missing route, a non-positive distance, and a second start", () => {
    expect(canStartTrip(null, null).code).toBe("invalid_route");
    expect(canStartTrip(null, { ...route, distanceKm: 0 }).code).toBe("invalid_route");
    expect(
      canStartTrip(null, { ...route, startLat: "north" }).code
    ).toBe("invalid_route");

    const started = startTrip(null, route);
    const again = startTrip(started.session, route);
    expect(again.ok).toBe(false);
    expect(again.code).toBe("already_active");
    expect(again.session.status).toBe("active");
  });

  test("ends an active trip and can cancel it", () => {
    const started = startTrip(null, route);
    const ended = finishTrip(started.session, "completed", new Date("2026-10-17T13:00:00.000Z"));
    expect(ended.ok).toBe(true);
    expect(ended.session.status).toBe("completed");
    expect(ended.session.endedAt).toBe("2026-10-17T13:00:00.000Z");

    const cancelled = finishTrip(started.session, "cancelled");
    expect(cancelled.session.status).toBe("cancelled");
  });

  test("does not finish a trip that is not active", () => {
    expect(finishTrip(null, "completed").code).toBe("not_active");
    const started = startTrip(null, route);
    const ended = finishTrip(started.session, "completed");
    expect(finishTrip(ended.session, "cancelled").code).toBe("not_active");
    expect(finishTrip(started.session, "saved").code).toBe("invalid_outcome");
  });
});
