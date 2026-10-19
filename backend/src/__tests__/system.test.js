const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.TRAFFSTANT_DB_PATH = path.join(
  os.tmpdir(),
  `traffstant-system-${process.pid}.db`
);
process.env.PREDICTION_PROVIDER = "mock";

jest.mock("axios");

const request = require("supertest");
const axios = require("axios");
const app = require("../../server");
const { db, DB_PATH } = require("../db");

const ORIGINAL_TOMTOM_KEY = process.env.TOMTOM_API_KEY;
const ORIGINAL_PRICE_91 = process.env.FUEL_PRICE_91;
const ORIGINAL_PRICE_95 = process.env.FUEL_PRICE_95;

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restoreEnv("TOMTOM_API_KEY", ORIGINAL_TOMTOM_KEY);
  restoreEnv("FUEL_PRICE_91", ORIGINAL_PRICE_91);
  restoreEnv("FUEL_PRICE_95", ORIGINAL_PRICE_95);
  axios.get.mockReset();
});

afterAll(() => {
  db.prepare("DELETE FROM users WHERE email LIKE ?").run("system-%@traffstant.test");
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(DB_PATH + suffix, { force: true });
  }
});

describe("system: a driver plans a trip", () => {
  const origin = { lat: 24.71, lng: 46.67, name: "العليا" };
  const destination = { lat: 24.95, lng: 46.7, name: "المطار" };

  test("the map receives traffic points for the dashboard", async () => {
    delete process.env.TOMTOM_API_KEY;

    const res = await request(app).get("/api/traffic");

    expect(res.status).toBe(200);
    expect(res.body.points.length).toBeGreaterThan(0);
    expect(res.body.points[0]).toEqual(
      expect.objectContaining({
        lat: expect.any(Number),
        lng: expect.any(Number),
        density: expect.any(String),
      })
    );
  });

  test("a place search returns a start point the planner can use", async () => {
    process.env.TOMTOM_API_KEY = "test-key";
    axios.get.mockResolvedValue({
      data: {
        results: [
          {
            position: { lat: origin.lat, lon: origin.lng },
            poi: { name: origin.name },
            address: { freeformAddress: "Riyadh", municipality: origin.name },
            dist: 120,
          },
        ],
      },
    });

    const res = await request(app)
      .get("/api/search-places")
      .query({ query: origin.name, lat: origin.lat, lon: origin.lng });

    expect(res.status).toBe(200);
    expect(res.body[0].name).toBe("العليا");
    expect(res.body[0].lat).toBe(24.71);
    expect(res.body[0].lng).toBe(46.67);
  });

  test("planning a route compares options, scores health, and advises when to leave", async () => {
    delete process.env.TOMTOM_API_KEY;

    const res = await request(app).post("/api/trip-decision").send({
      startLat: origin.lat,
      startLng: origin.lng,
      endLat: destination.lat,
      endLng: destination.lng,
      departureSlotsMinutes: [0, 15, 30, 45, 60],
    });

    expect(res.status).toBe(200);
    expect(res.body.routes.length).toBeGreaterThan(1);
    expect(res.body.routes.some((route) => route.label === "Recommended")).toBe(true);
    for (const route of res.body.routes) {
      expect(route.routeHealthScore).toBeGreaterThanOrEqual(5);
      expect(route.routeHealthScore).toBeLessThanOrEqual(100);
    }
    expect(["leave_now", "wait"]).toContain(res.body.recommendation.action);
    expect(res.body.departureComparison).toHaveLength(5);
    expect(res.body.trends).toHaveLength(5);
    expect(res.body.trends[0].congestionScore).toBeGreaterThanOrEqual(0.05);
    expect(res.body.trends[0].congestionScore).toBeLessThanOrEqual(1);
  });

  test("a trip with missing coordinates is rejected", async () => {
    const res = await request(app).post("/api/trip-decision").send({
      startLat: "north",
      startLng: origin.lng,
      endLat: destination.lat,
      endLng: destination.lng,
    });

    expect(res.status).toBe(400);
  });

  test("fuel prices and the trip cost are returned for the planned distance", async () => {
    delete process.env.FUEL_PRICE_91;
    delete process.env.FUEL_PRICE_95;

    const prices = await request(app).get("/api/fuel-prices");
    expect(prices.status).toBe(200);
    expect(prices.body.grades["91"].pricePerLiterSar).toBe(2.18);
    expect(prices.body.grades["95"].pricePerLiterSar).toBe(2.33);

    const estimate = await request(app).post("/api/fuel-estimate").send({
      kmPerLiter: 15,
      distanceKm: 100,
      fuelGrade: "91",
      vehicle: {
        modified: false,
        manufacturer: "Toyota",
        model: "Corolla",
        year: 2022,
        fuelType: "gasoline",
      },
    });

    expect(estimate.status).toBe(200);
    expect(estimate.body.fuel.liters).toBe(6.67);
    expect(estimate.body.fuel.costSar).toBe(14.54);
    expect(estimate.body.price.pricePerLiterSar).toBe(2.18);
  });

  test("the planned trip can be saved and read back from history", async () => {
    delete process.env.TOMTOM_API_KEY;
    const email = `system-${process.pid}@traffstant.test`;

    const decision = await request(app).post("/api/trip-decision").send({
      startLat: origin.lat,
      startLng: origin.lng,
      endLat: destination.lat,
      endLng: destination.lng,
      departureSlotsMinutes: [0, 30],
    });
    const route = decision.body.routes.find((item) => item.isRecommended);

    const registered = await request(app).post("/api/auth/register").send({
      email,
      password: "test-pass-1",
      name: "System",
    });
    const token = registered.body.token;

    const saved = await request(app)
      .post("/api/trips")
      .set("Authorization", `Bearer ${token}`)
      .send({
        originName: origin.name,
        destName: destination.name,
        startLat: origin.lat,
        startLng: origin.lng,
        endLat: destination.lat,
        endLng: destination.lng,
        chosenRouteLabel: route.label,
        routeHealthScore: route.routeHealthScore,
        travelTimeMinutes: route.travelTimeMinutes,
        distanceKm: route.distanceKm,
        recommendationAction: decision.body.recommendation.action,
        status: "saved",
      });

    expect(saved.status).toBe(201);

    const history = await request(app)
      .get("/api/trips")
      .set("Authorization", `Bearer ${token}`);

    expect(history.status).toBe(200);
    expect(history.body.trips[0].originName).toBe("العليا");
    expect(history.body.trips[0].destName).toBe("المطار");
    expect(history.body.trips[0].routeHealthScore).toBe(route.routeHealthScore);
    expect(history.body.trips[0].recommendationAction).toBe(
      decision.body.recommendation.action
    );
  });
});
