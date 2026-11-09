const {
  haversineDistanceKm,
  labelAndColorRoutes,
  computeDensity,
  normalizeRealRoute,
  findRecommendedIndex,
  findLeastTrafficIndex,
  findShortestIndex,
} = require("../tomtomRouting");

/** Realistic TomTom calculateRoute route fixture (subset used by normalizeRealRoute). */
function tomtomRoute({
  lengthInMeters,
  travelTimeInSeconds,
  trafficDelayInSeconds,
  points = [
    { latitude: 24.71, longitude: 46.67 },
    { latitude: 24.8, longitude: 46.7 },
  ],
}) {
  const summary = {
    lengthInMeters,
    travelTimeInSeconds,
    ...(trafficDelayInSeconds === undefined
      ? {}
      : { trafficDelayInSeconds }),
  };
  return {
    legs: [{ points, summary }],
    summary,
  };
}

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

describe("normalizeRealRoute", () => {
  test("maps TomTom summary fields without fabricating missing delay as zero congestion level", () => {
    const normalized = normalizeRealRoute(
      tomtomRoute({
        lengthInMeters: 12000,
        travelTimeInSeconds: 1200,
        // trafficDelayInSeconds omitted
      })
    );
    expect(normalized.travelTime).toBe(20);
    expect(normalized.distance).toBe("12.0");
    expect(normalized.trafficDelay).toBeNull();
    expect(normalized.trafficDelayInSeconds).toBeNull();
    expect(normalized.trafficDataAvailable).toBe(false);
    expect(normalized.trafficLevel).toBe("unknown");
  });

  test("preserves valid zero traffic delay and derives low traffic level", () => {
    const normalized = normalizeRealRoute(
      tomtomRoute({
        lengthInMeters: 5000,
        travelTimeInSeconds: 600,
        trafficDelayInSeconds: 0,
      })
    );
    expect(normalized.trafficDelay).toBe(0);
    expect(normalized.trafficDelayInSeconds).toBe(0);
    expect(normalized.trafficDataAvailable).toBe(true);
    expect(normalized.trafficLevel).toBe("low");
  });

  test("rejects negative traffic delay as invalid", () => {
    const normalized = normalizeRealRoute(
      tomtomRoute({
        lengthInMeters: 5000,
        travelTimeInSeconds: 600,
        trafficDelayInSeconds: -30,
      })
    );
    expect(normalized.trafficDelay).toBeNull();
    expect(normalized.trafficLevel).toBe("unknown");
  });
});

describe("labelAndColorRoutes ranking", () => {
  test("returns an empty array when given no routes", () => {
    expect(labelAndColorRoutes([])).toEqual([]);
  });

  test("1. Recommended picks shorter ETA with moderate congestion over a longer clear route", () => {
    // Shorter ETA (25) with moderate delay must win Recommended.
    // Old formula would prefer the longer clear route via delay/level penalties.
    const routes = [
      {
        travelTime: 25,
        travelTimeInSeconds: 1500,
        trafficDelay: 5,
        trafficDelayInSeconds: 300,
        trafficLevel: "medium",
        distance: "10.0",
        lengthInMeters: 10000,
      },
      {
        travelTime: 28,
        travelTimeInSeconds: 1680,
        trafficDelay: 0,
        trafficDelayInSeconds: 0,
        trafficLevel: "low",
        distance: "12.0",
        lengthInMeters: 12000,
      },
    ];
    const labeled = labelAndColorRoutes(routes);
    expect(labeled[0].label).toBe("Recommended");
    expect(labeled[0].isRecommended).toBe(true);
    expect(labeled[1].label).toBe("Least Traffic");
  });

  test("2. Least Traffic picks slightly longer ETA with very low congestion", () => {
    const routes = [
      {
        travelTime: 20,
        travelTimeInSeconds: 1200,
        trafficDelay: 8,
        trafficDelayInSeconds: 480,
        trafficLevel: "high",
        distance: "9.0",
        lengthInMeters: 9000,
      },
      {
        travelTime: 22,
        travelTimeInSeconds: 1320,
        trafficDelay: 0,
        trafficDelayInSeconds: 0,
        trafficLevel: "low",
        distance: "11.0",
        lengthInMeters: 11000,
      },
    ];
    const labeled = labelAndColorRoutes(routes);
    expect(labeled[0].label).toBe("Recommended");
    expect(labeled[1].label).toBe("Least Traffic");
  });

  test("3. Shortest picks shorter-distance route even when ETA is significantly longer", () => {
    const routes = [
      {
        travelTime: 20,
        travelTimeInSeconds: 1200,
        trafficDelay: 0,
        trafficDelayInSeconds: 0,
        trafficLevel: "low",
        distance: "12.0",
        lengthInMeters: 12000,
      },
      {
        travelTime: 40,
        travelTimeInSeconds: 2400,
        trafficDelay: 2,
        trafficDelayInSeconds: 120,
        trafficLevel: "low",
        distance: "5.0",
        lengthInMeters: 5000,
      },
    ];
    const labeled = labelAndColorRoutes(routes);
    expect(labeled[0].label).toBe("Recommended");
    expect(labeled[1].label).toBe("Shortest");
    // Route 0 also has lower delay, so Least Traffic coincides with Recommended
    // and must not be duplicated onto another route.
    expect(labeled.every((r) => r.label !== "Least Traffic")).toBe(true);
  });

  test("4. Heavy congestion with large traffic delay does not double-count into Recommended", () => {
    const routes = [
      {
        travelTime: 30,
        travelTimeInSeconds: 1800,
        trafficDelay: 15,
        trafficDelayInSeconds: 900,
        trafficLevel: "high",
        distance: "8.0",
        lengthInMeters: 8000,
      },
      {
        travelTime: 35,
        travelTimeInSeconds: 2100,
        trafficDelay: 1,
        trafficDelayInSeconds: 60,
        trafficLevel: "low",
        distance: "10.0",
        lengthInMeters: 10000,
      },
    ];
    const labeled = labelAndColorRoutes(routes);
    // travelTime already includes traffic; Recommended is still the 30-min route.
    expect(labeled[0].label).toBe("Recommended");
    expect(labeled[0].travelTime).toBe(30);
    expect(labeled[1].label).toBe("Least Traffic");
  });

  test("5. Missing traffic information does not fabricate congestion or Least Traffic", () => {
    const routes = [
      {
        travelTime: 20,
        travelTimeInSeconds: 1200,
        trafficDelay: null,
        trafficDelayInSeconds: null,
        trafficLevel: "unknown",
        distance: "10.0",
        lengthInMeters: 10000,
      },
      {
        travelTime: 25,
        travelTimeInSeconds: 1500,
        trafficDelay: null,
        trafficDelayInSeconds: null,
        trafficLevel: "unknown",
        distance: "8.0",
        lengthInMeters: 8000,
      },
    ];
    const labeled = labelAndColorRoutes(routes);
    expect(labeled[0].label).toBe("Recommended");
    expect(labeled[1].label).toBe("Shortest");
    expect(labeled.every((r) => r.label !== "Least Traffic")).toBe(true);
  });

  test("6. Missing congestion-level but available traffic delay uses delay for Least Traffic", () => {
    const routes = [
      {
        travelTime: 20,
        travelTimeInSeconds: 1200,
        trafficDelay: 10,
        trafficDelayInSeconds: 600,
        // no trafficLevel
        distance: "10.0",
        lengthInMeters: 10000,
      },
      {
        travelTime: 22,
        travelTimeInSeconds: 1320,
        trafficDelay: 1,
        trafficDelayInSeconds: 60,
        distance: "11.0",
        lengthInMeters: 11000,
      },
    ];
    const labeled = labelAndColorRoutes(routes);
    expect(labeled[0].label).toBe("Recommended");
    expect(labeled[1].label).toBe("Least Traffic");
  });

  test("7. Missing traffic delay but available congestion-level uses level for Least Traffic", () => {
    const routes = [
      {
        travelTime: 20,
        travelTimeInSeconds: 1200,
        trafficLevel: "high",
        distance: "10.0",
        lengthInMeters: 10000,
      },
      {
        travelTime: 24,
        travelTimeInSeconds: 1440,
        trafficLevel: "low",
        distance: "12.0",
        lengthInMeters: 12000,
      },
    ];
    const labeled = labelAndColorRoutes(routes);
    expect(labeled[0].label).toBe("Recommended");
    expect(labeled[1].label).toBe("Least Traffic");
  });

  test("8. Identical travel times: Recommended tie-breaks by shorter distance then index", () => {
    const routes = [
      {
        travelTime: 20,
        travelTimeInSeconds: 1200,
        trafficDelay: 2,
        trafficDelayInSeconds: 120,
        trafficLevel: "low",
        distance: "12.0",
        lengthInMeters: 12000,
      },
      {
        travelTime: 20,
        travelTimeInSeconds: 1200,
        trafficDelay: 5,
        trafficDelayInSeconds: 300,
        trafficLevel: "medium",
        distance: "9.0",
        lengthInMeters: 9000,
      },
    ];
    expect(findRecommendedIndex(routes)).toBe(1);
    const labeled = labelAndColorRoutes(routes);
    expect(labeled[1].label).toBe("Recommended");
    expect(labeled[0].label).toBe("Least Traffic");
  });

  test("9. Identical congestion metrics: Least Traffic tie-breaks by lower travel time", () => {
    const routes = [
      {
        travelTime: 30,
        travelTimeInSeconds: 1800,
        trafficDelay: 5,
        trafficDelayInSeconds: 300,
        trafficLevel: "medium",
        distance: "10.0",
        lengthInMeters: 10000,
      },
      {
        travelTime: 25,
        travelTimeInSeconds: 1500,
        trafficDelay: 5,
        trafficDelayInSeconds: 300,
        trafficLevel: "medium",
        distance: "12.0",
        lengthInMeters: 12000,
      },
    ];
    expect(findLeastTrafficIndex(routes)).toBe(1);
    const labeled = labelAndColorRoutes(routes);
    // Same route wins Recommended and Least Traffic → shown once as Recommended
    expect(labeled[1].label).toBe("Recommended");
    expect(labeled.every((r) => r.label !== "Least Traffic")).toBe(true);
  });

  test("10. Identical distances: Shortest tie-breaks by lower travel time", () => {
    const routes = [
      {
        travelTime: 30,
        travelTimeInSeconds: 1800,
        trafficDelay: 8,
        trafficDelayInSeconds: 480,
        trafficLevel: "high",
        distance: "10.0",
        lengthInMeters: 10000,
      },
      {
        travelTime: 22,
        travelTimeInSeconds: 1320,
        trafficDelay: 1,
        trafficDelayInSeconds: 60,
        trafficLevel: "low",
        distance: "10.0",
        lengthInMeters: 10000,
      },
      {
        travelTime: 40,
        travelTimeInSeconds: 2400,
        trafficDelay: 0,
        trafficDelayInSeconds: 0,
        trafficLevel: "low",
        distance: "15.0",
        lengthInMeters: 15000,
      },
    ];
    expect(findShortestIndex(routes)).toBe(1);
    const labeled = labelAndColorRoutes(routes);
    expect(labeled[1].label).toBe("Recommended");
    // Shortest coincides with Recommended; Least Traffic goes to route 2
    expect(labeled[2].label).toBe("Least Traffic");
    expect(labeled.every((r) => r.label !== "Shortest")).toBe(true);
  });

  test("11. Recommended and Least Traffic selecting the same route displays it only once", () => {
    const routes = [
      {
        travelTime: 20,
        travelTimeInSeconds: 1200,
        trafficDelay: 0,
        trafficDelayInSeconds: 0,
        trafficLevel: "low",
        distance: "5.0",
        lengthInMeters: 5000,
      },
      {
        travelTime: 30,
        trafficDelay: 5,
        trafficDelayInSeconds: 300,
        trafficLevel: "medium",
        distance: "8.0",
        lengthInMeters: 8000,
      },
      {
        travelTime: 40,
        trafficDelay: 10,
        trafficDelayInSeconds: 600,
        trafficLevel: "high",
        distance: "9.0",
        lengthInMeters: 9000,
      },
    ];
    const labeled = labelAndColorRoutes(routes);
    expect(labeled[0].label).toBe("Recommended");
    expect(labeled.filter((r) => r.label === "Least Traffic")).toHaveLength(0);
    expect(labeled.filter((r) => r.label === "Shortest")).toHaveLength(0);
    expect(labeled[1].label).toBe("Alternative");
    expect(labeled[2].label).toBe("Alternative");
  });

  test("12. Shortest selecting a route already represented by another category is not duplicated", () => {
    const routes = [
      {
        travelTime: 20,
        travelTimeInSeconds: 1200,
        trafficDelay: 0,
        trafficDelayInSeconds: 0,
        trafficLevel: "low",
        distance: "5.0",
        lengthInMeters: 5000,
      },
      {
        travelTime: 25,
        travelTimeInSeconds: 1500,
        trafficDelay: 2,
        trafficDelayInSeconds: 120,
        trafficLevel: "medium",
        distance: "8.0",
        lengthInMeters: 8000,
      },
    ];
    const labeled = labelAndColorRoutes(routes);
    expect(labeled[0].label).toBe("Recommended");
    expect(labeled[1].label).toBe("Alternative");
    expect(labeled.every((r) => r.label !== "Shortest")).toBe(true);
  });

  test("13. Empty route response", () => {
    expect(labelAndColorRoutes([])).toEqual([]);
    expect(findRecommendedIndex([])).toBe(-1);
    expect(findLeastTrafficIndex([])).toBe(-1);
    expect(findShortestIndex([])).toBe(-1);
  });

  test("14. Only one available route is labeled Recommended once", () => {
    const routes = [
      {
        travelTime: 18,
        travelTimeInSeconds: 1080,
        trafficDelay: 2,
        trafficDelayInSeconds: 120,
        trafficLevel: "low",
        distance: "7.5",
        lengthInMeters: 7500,
      },
    ];
    const labeled = labelAndColorRoutes(routes);
    expect(labeled).toHaveLength(1);
    expect(labeled[0].label).toBe("Recommended");
    expect(labeled[0].isRecommended).toBe(true);
  });

  test("15. Invalid or incomplete route metrics are skipped for category selection", () => {
    const routes = [
      {
        travelTime: null,
        travelTimeInSeconds: null,
        trafficDelay: null,
        trafficDelayInSeconds: null,
        trafficLevel: "unknown",
        distance: null,
        lengthInMeters: null,
      },
      {
        travelTime: 20,
        travelTimeInSeconds: 1200,
        trafficDelay: 3,
        trafficDelayInSeconds: 180,
        trafficLevel: "medium",
        distance: "10.0",
        lengthInMeters: 10000,
      },
      {
        travelTime: -5,
        travelTimeInSeconds: -100,
        trafficDelay: -1,
        trafficDelayInSeconds: -60,
        trafficLevel: "unknown",
        distance: "abc",
        lengthInMeters: -50,
      },
    ];
    const labeled = labelAndColorRoutes(routes);
    expect(labeled[1].label).toBe("Recommended");
    expect(labeled[1].isRecommended).toBe(true);
    expect(labeled[0].isRecommended).toBe(false);
    expect(labeled[2].isRecommended).toBe(false);
  });

  test("16. Multiple routes with different traffic conditions and distances get distinct categories", () => {
    const routes = [
      {
        travelTime: 30,
        travelTimeInSeconds: 1800,
        trafficDelay: 5,
        trafficDelayInSeconds: 300,
        trafficLevel: "medium",
        distance: "10.0",
        lengthInMeters: 10000,
      },
      {
        travelTime: 20,
        travelTimeInSeconds: 1200,
        trafficDelay: 8,
        trafficDelayInSeconds: 480,
        trafficLevel: "high",
        distance: "12.0",
        lengthInMeters: 12000,
      },
      {
        travelTime: 40,
        travelTimeInSeconds: 2400,
        trafficDelay: 0,
        trafficDelayInSeconds: 0,
        trafficLevel: "low",
        distance: "15.0",
        lengthInMeters: 15000,
      },
    ];
    const labeled = labelAndColorRoutes(routes);
    expect(labeled[1].label).toBe("Recommended");
    expect(labeled[2].label).toBe("Least Traffic");
    expect(labeled[0].label).toBe("Shortest");

    const labels = labeled.map((r) => r.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labeled.filter((r) => r.isRecommended)).toHaveLength(1);
  });

  test("does not assume identical travel times mean identical routes", () => {
    const routes = [
      {
        travelTime: 20,
        travelTimeInSeconds: 1200,
        trafficDelay: 4,
        trafficDelayInSeconds: 240,
        trafficLevel: "medium",
        distance: "10.0",
        lengthInMeters: 10000,
        route: [
          [24.71, 46.67],
          [24.8, 46.7],
        ],
      },
      {
        travelTime: 20,
        travelTimeInSeconds: 1200,
        trafficDelay: 4,
        trafficDelayInSeconds: 240,
        trafficLevel: "medium",
        distance: "10.0",
        lengthInMeters: 10000,
        route: [
          [24.71, 46.67],
          [24.75, 46.8],
          [24.8, 46.7],
        ],
      },
    ];
    const labeled = labelAndColorRoutes(routes);
    // Distinct route indices; first wins stable ties.
    expect(labeled[0].label).toBe("Recommended");
    expect(labeled[1].label).toBe("Alternative");
    expect(labeled[0].id).not.toBe(labeled[1].id);
  });

  test("colors the most congested route red and the least-burdened green", () => {
    const routes = [
      {
        travelTime: 30,
        trafficDelay: 5,
        trafficLevel: "medium",
        distance: "10.0",
      },
      {
        travelTime: 20,
        trafficDelay: 0,
        trafficLevel: "low",
        distance: "12.0",
      },
      {
        travelTime: 40,
        trafficDelay: 10,
        trafficLevel: "high",
        distance: "9.0",
      },
    ];
    const labeled = labelAndColorRoutes(routes);
    expect(labeled[1].color).toBe("#22C55E");
    expect(labeled[0].color).toBe("#F59E0B");
    expect(labeled[2].color).toBe("#EF4444");
  });

  test("gives every route a unique id derived from its index and label", () => {
    const routes = [
      {
        travelTime: 20,
        trafficDelay: 0,
        trafficLevel: "low",
        distance: "5.0",
      },
      {
        travelTime: 30,
        trafficDelay: 5,
        trafficLevel: "medium",
        distance: "8.0",
      },
    ];
    const labeled = labelAndColorRoutes(routes);
    const ids = labeled.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("end-to-end: normalize TomTom fixtures then label without double-counting", () => {
    const raw = [
      tomtomRoute({
        lengthInMeters: 12000,
        travelTimeInSeconds: 1200,
        trafficDelayInSeconds: 180,
      }),
      tomtomRoute({
        lengthInMeters: 5000,
        travelTimeInSeconds: 1800,
        trafficDelayInSeconds: 600,
      }),
      tomtomRoute({
        lengthInMeters: 15000,
        travelTimeInSeconds: 1500,
        trafficDelayInSeconds: 0,
      }),
    ];
    const labeled = labelAndColorRoutes(raw.map(normalizeRealRoute));
    expect(labeled[0].label).toBe("Recommended");
    expect(labeled[0].travelTime).toBe(20);
    expect(labeled[1].label).toBe("Shortest");
    expect(labeled[2].label).toBe("Least Traffic");
  });
});
