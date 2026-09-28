const { congestionForSlot } = require("../decisionService");

describe("congestionForSlot", () => {
  test("returns a low-ish score for a route with no delay and a low prediction", () => {
    const route = { travelTime: 20, trafficDelay: 0, trafficLevel: "low" };
    const prediction = { congestionScore: 0.1 };
    const score = congestionForSlot(route, prediction);
    expect(score).toBeLessThan(0.36); // below decisionService's own "medium" threshold
  });

  test("returns a high score when delay is a large share of travel time", () => {
    const route = { travelTime: 30, trafficDelay: 20, trafficLevel: "high" };
    const prediction = { congestionScore: 0.9 };
    const score = congestionForSlot(route, prediction);
    expect(score).toBeGreaterThanOrEqual(0.68);
  });

  test("never returns a value below 0.05, even for an empty/perfect route", () => {
    const route = { travelTime: 10, trafficDelay: 0, trafficLevel: "low" };
    const prediction = { congestionScore: 0 };
    const score = congestionForSlot(route, prediction);
    expect(score).toBeGreaterThanOrEqual(0.05);
  });

  test("never returns a value above 1, even with extreme inputs", () => {
    const route = { travelTime: 5, trafficDelay: 500, trafficLevel: "high" };
    const prediction = { congestionScore: 1 };
    const score = congestionForSlot(route, prediction);
    expect(score).toBeLessThanOrEqual(1);
  });

  test("defaults the prediction score to 0.5 when congestionScore is missing", () => {
    const route = { travelTime: 20, trafficDelay: 0, trafficLevel: "low" };
    const withDefault = congestionForSlot(route, {});
    const withHalf = congestionForSlot(route, { congestionScore: 0.5 });
    expect(withDefault).toBe(withHalf);
  });

  test("guards against missing/invalid numeric fields instead of throwing or returning NaN", () => {
    const route = {}; // no travelTime, no trafficDelay, no trafficLevel
    const score = congestionForSlot(route, {});
    expect(Number.isNaN(score)).toBe(false);
    expect(score).toBeGreaterThanOrEqual(0.05);
    expect(score).toBeLessThanOrEqual(1);
  });

  test("rounds the result to 2 decimal places", () => {
    const route = { travelTime: 37, trafficDelay: 13, trafficLevel: "medium" };
    const score = congestionForSlot(route, { congestionScore: 0.42 });
    expect(score).toBe(Math.round(score * 100) / 100);
  });
});
