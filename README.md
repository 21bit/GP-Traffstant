# Traffstant — Pre-trip Decision Support for Riyadh

Traffstant helps commuters in Riyadh decide when to leave and which route to take. It compares live routes, scores each one for traffic health, forecasts upcoming congestion, and estimates fuel cost — all from a single trip-planning screen.

---

## How It Works

```
User enters origin + destination
        ↓
  TomTom Routing API        ← live routes, traffic flow, incidents
        ↓
  Express Backend           ← route health scoring, leave-now vs. wait,
                               vehicle efficiency request, fuel cost math
        ↓
  React Dashboard           ← map, ranked routes, departure trends
```

---

## Requirements

- Node.js 18+
- npm
- A [TomTom API key](https://developer.tomtom.com/)

---

## Quick Start

**Step 1 — Start the backend:**
```
cd backend
cp .env.example .env   # add your TOMTOM_API_KEY and JWT_SECRET
npm install
npm start
```

**Step 2 — Start the frontend:**
```
cd frontend
npm install
npm start
```

**Step 3 — Open the app:**
```
http://localhost:3000
```

---

## Project Structure

```
backend/
├── src/routes/        — API endpoints (auth, trips, decision, maps)
├── src/services/       — Route health, fuel estimate, decision logic
├── src/providers/        — Congestion prediction (mock | external)
└── src/services/__tests__/  — Jest unit tests

frontend/
└── src/components/
    ├── map/            — Map, route rendering, geo helpers
    └── planner/          — Trip planner, departure trends, health cards
```

---

## Configuration

Set these in `backend/.env`:

- `TOMTOM_API_KEY` — required for routing, geocoding, traffic and incidents
- `JWT_SECRET` — used to sign login tokens
- `PREDICTION_PROVIDER` — `mock` (default) or `external`
- `GEMINI_API_KEY` — Google Gemini key used only to estimate vehicle efficiency in km/L. Trip liters and cost are calculated by the backend. Leave it empty and fuel estimates return an unavailable result instead of crashing.
- `GEMINI_MODEL` — optional, defaults to `gemini-3.8-flash`
- Gasoline 91 and 95 prices live in `backend/src/config/fuelPrices.js` (Aramco retail fuels page). Update that file, or set `FUEL_PRICE_91` / `FUEL_PRICE_95`, when the official monthly list changes.

---

## Running Tests

```
cd backend
npm test
```

---

*Traffstant — Graduation Project*