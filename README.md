# Traffstant — Pre-trip decision support for Riyadh

## Run locally

### Backend
```bash
cd backend
cp .env.example .env   # set TOMTOM_API_KEY and JWT_SECRET
npm install
npm start
```
API listens on `http://localhost:4000` by default.

### Frontend
```bash
cd frontend
npm install
npm start
```
App opens at `http://localhost:3000` and talks to the local API.

## What it does
- Compare routes and Route Health Scores
- Leave-now vs wait recommendation with estimated time saved
- Peak-hour congestion trends (mock or external prediction provider)
- Fuel estimate
- Authenticated trip history (JWT + SQLite)

Prediction responses always include `source: "mock"` or `"external"`. Mock mode is clearly labeled in the UI.
