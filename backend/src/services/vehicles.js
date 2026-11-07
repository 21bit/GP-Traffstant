const { db } = require("../db");
const { normalizeVehicle } = require("./vehicleEfficiency");

function mapVehicle(row) {
  if (!row) return null;
  return {
    id: row.id,
    modified: Boolean(row.modified),
    manufacturer: row.manufacturer || "",
    model: row.model || "",
    year: row.year ?? null,
    engineDisplacementL: row.engine_displacement_l ?? null,
    fuelType: row.fuel_type || "gasoline",
    transmission: row.transmission || "",
    forcedInduction: row.forced_induction || "unknown",
    modifications: row.modifications || "",
    isDefault: Boolean(row.is_default),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function listVehicles(userId) {
  const rows = db
    .prepare(
      `SELECT * FROM vehicles
       WHERE user_id = ?
       ORDER BY is_default DESC, datetime(updated_at) DESC, id DESC`
    )
    .all(userId);
  return rows.map(mapVehicle);
}

function getVehicle(userId, id) {
  return mapVehicle(
    db.prepare("SELECT * FROM vehicles WHERE id = ? AND user_id = ?").get(id, userId)
  );
}

function clearDefault(userId) {
  db.prepare("UPDATE vehicles SET is_default = 0 WHERE user_id = ?").run(userId);
}

function createVehicle(userId, body = {}) {
  const normalized = normalizeVehicle(body);
  const existing = listVehicles(userId);
  const makeDefault = body.isDefault === true || existing.length === 0;

  if (makeDefault) clearDefault(userId);

  const result = db
    .prepare(
      `INSERT INTO vehicles (
        user_id, modified, manufacturer, model, year, engine_displacement_l,
        fuel_type, transmission, forced_induction, modifications, is_default,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
    )
    .run(
      userId,
      normalized.modified ? 1 : 0,
      normalized.manufacturer || null,
      normalized.model || null,
      normalized.year,
      normalized.engineDisplacementL,
      normalized.fuelType,
      normalized.transmission || null,
      normalized.forcedInduction,
      normalized.modifications || null,
      makeDefault ? 1 : 0
    );

  return getVehicle(userId, result.lastInsertRowid);
}

function updateVehicle(userId, id, body = {}) {
  const existing = getVehicle(userId, id);
  if (!existing) {
    const err = new Error("Vehicle not found.");
    err.status = 404;
    err.code = "VEHICLE_NOT_FOUND";
    throw err;
  }

  const merged = {
    modified: body.modified !== undefined ? body.modified : existing.modified,
    manufacturer:
      body.manufacturer !== undefined ? body.manufacturer : existing.manufacturer,
    model: body.model !== undefined ? body.model : existing.model,
    year: body.year !== undefined ? body.year : existing.year,
    engineDisplacementL:
      body.engineDisplacementL !== undefined
        ? body.engineDisplacementL
        : existing.engineDisplacementL,
    fuelType: body.fuelType !== undefined ? body.fuelType : existing.fuelType,
    transmission:
      body.transmission !== undefined ? body.transmission : existing.transmission,
    forcedInduction:
      body.forcedInduction !== undefined
        ? body.forcedInduction
        : existing.forcedInduction,
    modifications:
      body.modifications !== undefined ? body.modifications : existing.modifications,
  };

  const normalized = normalizeVehicle(merged);
  const makeDefault = body.isDefault === true;

  if (makeDefault) clearDefault(userId);

  db.prepare(
    `UPDATE vehicles SET
      modified = ?, manufacturer = ?, model = ?, year = ?, engine_displacement_l = ?,
      fuel_type = ?, transmission = ?, forced_induction = ?, modifications = ?,
      is_default = CASE WHEN ? THEN 1 ELSE is_default END,
      updated_at = datetime('now')
     WHERE id = ? AND user_id = ?`
  ).run(
    normalized.modified ? 1 : 0,
    normalized.manufacturer || null,
    normalized.model || null,
    normalized.year,
    normalized.engineDisplacementL,
    normalized.fuelType,
    normalized.transmission || null,
    normalized.forcedInduction,
    normalized.modifications || null,
    makeDefault ? 1 : 0,
    id,
    userId
  );

  return getVehicle(userId, id);
}

function setDefaultVehicle(userId, id) {
  const existing = getVehicle(userId, id);
  if (!existing) {
    const err = new Error("Vehicle not found.");
    err.status = 404;
    err.code = "VEHICLE_NOT_FOUND";
    throw err;
  }
  clearDefault(userId);
  db.prepare(
    "UPDATE vehicles SET is_default = 1, updated_at = datetime('now') WHERE id = ? AND user_id = ?"
  ).run(id, userId);
  return getVehicle(userId, id);
}

function deleteVehicle(userId, id) {
  const existing = getVehicle(userId, id);
  if (!existing) {
    const err = new Error("Vehicle not found.");
    err.status = 404;
    err.code = "VEHICLE_NOT_FOUND";
    throw err;
  }

  db.prepare("DELETE FROM vehicles WHERE id = ? AND user_id = ?").run(id, userId);

  if (existing.isDefault) {
    const next = db
      .prepare(
        `SELECT id FROM vehicles WHERE user_id = ?
         ORDER BY datetime(updated_at) DESC, id DESC LIMIT 1`
      )
      .get(userId);
    if (next) {
      db.prepare(
        "UPDATE vehicles SET is_default = 1, updated_at = datetime('now') WHERE id = ?"
      ).run(next.id);
    }
  }

  return { ok: true };
}

module.exports = {
  mapVehicle,
  listVehicles,
  getVehicle,
  createVehicle,
  updateVehicle,
  setDefaultVehicle,
  deleteVehicle,
};
