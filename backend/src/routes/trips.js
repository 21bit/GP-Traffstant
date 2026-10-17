const express = require("express");
const { db } = require("../db");
const { requireAuth } = require("../auth");
const { canStartTrip, finishTrip } = require("../services/tripSession");

const router = express.Router();

router.use(requireAuth);

function mapTrip(row) {
  if (!row) return null;
  return {
    id: row.id,
    originName: row.origin_name,
    destName: row.dest_name,
    startLat: row.start_lat,
    startLng: row.start_lng,
    endLat: row.end_lat,
    endLng: row.end_lng,
    chosenRouteLabel: row.chosen_route_label,
    routeHealthScore: row.route_health_score,
    travelTimeMinutes: row.travel_time_minutes,
    distanceKm: row.distance_km,
    recommendationAction: row.recommendation_action,
    recommendationWaitMinutes: row.recommendation_wait_minutes,
    predictedEtaMinutes: row.predicted_eta_minutes,
    fuelLiters: row.fuel_liters,
    fuelCostSar: row.fuel_cost_sar,
    status: row.status || "saved",
    startedAt: row.started_at,
    endedAt: row.ended_at,
    snapshot: row.snapshot_json ? JSON.parse(row.snapshot_json) : null,
    createdAt: row.created_at,
  };
}

router.get("/", (req, res) => {
  const rows = db
    .prepare(
      `SELECT id, origin_name, dest_name, start_lat, start_lng, end_lat, end_lng,
              chosen_route_label, route_health_score, travel_time_minutes, distance_km,
              recommendation_action, recommendation_wait_minutes, predicted_eta_minutes,
              fuel_liters, fuel_cost_sar, status, started_at, ended_at,
              snapshot_json, created_at
       FROM trips WHERE user_id = ? ORDER BY datetime(created_at) DESC LIMIT 50`
    )
    .all(req.user.id);

  return res.json({ trips: rows.map(mapTrip) });
});

router.post("/", (req, res) => {
  const body = req.body || {};
  const startLat = Number(body.startLat);
  const startLng = Number(body.startLng);
  const endLat = Number(body.endLat);
  const endLng = Number(body.endLng);
  const status = body.status || "saved";

  if (![startLat, startLng, endLat, endLng].every((n) => Number.isFinite(n))) {
    return res.status(400).json({
      error: "startLat, startLng, endLat, endLng are required numbers",
      code: "invalid_route",
    });
  }

  if (!["saved", "active"].includes(status)) {
    return res.status(400).json({
      error: "New trips can be saved or started.",
      code: "invalid_outcome",
    });
  }

  if (status === "active") {
    const check = canStartTrip(null, {
      startLat,
      startLng,
      endLat,
      endLng,
      distanceKm: body.distanceKm,
    });
    if (!check.ok) {
      return res.status(400).json({
        error: "A selected route with a positive distance is required to start a trip.",
        code: check.code,
      });
    }
    const existing = db
      .prepare(
        "SELECT id FROM trips WHERE user_id = ? AND status = 'active' LIMIT 1"
      )
      .get(req.user.id);
    if (existing) {
      return res.status(409).json({
        error: "A trip is already active.",
        code: "already_active",
        tripId: existing.id,
      });
    }
  }

  const startedAt = status === "active" ? new Date().toISOString() : null;

  const result = db
    .prepare(
      `INSERT INTO trips (
        user_id, origin_name, dest_name, start_lat, start_lng, end_lat, end_lng,
        chosen_route_label, route_health_score, travel_time_minutes, distance_km,
        recommendation_action, recommendation_wait_minutes, predicted_eta_minutes,
        fuel_liters, fuel_cost_sar, snapshot_json, status, started_at, ended_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.user.id,
      body.originName || null,
      body.destName || null,
      startLat,
      startLng,
      endLat,
      endLng,
      body.chosenRouteLabel || null,
      body.routeHealthScore ?? null,
      body.travelTimeMinutes ?? null,
      body.distanceKm ?? null,
      body.recommendationAction || null,
      body.recommendationWaitMinutes ?? null,
      body.predictedEtaMinutes ?? null,
      body.fuelLiters ?? null,
      body.fuelCostSar ?? null,
      body.snapshot ? JSON.stringify(body.snapshot) : null,
      status,
      startedAt,
      null
    );

  const row = db.prepare("SELECT * FROM trips WHERE id = ?").get(result.lastInsertRowid);
  return res.status(201).json({ trip: mapTrip(row) });
});

router.patch("/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: "Invalid trip id" });
  }

  const existing = db
    .prepare("SELECT * FROM trips WHERE id = ? AND user_id = ?")
    .get(id, req.user.id);

  if (!existing) {
    return res.status(404).json({ error: "Trip not found" });
  }

  const outcome = req.body?.status;
  const result = finishTrip(
    {
      status: existing.status || "saved",
      id: existing.id,
    },
    outcome
  );

  if (!result.ok) {
    const message =
      result.code === "not_active"
        ? "Only an active trip can be ended or cancelled."
        : "Status must be completed or cancelled.";
    return res.status(409).json({ error: message, code: result.code });
  }

  db.prepare(
    "UPDATE trips SET status = ?, ended_at = ? WHERE id = ? AND user_id = ?"
  ).run(result.session.status, result.session.endedAt, id, req.user.id);

  const row = db.prepare("SELECT * FROM trips WHERE id = ?").get(id);
  return res.json({ trip: mapTrip(row) });
});

router.delete("/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: "Invalid trip id" });
  }

  const existing = db
    .prepare("SELECT id FROM trips WHERE id = ? AND user_id = ?")
    .get(id, req.user.id);

  if (!existing) {
    return res.status(404).json({ error: "Trip not found" });
  }

  db.prepare("DELETE FROM trips WHERE id = ? AND user_id = ?").run(id, req.user.id);
  return res.json({ ok: true });
});

module.exports = router;
