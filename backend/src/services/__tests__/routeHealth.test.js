const { computeRouteHealthScore } = require("../routeHealth");

describe("computeRouteHealthScore", () => {
  test("returns 100-ish for a perfect route with no delay, low traffic, no prediction, no incidents", () => {
    const route = {
      travelTimeInSeconds: 600,
      trafficDelay: 0,
      trafficLevel: "low",
    };
    const score = computeRouteHealthScore(route, {}, 0);
    expect(score).toBe(100);
  });

  test("penalizes traffic delay proportionally to travel time", () => {
    const noDelay = computeRouteHealthScore(
      { travelTimeInSeconds: 600, trafficDelay: 0, trafficLevel: "low" },
      {},
      0
    );
    const withDelay = computeRouteHealthScore(
      { travelTimeInSeconds: 600, trafficDelay: 5, trafficLevel: "low" },
      {},
      0
    );
    expect(withDelay).toBeLessThan(noDelay);
  });

  test("caps the delay-ratio penalty at 40 points", () => {
    // trafficDelay (5 min = 300s) >> travelTimeInSeconds (100s), ratio way above 40%
    const score = computeRouteHealthScore(
      { travelTimeInSeconds: 100, trafficDelay: 5, trafficLevel: "low" },
      {},
      0
    );
    // 100 - 40 (capped delay) - 0 (low) - 0 (no prediction) - 0 (no incidents), clamped to >= 5
    expect(score).toBe(60);
  });

  test("applies a bigger penalty for high traffic level than medium", () => {
    const base = { travelTimeInSeconds: 600, trafficDelay: 0 };
    const high = computeRouteHealthScore({ ...base, trafficLevel: "high" });
    const medium = computeRouteHealthScore({ ...base, trafficLevel: "medium" });
    const low = computeRouteHealthScore({ ...base, trafficLevel: "low" });
    expect(high).toBeLessThan(medium);
    expect(medium).toBeLessThan(low);
  });

  test("uses prediction.predictionScore when it is a finite number", () => {
    const base = { travelTimeInSeconds: 600, trafficDelay: 0, trafficLevel: "low" };
    const withPrediction = computeRouteHealthScore(base, { predictionScore: 100 });
    // 100 - 0 - 0 - 20 (capped prediction penalty) - 0 = 80
    expect(withPrediction).toBe(80);
  });

  test("falls back to prediction.level when predictionScore is not a number", () => {
    const base = { travelTimeInSeconds: 600, trafficDelay: 0, trafficLevel: "low" };
    const high = computeRouteHealthScore(base, { level: "high" });
    const medium = computeRouteHealthScore(base, { level: "medium" });
    const none = computeRouteHealthScore(base, {});
    expect(high).toBe(82); // 100 - 18
    expect(medium).toBe(91); // 100 - 9
    expect(none).toBe(100);
  });

  test("penalizes 4 points per incident, capped at 16", () => {
    const base = { travelTimeInSeconds: 600, trafficDelay: 0, trafficLevel: "low" };
    expect(computeRouteHealthScore(base, {}, 2)).toBe(92); // -8
    expect(computeRouteHealthScore(base, {}, 10)).toBe(84); // capped at -16
  });

  test("never returns a score below 5, even in a worst-case scenario", () => {
    const worst = {
      travelTimeInSeconds: 60,
      trafficDelay: 100,
      trafficLevel: "high",
    };
    const score = computeRouteHealthScore(worst, { predictionScore: 100 }, 20);
    expect(score).toBeGreaterThanOrEqual(5);
  });

  test("never returns a score above 100", () => {
    const score = computeRouteHealthScore(
      { travelTimeInSeconds: 600, trafficDelay: -50, trafficLevel: "low" },
      {},
      0
    );
    expect(score).toBeLessThanOrEqual(100);
  });
});
