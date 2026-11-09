# Traffstant

**Traffic-aware route planning and pre-trip decision support for Riyadh.**

Traffstant helps commuters compare available routes, understand current traffic conditions, evaluate alternative departure times, and estimate trip fuel consumption and cost. The application combines a React frontend with a Node.js/Express backend, TomTom traffic and routing services, configurable congestion-prediction providers, the Groq API for vehicle fuel-efficiency estimation, and an SQLite database for user accounts, saved vehicles, and trip history.

> **Project scope:** Traffstant provides route planning and trip decision support. Traffic predictions and fuel figures are estimates, not guarantees of actual road conditions or vehicle consumption.

## Contents

- [Core Features](#core-features)
- [How the Main Algorithms Work](#how-the-main-algorithms-work)
- [Groq Vehicle-Efficiency Estimation](#groq-vehicle-efficiency-estimation)
- [Technology Stack](#technology-stack)
- [Architecture](#architecture)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Environment Configuration](#environment-configuration)
- [API Overview](#api-overview)
- [Database](#database)
- [Current Implementation Notes](#current-implementation-notes)

## Core Features

### Route planning and traffic information

- Search for places and resolve locations through the backend's TomTom Search integration.
- Retrieve driving routes and alternative routes using the TomTom Routing API.
- Request the fastest route with traffic-aware travel-time calculations.
- Compare route alternatives using labels such as **Recommended**, **Least Traffic**, and **Shortest**.
- Display traffic-flow information on a Riyadh map and visualize traffic density through a heatmap layer.
- Fall back to synthetic routes when TomTom routing is unavailable or no API key is configured. Synthetic routes are for fallback/development use and should not be interpreted as live TomTom results.

### Departure-time recommendations

- Evaluate the current departure and configurable future departure slots. The planner currently sends offsets of 0, 15, 30, 45, and 60 minutes.
- Retrieve route information for future departure times and obtain a congestion prediction for each slot.
- Compare estimated travel times to recommend **Leave Now** or **Wait**.
- Recommend waiting when a future slot is estimated to save at least five minutes compared with leaving now.

### Route health score

- Calculate a route health score from traffic-delay ratio, traffic level, and corridor congestion prediction.
- Start from 100 points and apply bounded penalties, returning a score between 5 and 100.
- The scoring function also contains an incident penalty, but live decision requests currently do not pass an incident count to it. See [Current Implementation Notes](#current-implementation-notes).

### Fuel estimation

- Estimate vehicle fuel efficiency (km/L) from vehicle details.
- Prefer a built-in catalog value for selected common gasoline models; otherwise call the **Groq** API to estimate efficiency.
- Calculate estimated fuel usage and gasoline cost **deterministically in the backend** from distance, km/L, and the configured 91- or 95-octane price. Groq does not calculate liters or SAR cost.
- Validate distance, efficiency, and price inputs before calculating the estimate.
- Allow fuel estimation without requiring a saved account vehicle; signed-in users can also manage saved vehicles.
- Gasoline prices are configured values based on the Aramco retail fuels list, not a live price feed.

### Accounts, vehicles, and trip history

- Register and authenticate users using password hashing and token-based authentication.
- Save, list, update, select a default, and delete vehicles for the authenticated user.
- Save trip records and retrieve a user's trip history.
- Update trip status and timestamps, and delete saved trip records.
- Restrict vehicle and trip operations to the authenticated owner.

### Map and planner support

- Use browser geolocation to initialize the trip origin, with a Riyadh-center fallback if location access is unavailable.
- Display map layers and planned routes using Leaflet and React Leaflet.
- Include Saher camera reference data in the frontend data/config layer for Riyadh. Live proximity-alert and in-trip navigation overlays are not part of the current pre-trip planner flow.

## How the Main Algorithms Work

### Route retrieval

The backend sends the origin and destination coordinates to the TomTom Routing API with `routeType: "fastest"`, `traffic: true`, and `computeTravelTimeFor: "all"`. Returned route data is normalized into the application's internal route format, including distance, travel time, and traffic delay.

### Route health score

The route health calculation starts at 100 and subtracts penalties for:

- Traffic delay relative to estimated travel time (up to 40 points).
- Traffic level: 25 points for high congestion or 12 for medium congestion.
- Corridor prediction: up to 20 points, based on the prediction score or level.
- Incidents: 4 points per incident, capped at 16 points, when an incident count is supplied.

The result is clamped to the range 5–100. **The current live decision flow does not supply the incident count**, so the incident penalty is not currently applied to live route-health results.

### Leave Now or Wait

The decision service evaluates departure slots, chooses the route with the lowest estimated travel time for each slot, and compares the best future slot with the current slot. It recommends waiting only when a future slot has an estimated travel time at least five minutes lower than the current option; otherwise, it recommends leaving now.

### Fuel consumption and cost

The calculation uses:

```text
Fuel used (L) = Distance (km) / Fuel efficiency (km/L)
Fuel cost (SAR) = Fuel used (L) × Fuel price (SAR/L)
```

The backend validates the inputs and rounds calculated fuel usage and cost to two decimal places. The km/L value may come from the local vehicle catalog or from Groq; the liters and cost formulas above always run in this backend process.

### Trip persistence

Trip and vehicle records are stored in SQLite. Database queries use the authenticated user's ID to scope records to their owner, and SQL values are passed as parameters rather than concatenated into query strings.

## Groq Vehicle-Efficiency Estimation

Traffstant uses **Groq** as an external AI service for one specific task: estimating a vehicle's typical combined fuel efficiency in kilometers per liter (`kmPerLiter`).

**What Groq is used for**

- Estimate `kmPerLiter` from manufacturer, model, year, engine size, fuel type, transmission, and modification notes when a catalog value is not available.
- Return a structured estimate with basis, explanation, and confidence metadata.

**What Groq is not used for**

- TomTom route retrieval
- Route health scoring
- Leave Now / Wait departure decisions
- Congestion prediction (that uses the mock or external prediction provider)
- Trip fuel liters or SAR cost calculation

**How it fits the flow**

1. The frontend sends vehicle details and route distance to `POST /api/fuel-estimate`.
2. The backend resolves efficiency:
   - catalog approximation for selected common gasoline models, or
   - Groq estimation when catalog lookup does not apply / is unavailable.
3. The backend then calculates:
   - `liters = distanceKm / kmPerLiter`
   - `costSar = liters × pricePerLiterSar`

Without `GROQ_API_KEY`, Groq-backed estimates are unavailable for vehicles that are not covered by the local catalog. The app should report an unavailable efficiency result rather than inventing a value.

## Technology Stack

| Area | Technologies |
|---|---|
| Frontend | React 18, JavaScript, Create React App |
| Maps | Leaflet, React Leaflet, Leaflet Heat |
| Backend | Node.js, Express |
| Database | SQLite, better-sqlite3 |
| Routing, search, traffic | TomTom Routing, Search, and Traffic Flow APIs |
| Congestion prediction | Mock provider by default; optional external prediction API |
| Vehicle-efficiency estimation | Groq SDK, with built-in efficiency values for selected models |
| Authentication | bcryptjs, JSON Web Tokens |
| Testing | Jest, Supertest, React Testing Library |

## Architecture

Conceptual layered view used in the project documentation:

```text
Presentation Layer
        ↓
Application Layer
        ↓
AI Processing Layer
        ↓
Database Layer
```

Technical runtime view of the current implementation:

```text
┌──────────────────────────────────────────────┐
│                 React Frontend               │
│                                              │
│ Trip Planner · Route/Health Cards · Map      │
│ Departure Advice · Fuel · Vehicles           │
│ Trip History                                 │
└──────────────────────┬───────────────────────┘
                       │ HTTP / JSON
                       ▼
┌──────────────────────────────────────────────┐
│              Node.js / Express API            │
│                                              │
│ Auth · Routes · Decision Service · Fuel      │
│ Vehicles · Trips · Prediction Provider       │
└────────────┬──────────────┬───────────────────┘
             │              │
             ▼              ▼
┌───────────────────┐  ┌────────────────────────┐
│ External Services │  │       SQLite DB        │
│ TomTom APIs       │  │ Users · Trips · Vehicles│
│ Prediction API    │  └────────────────────────┘
│ Groq API          │
└───────────────────┘
```

Notes:

- The **AI Processing Layer** in the conceptual diagram covers decision support, route-health scoring, congestion prediction, and **Groq-based vehicle-efficiency estimation**.
- Groq is the main external AI API used by the project today; it estimates vehicle `kmPerLiter` only.
- Congestion prediction defaults to a **mock** provider, not a live machine-learning traffic forecast. See [Current Implementation Notes](#current-implementation-notes).

## Project Structure

```text
GP-Traffstant/
├── backend/
│   ├── server.js
│   ├── .env.example
│   └── src/
│       ├── auth.js
│       ├── config/          # Fuel-price configuration
│       ├── db.js            # SQLite initialization and schema
│       ├── providers/       # Mock and external prediction providers
│       ├── routes/          # Auth, trips, vehicles, maps, fuel, decisions
│       └── services/        # Routing, scoring, decisions, fuel, vehicles
│           └── __tests__/   # Backend service tests
├── frontend/
│   └── src/
│       ├── components/      # Planner and map UI
│       ├── data/            # Vehicle catalog and Saher camera data
│       ├── hooks/
│       ├── system/
│       └── utils/
├── scripts/                 # Data utility scripts
├── jest.config.js
└── README.md
```

## Getting Started

### Prerequisites

- Node.js (use a version supported by the installed `better-sqlite3` package; Node.js 20 or later is recommended).
- npm.
- A TomTom developer account and API key for live route, place-search, and traffic-flow data.

### 1. Configure the backend

```bash
cd backend
npm install
```

Copy the example environment file and edit it:

```bash
cp .env.example .env
```

Add the configuration described in [Environment Configuration](#environment-configuration). Do not commit this file or share its secret values.

For local development, keep backend and frontend on the same port convention. The recommended local setup is:

- Backend: `PORT=4000` in `backend/.env` (matches `backend/.env.example`)
- Frontend: `REACT_APP_API_BASE=http://localhost:4000`

If `PORT` is omitted, `server.js` falls back to `5000`. In that case set the frontend API base to `http://localhost:5000` instead.

### 2. Start the backend

```bash
npm start
```

### 3. Configure and start the frontend

In a second terminal:

```bash
cd frontend
npm install
```

Create `frontend/.env` with the backend URL:

```dotenv
REACT_APP_API_BASE=http://localhost:4000
```

Then start the React development server:

```bash
npm start
```

Open the frontend URL printed by Create React App (normally `http://localhost:3000`).

## Environment Configuration

Create `backend/.env` locally from `backend/.env.example`. The following variables are read by the backend:

| Variable | Purpose | Required / Default |
|---|---|---|
| `PORT` | Backend HTTP port | Optional; `4000` in `.env.example`; code fallback is `5000` if unset |
| `TOMTOM_API_KEY` | TomTom route, search, geocoding, and traffic-flow requests | Required for live TomTom data; synthetic/fallback behavior is used without it |
| `JWT_SECRET` | Signs authentication tokens | Set a strong, private value; the development fallback is insecure |
| `PREDICTION_PROVIDER` | Selects `mock` or `external` congestion prediction | Optional; defaults to `mock` |
| `PREDICTION_API_URL` | URL of the external prediction service | Required when using the external provider; the provider falls back to mock if unavailable |
| `GROQ_API_KEY` | Enables Groq-based vehicle-efficiency estimation | Optional; relevant estimates may be unavailable without it |
| `GROQ_MODEL` | Selects the Groq model | Optional; defaults to `openai/gpt-oss-20b` |
| `FUEL_PRICE_91` | Overrides configured 91-octane gasoline price (SAR/L) | Optional; uses the value in `fuelPrices.js` otherwise |
| `FUEL_PRICE_95` | Overrides configured 95-octane gasoline price (SAR/L) | Optional; uses the value in `fuelPrices.js` otherwise |
| `TRAFFSTANT_DB_PATH` | Overrides the SQLite database file path | Optional; defaults to `backend/data/traffstant.db` |

The frontend reads `REACT_APP_API_BASE` from `frontend/.env`. If unset, the frontend source defaults to `http://localhost:4000`.

**Security:** Never commit `.env` files, API keys, database files, or production secrets. Use a strong `JWT_SECRET` outside local development.

## API Overview

The backend exposes the following main routes:

| Method | Endpoint | Purpose | Authentication |
|---|---|---|---|
| `GET` | `/health` | Backend health check | No |
| `POST` | `/api/auth/register` | Register a user account | No |
| `POST` | `/api/auth/login` | Authenticate a user | No |
| `GET` | `/api/auth/me` | Retrieve the authenticated user profile | Yes |
| `POST` | `/api/trip-decision` | Build route and departure-time recommendations | No |
| `GET` | `/api/traffic-prediction` | Retrieve congestion prediction for coordinates | No |
| `GET` | `/api/traffic` | Retrieve cached Riyadh traffic-flow grid | No |
| `GET` | `/api/geocode` | Resolve a place query | No |
| `GET` | `/api/search-places` | Search for places | No |
| `POST` | `/api/recommend-route` | Retrieve and label route alternatives | No |
| `GET` | `/api/incidents` | Return the current incident collection (currently empty) | No |
| `GET` | `/api/fuel-prices` | Retrieve configured gasoline prices | No |
| `POST` | `/api/fuel-estimate` | Estimate trip fuel consumption and cost | No |
| `GET` | `/api/trips` | Retrieve the authenticated user's trips | Yes |
| `POST` | `/api/trips` | Save a trip | Yes |
| `PATCH` | `/api/trips/:id` | Update a trip | Yes |
| `DELETE` | `/api/trips/:id` | Delete a trip | Yes |
| `GET` | `/api/vehicles` | List the authenticated user's vehicles | Yes |
| `POST` | `/api/vehicles` | Save a vehicle | Yes |
| `PUT` | `/api/vehicles/:id` | Update a vehicle | Yes |
| `POST` | `/api/vehicles/:id/default` | Set a default vehicle | Yes |
| `DELETE` | `/api/vehicles/:id` | Delete a vehicle | Yes |

For exact request and response formats, refer to the route handlers under `backend/src/routes/`.

## Database

SQLite is initialized automatically when the backend starts. The default database location is:

```text
backend/data/traffstant.db
```

The schema contains:

- `users` — account identity and password hash.
- `trips` — trip coordinates, selected route details, recommendation, fuel estimate, status, and timestamps.
- `vehicles` — saved vehicle specifications, fuel type, modification details, and default-vehicle flag.

Set `TRAFFSTANT_DB_PATH` to use a different database file. Back up the database before deleting or replacing it.

## Current Implementation Notes

These details are important when evaluating or demonstrating the project:

1. **Congestion prediction defaults to mock.** `PREDICTION_PROVIDER` defaults to `mock`. This is a deterministic Riyadh-style time-pattern model for development, not a live AI traffic forecast. The external provider requires `PREDICTION_PROVIDER=external` and `PREDICTION_API_URL`; it falls back to mock if the external service is not configured or fails.
2. **Live incident integration is not complete.** The `/api/incidents` endpoint currently returns an empty list. Although the route-health function implements an incident penalty, the live decision flow does not currently pass an incident count into that function. Do not describe incident penalties as currently affecting live route-health scores.
3. **Diesel cost is not configured.** Vehicle efficiency may be estimated for a diesel vehicle, but the backend does not calculate diesel cost using the gasoline 91/95 prices. Diesel cost is returned as unavailable until a diesel price is configured and supported.
4. **Gasoline prices are configured values, not a live feed.** The 91- and 95-octane prices are maintained in `backend/src/config/fuelPrices.js` and can be overridden through environment variables. Update and verify them when the official prices change.
5. **TomTom fallback routes are synthetic.** If the TomTom key is missing or the routing request fails, the backend returns generated fallback routes. These should not be presented as live routing results.
6. **Fuel estimates are estimates.** Results depend on route distance, vehicle-efficiency information, and configured fuel prices; actual consumption varies with driving and vehicle conditions.
7. **Groq estimates efficiency only.** With a valid `GROQ_API_KEY`, Groq can estimate `kmPerLiter` for vehicles outside the local catalog. Liters and SAR cost are always calculated by the backend. Without the key, non-catalog vehicles may return an unavailable efficiency result.
8. **The trip planner evaluates departure slots.** Its current frontend request uses 0, 15, 30, 45, and 60-minute offsets. A recommendation to wait is based on estimated travel-time savings and is not a guarantee of a faster journey.
9. **Current UI focus is the pre-trip planner.** The active frontend entry point mounts the trip planner. Saher camera data exists in the frontend data/config layer, but live proximity alerts and in-trip navigation are outside the current planner flow.

---

*Traffstant — Graduation Project*
