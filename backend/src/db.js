const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const DATA_DIR = path.join(__dirname, "..", "data");
const DB_PATH = process.env.TRAFFSTANT_DB_PATH
  ? path.resolve(process.env.TRAFFSTANT_DB_PATH)
  : path.join(DATA_DIR, "traffstant.db");

if (!fs.existsSync(path.dirname(DB_PATH))) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    name TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS trips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    origin_name TEXT,
    dest_name TEXT,
    start_lat REAL NOT NULL,
    start_lng REAL NOT NULL,
    end_lat REAL NOT NULL,
    end_lng REAL NOT NULL,
    chosen_route_label TEXT,
    route_health_score INTEGER,
    travel_time_minutes INTEGER,
    distance_km REAL,
    recommendation_action TEXT,
    recommendation_wait_minutes INTEGER,
    predicted_eta_minutes INTEGER,
    fuel_liters REAL,
    fuel_cost_sar REAL,
    snapshot_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_trips_user_id ON trips(user_id);
`);

function ensureColumn(table, name, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((column) => column.name === name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

ensureColumn("trips", "status", "TEXT NOT NULL DEFAULT 'saved'");
ensureColumn("trips", "started_at", "TEXT");
ensureColumn("trips", "ended_at", "TEXT");

module.exports = { db, DB_PATH };
