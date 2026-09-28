const express = require("express");
const { db } = require("../db");
const { requireAuth } = require("../auth");

const router = express.Router();

router.use(requireAuth);

router.get("/", (req, res) => {
  const rows = db
    .prepare(
      `SELECT id, origin_name, dest_name, start_lat, start_lng, end_lat, end_lng,
              chosen_route_label, route_health_score, travel_time_minutes, distance_km,
              recommendation_action, recommendation_wait_minutes, predicted_eta_minutes,
              fuel_liters, fuel_cost_sar, snapshot_json, created_at
       FROM trips WHERE user_id = ? ORDER BY datetime(created_at) DESC LIMIT 50`
    )
    .all(req.user.id);

  const trips = rows.map((row) => ({
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
    snapshot: row.snapshot_json ? JSON.parse(row.snapshot_json) : null,
    createdAt: row.created_at,
  }));

  return res.json({ trips });
});

router.post("/", (req, res) => {
  const body = req.body || {};
  const startLat = Number(body.startLat);
  const startLng = Number(body.startLng);
  const endLat = Number(body.endLat);
  const endLng = Number(body.endLng);

  if (
    [startLat, startLng, endLat, endLng].some((n) => Number.isNaN(n))
  ) {
    return res.status(400).json({
      error: "startLat, startLng, endLat, endLng are required numbers",
    });
  }

  const result = db
    .prepare(
      `INSERT INTO trips (
        user_id, origin_name, dest_name, start_lat, start_lng, end_lat, end_lng,
        chosen_route_label, route_health_score, travel_time_minutes, distance_km,
        recommendation_action, recommendation_wait_minutes, predicted_eta_minutes,
        fuel_liters, fuel_cost_sar, snapshot_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      body.snapshot ? JSON.stringify(body.snapshot) : null
    );

  const row = db
    .prepare("SELECT * FROM trips WHERE id = ?")
    .get(result.lastInsertRowid);

  return res.status(201).json({
    trip: {
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
      createdAt: row.created_at,
    },
  });
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

  db.prepare("DELETE FROM trips WHERE id = ? AND user_id = ?").run(
    id,
    req.user.id
  );
  return res.json({ ok: true });
});

module.exports = router;
