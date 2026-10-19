const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.TRAFFSTANT_DB_PATH = path.join(
  os.tmpdir(),
  `traffstant-integration-${process.pid}.db`
);
process.env.PREDICTION_PROVIDER = "mock";

jest.mock("axios");
jest.mock("../providers/predictionProvider", () => ({
  getProviderName: () => "mock",
  predictCongestion: async () => ({
    source: "mock",
    disclaimer: "Fixed forecast for the integration test.",
    level: "low",
    predictionScore: 10,
    congestionScore: 0.1,
    confidence: 0.8,
    confidenceLabel: "80%",
  }),
}));

const request = require("supertest");
const axios = require("axios");
const app = require("../../server");
const { db, DB_PATH } = require("../db");
const { fetchRoutes } = require("../services/tomtomRouting");
const { buildTripDecision, congestionForSlot } = require("../services/decisionService");
const { computeRouteHealthScore } = require("../services/routeHealth");

const ORIGINAL_TOMTOM_KEY = process.env.TOMTOM_API_KEY;

afterEach(() => {
  if (ORIGINAL_TOMTOM_KEY === undefined) delete process.env.TOMTOM_API_KEY;
  else process.env.TOMTOM_API_KEY = ORIGINAL_TOMTOM_KEY;
  axios.get.mockReset();
});

afterAll(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(DB_PATH + suffix, { force: true });
  }
});

describe("trip session and the trips database", () => {
  const email = `integration-${process.pid}@traffstant.test`;
  const password = "test-pass-1";
  const route = {
    originName: "العليا",
    destName: "المطار",
    startLat: 24.71,
    startLng: 46.67,
    endLat: 24.95,
    endLng: 46.7,
    chosenRouteLabel: "Recommended",
    distanceKm: 32.4,
    status: "active",
  };

  afterAll(() => {
    db.prepare("DELETE FROM users WHERE email = ?").run(email);
  });

  test("starts a trip through the API and stores it, then rejects a second start and completes the row", async () => {
    const registered = await request(app).post("/api/auth/register").send({
      email,
      password,
      name: "Integration",
    });
    expect(registered.status).toBe(201);
    const token = registered.body.token;

    const started = await request(app)
      .post("/api/trips")
      .set("Authorization", `Bearer ${token}`)
      .send(route);

    expect(started.status).toBe(201);
    expect(started.body.trip.status).toBe("active");
    expect(started.body.trip.distanceKm).toBe(32.4);
    expect(started.body.trip.startedAt).toEqual(expect.any(String));

    const saved = db.prepare("SELECT * FROM trips WHERE id = ?").get(started.body.trip.id);
    expect(saved.status).toBe("active");
    expect(saved.distance_km).toBe(32.4);
    expect(saved.origin_name).toBe("العليا");
    expect(saved.started_at).toBe(started.body.trip.startedAt);

    const again = await request(app)
      .post("/api/trips")
      .set("Authorization", `Bearer ${token}`)
      .send(route);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("already_active");

    const ended = await request(app)
      .patch(`/api/trips/${started.body.trip.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "completed" });

    expect(ended.status).toBe(200);
    expect(ended.body.trip.status).toBe("completed");

    const finished = db.prepare("SELECT * FROM trips WHERE id = ?").get(started.body.trip.id);
    expect(finished.status).toBe("completed");
    expect(finished.ended_at).toBe(ended.body.trip.endedAt);
  });
});

describe("routing unit and the TomTom API", () => {
  test("sends the route request and labels the parsed TomTom routes", async () => {
    process.env.TOMTOM_API_KEY = "test-key";
    axios.get.mockResolvedValue({
      data: {
        routes: [
          {
            legs: [
              {
                points: [
                  { latitude: 24.71, longitude: 46.67 },
                  { latitude: 24.8, longitude: 46.7 },
                ],
              },
            ],
            summary: {
              lengthInMeters: 12000,
              travelTimeInSeconds: 1200,
              trafficDelayInSeconds: 0,
            },
          },
          {
            legs: [
              {
                points: [
                  { latitude: 24.71, longitude: 46.67 },
                  { latitude: 24.9, longitude: 46.8 },
                ],
              },
            ],
            summary: {
              lengthInMeters: 5000,
              travelTimeInSeconds: 1800,
              trafficDelayInSeconds: 600,
            },
          },
        ],
      },
    });

    const routes = await fetchRoutes(24.71, 46.67, 24.95, 46.7);

    expect(axios.get).toHaveBeenCalledTimes(1);
    const [url, config] = axios.get.mock.calls[0];
    expect(url).toContain("api.tomtom.com/routing/1/calculateRoute/24.71,46.67:24.95,46.7");
    expect(config.params.key).toBe("test-key");
    expect(config.params.traffic).toBe(true);

    const recommended = routes.find((route) => route.label === "Recommended");
    const shortest = routes.find((route) => route.distance === "5.0");
    expect(recommended.travelTime).toBe(20);
    expect(recommended.source).toBe("tomtom");
    expect(shortest.label).toBe("Shortest");
  });
});

describe("decision, route health, and congestion together", () => {
  test("scores fetched routes with the health unit and the congestion unit", async () => {
    delete process.env.TOMTOM_API_KEY;

    const decision = await buildTripDecision({
      startLat: 24.71,
      startLng: 46.67,
      endLat: 24.95,
      endLng: 46.7,
      departureSlotsMinutes: [0, 30],
    });

    expect(decision.routes).toHaveLength(3);
    expect(decision.routes.every((route) => route.source === "synthetic")).toBe(true);
    expect(decision.departureComparison).toHaveLength(2);
    expect(["leave_now", "wait"]).toContain(decision.recommendation.action);

    const recommended = decision.routes.find((route) => route.isRecommended);
    expect(recommended.routeHealthScore).toBe(
      computeRouteHealthScore(recommended, decision.prediction, 0)
    );
    expect(recommended.routeHealthScore).toBeGreaterThanOrEqual(5);
    expect(recommended.routeHealthScore).toBeLessThanOrEqual(100);

    const nowSlot = decision.departureComparison[0];
    const fastest = decision.routes.find(
      (route) => route.travelTimeMinutes === nowSlot.etaMinutes
    );
    expect(nowSlot.congestionScore).toBe(
      congestionForSlot(
        {
          travelTime: fastest.travelTimeMinutes,
          trafficDelay: fastest.trafficDelayMinutes,
          trafficLevel: fastest.trafficLevel,
        },
        { congestionScore: decision.prediction.predictionScore / 100 }
      )
    );
    expect(nowSlot.routeHealthScore).toBeGreaterThanOrEqual(5);
    expect(nowSlot.routeHealthScore).toBeLessThanOrEqual(100);
  });
});
