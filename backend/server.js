require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");

// Ensure DB schema is initialized on boot
require("./src/db");

const authRoutes = require("./src/routes/auth");
const tripsRoutes = require("./src/routes/trips");
const decisionRoutes = require("./src/routes/decision");
const mapsRoutes = require("./src/routes/maps");
const { getProviderName } = require("./src/providers/predictionProvider");

const app = express();
const PORT = process.env.PORT || 5000;

const ALLOWED_ORIGINS = [
  "https://traffstant.com",
  "https://www.traffstant.com",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

app.use(
  cors({
    origin: (incomingOrigin, callback) => {
      if (!incomingOrigin || ALLOWED_ORIGINS.includes(incomingOrigin)) {
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

app.use((err, _req, res, _next) => {
  console.error("[server]", err.message);
  res.status(500).json({ error: err.message || "Internal server error" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[server] Traffstant pre-trip API on port ${PORT}`);
  console.log(`[server] DB: ${path.join(__dirname, "data", "traffstant.db")}`);
});
