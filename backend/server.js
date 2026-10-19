require("dotenv").config();

const express = require("express");
const cors = require("cors");

// Ensure DB schema is initialized on boot
const { DB_PATH } = require("./src/db");

const authRoutes = require("./src/routes/auth");
const tripsRoutes = require("./src/routes/trips");
const decisionRoutes = require("./src/routes/decision");
const mapsRoutes = require("./src/routes/maps");
const fuelRoutes = require("./src/routes/fuel");
const { getProviderName } = require("./src/providers/predictionProvider");

const app = express();
const PORT = process.env.PORT || 5000;

const ALLOWED_ORIGINS = [
  "https://traffstant.com",
  "https://www.traffstant.com",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

function isAllowedOrigin(origin) {
  if (!origin || ALLOWED_ORIGINS.includes(origin)) return true;
  return /^http:\/\/(192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}):3000$/.test(
    origin
  );
}

app.use(
  cors({
    origin: (incomingOrigin, callback) => {
      if (isAllowedOrigin(incomingOrigin)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS: origin '${incomingOrigin}' is not allowed`));
      }
    },
    credentials: true,
  })
);
app.use(express.json({ limit: "1mb" }));

if (!process.env.TOMTOM_API_KEY) {
  console.warn("[WARN] TOMTOM_API_KEY is not set. Routing/search will use fallbacks.");
}
if (!process.env.JWT_SECRET) {
  console.warn("[WARN] JWT_SECRET is not set. Using insecure development default.");
}
if (!process.env.GEMINI_API_KEY) {
  console.warn(
    "[WARN] GEMINI_API_KEY is not set. Vehicle efficiency estimates will be unavailable until it is configured."
  );
}

console.log(`[prediction] Active provider: ${getProviderName()}`);

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/ping", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api/auth", authRoutes);
app.use("/api/trips", tripsRoutes);
app.use("/api", decisionRoutes);
app.use("/api", mapsRoutes);
app.use("/api", fuelRoutes);

app.use((err, _req, res, _next) => {
  console.error("[server]", err.message);
  res.status(500).json({ error: err.message || "Internal server error" });
});

if (require.main === module) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[server] Traffstant pre-trip API on port ${PORT}`);
    console.log(`[server] DB: ${DB_PATH}`);
  });
}

module.exports = app;
