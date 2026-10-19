const {
  haversineDistanceKm,
  labelAndColorRoutes,
  computeDensity,
} = require("../tomtomRouting");

describe("haversineDistanceKm", () => {
  test("returns 0 for identical coordinates", () => {
    expect(haversineDistanceKm(24.7136, 46.6753, 24.7136, 46.6753)).toBe(0);
  });

  test("computes the known distance between Riyadh and Jeddah (~ 850km, +-30km)", () => {
    const riyadh = [24.7136, 46.6753];
    const jeddah = [21.4858, 39.1925];
    const distance = haversineDistanceKm(...riyadh, ...jeddah);
    expect(distance).toBeGreaterThan(820);
    expect(distance).toBeLessThan(880);
  });

  test("distance is symmetric (A to B equals B to A)", () => {
    const d1 = haversineDistanceKm(24.7, 46.6, 25.0, 47.0);
    const d2 = haversineDistanceKm(25.0, 47.0, 24.7, 46.6);
    expect(d1).toBeCloseTo(d2, 10);
  });
});

describe("computeDensity", () => {
  test("returns 'unknown' when freeFlowSpeed is 0, missing, or negative", () => {
    expect(computeDensity(50, 0)).toBe("unknown");
    expect(computeDensity(50, undefined)).toBe("unknown");
    expect(computeDensity(50, -10)).toBe("unknown");
  });

  test("returns 'high' when current speed is well below free-flow (ratio < 0.4)", () => {
    expect(computeDensity(20, 100)).toBe("high");
  });

  test("returns 'medium' when current speed is moderately below free-flow (0.4 <= ratio < 0.7)", () => {
    expect(computeDensity(50, 100)).toBe("medium");
  });

  test("returns 'low' when current speed is close to free-flow (ratio >= 0.7)", () => {
    expect(computeDensity(90, 100)).toBe("low");
  });

  test("boundary: ratio exactly 0.7 counts as 'low', not 'medium'", () => {
    expect(computeDensity(70, 100)).toBe("low");
  });
});

describe("labelAndColorRoutes", () => {
  test("returns an empty array when given no routes", () => {
    expect(labelAndColorRoutes([])).toEqual([]);
  });

  test("labels the fastest/least-penalized route as Recommended", () => {
    const routes = [
      { travelTime: 30, trafficDelay: 5, trafficLevel: "medium", distance: "10.0" },
      { travelTime: 20, trafficDelay: 0, trafficLevel: "low", distance: "12.0" },
      { travelTime: 40, trafficDelay: 10, trafficLevel: "high", distance: "9.0" },
    ];
    const labeled = labelAndColorRoutes(routes);
    const recommended = labeled.find((r) => r.label === "Recommended");
    expect(recommended.isRecommended).toBe(true);
    expect(recommended.travelTime).toBe(20);
  });

  test("labels the shortest-distance route as Shortest when it isn't already Recommended/Least Traffic", () => {
    const routes = [
      { travelTime: 20, trafficDelay: 0, trafficLevel: "low", distance: "12.0" },
      { travelTime: 25, trafficDelay: 2, trafficLevel: "medium", distance: "5.0" },
    ];
    const labeled = labelAndColorRoutes(routes);
    const shortest = labeled.find((r) => r.distance === "5.0");
    expect(shortest.label).toBe("Shortest");
  });

  test("falls back to 'Alternative' once Recommended/Least Traffic/Shortest are already assigned", () => {
    const routes = [
      { travelTime: 20, trafficDelay: 0, trafficLevel: "low", distance: "5.0" }, // wins all 3 categories
      { travelTime: 30, trafficDelay: 5, trafficLevel: "medium", distance: "8.0" },
      { travelTime: 40, trafficDelay: 10, trafficLevel: "high", distance: "9.0" },
    ];
    const labeled = labelAndColorRoutes(routes);
    expect(labeled[0].label).toBe("Recommended");
    expect(labeled[1].label).toBe("Alternative");
    expect(labeled[2].label).toBe("Alternative");
  });

  test("colors the most congested route red, the middle yellow, and the fastest clear route green", () => {
    const routes = [
      { travelTime: 30, trafficDelay: 5, trafficLevel: "medium", distance: "10.0" },
      { travelTime: 20, trafficDelay: 0, trafficLevel: "low", distance: "12.0" },
      { travelTime: 40, trafficDelay: 10, trafficLevel: "high", distance: "9.0" },
    ];
    const labeled = labelAndColorRoutes(routes);
    expect(labeled[1].color).toBe("#22C55E");
    expect(labeled[0].color).toBe("#F59E0B");
    expect(labeled[2].color).toBe("#EF4444");
  });

  test("gives every route a unique id derived from its index and label", () => {
    const routes = [
      { travelTime: 20, trafficDelay: 0, trafficLevel: "low", distance: "5.0" },
      { travelTime: 30, trafficDelay: 5, trafficLevel: "medium", distance: "8.0" },
    ];
    const labeled = labelAndColorRoutes(routes);
    const ids = labeled.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
