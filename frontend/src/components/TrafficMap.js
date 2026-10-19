/**
 * TrafficMap — top-level orchestration component.
 *
 * Responsibilities:
 *   • Owns shared coordinate state (startCoords, endCoords, userLocation).
 *   • Owns GPS navigation state and handlers.
 *   • Owns the sequential toast notification queue (all alert types).
 *   • Owns data-fetching (traffic heatmap, incidents, traffic prediction).
 *   • Delegates map rendering   → MapContainer
 *   • Delegates routing logic   → useRouteEngine
 *   • Delegates navigation UI   → NavigationControls
 *   • Delegates safety HUD      → SafetyOverlay (SpeedGauge, alerts)
 *   • Delegates sidebar         → Sidebar
 */

import React, {
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
} from "react";
import axios from "axios";

import Sidebar from "./Sidebar";
import AnalyticsDashboard from "./AnalyticsDashboard";
import { useLanguage } from "../LanguageContext";

import MapContainer from "./map/MapContainer";
import NavigationControls from "./map/NavigationControls";
import NavigationBanner from "./map/NavigationBanner";
import AICopilotWidget from "./copilot/AICopilotWidget";
import { useRouteEngine } from "./map/RouteEngine";
import {
  SpeedGauge,
  SafetyAlertToast,
  SpeedAlertToast,
  SpeedViolationBanner,
  CameraProximityBanner,
  SaherAlertBadge,
  playSoftChime,
  unlockAudio,
} from "./map/SafetyOverlay";
import saherCamerasJson from "../data/saherCameras.json";
import {
  API_BASE,
  RIYADH_CENTER,
  ALERT_PRIORITY,
  SEQUENTIAL_TOAST_DISPLAY_MS,
  TOAST_FADE_OUT_MS,
  TOAST_MAX_WIDTH,
  ROUTE_INCIDENT_RADIUS_KM,
  SPEED_CAMERAS,
  SAFETY_CAMERAS,
  SAHER_PROXIMITY_CAMERAS,
  CAMERA_ALERT_RADIUS_KM,
  SAHER_PROXIMITY_RADIUS_KM,
  ROAD_SPEED_LIMIT_URBAN,
  ROAD_SPEED_LIMIT_HIGHWAY,
  GPS_OPTIONS,
  GPS_MIN_MOVE_METERS,
  OFF_ROUTE_THRESHOLD_METERS,
  REROUTE_DISPLACEMENT_M,
  REROUTE_MIN_INTERVAL_MS,
  SIMULATION_OFFSETS,
  SEVERITY_ORDER,
  TYPE_ORDER,
  SNAP_TO_ROUTE_MAX_DISTANCE_METERS,
  NAVIGATION_FOLLOW_ZOOM,
  NAVIGATION_FOLLOW_OFFSET_Y,
  getMapTheme,
} from "./map/mapConfig";
import {
  haversineDistanceKm,
  isIncidentNearPolyline,
  distanceToPolylineMeters,
  computeBearingDegrees,
  snapPointToPolyline,
  remainingDistanceOnPolylineMeters,
  sliceRouteFromProgress,
} from "./map/geoUtils";

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_INCIDENT_MARKERS = 10;

// ─── API rate-limiting constants ───────────────────────────────────────────────
//
// Each frontend call to /api/traffic causes the backend to fan out ~49 TomTom
// Flow API calls (one per grid point).  Keeping these intervals generous is
// critical to staying within the free-tier daily quota.
//
// TRAFFIC_POLL_INTERVAL_MS     – how often the heatmap is refreshed in the browser.
// TRAFFIC_MIN_REFETCH_GAP_MS   – hard floor between two consecutive traffic fetches;
//                                blocks loop-driven re-fires even if the effect
//                                dependency array somehow changes under StrictMode.
// INCIDENTS_POLL_INTERVAL_MS   – incidents change infrequently; 10 min is plenty.
// HEALTH_POLL_INTERVAL_MS      – backend health only needs checking every 5 min.
// PREDICTION_DEBOUNCE_MS       – delay before firing a prediction fetch on map click
//                                so rapid clicks don't stack up requests.
const TRAFFIC_POLL_INTERVAL_MS   = 5 * 60 * 1000; // 5 minutes
const TRAFFIC_MIN_REFETCH_GAP_MS = 4 * 60 * 1000; // 4-minute hard floor
const INCIDENTS_POLL_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const HEALTH_POLL_INTERVAL_MS    = 5 * 60 * 1000;  // 5 minutes
const PREDICTION_DEBOUNCE_MS     = 1500;            // 1.5 s

// Minimum GPS speed (km/h) — reported OR implicit (distance between two
// consecutive fixes over elapsed time) — that auto-upgrades Drive Mode from
// simulation-locked to real GPS tracking.
//
// Lowered from 5 -> 3 after the field test: many mobile browsers return
// `coords.speed = null` below walking pace, and even at modest traffic-jam
// speeds the reported value hovers around 2-4 km/h.  3 km/h is still above
// the typical stationary GPS drift (≤ 1 km/h implicit) so we don't unlock
// falsely while parked.
const DRIVE_MODE_MIN_SPEED_KMH = 3;
const SUPPORTED_INCIDENT_TYPES = new Set([
  "accident",
  "road closure",
  "heavy traffic",
  "hazard",
  "roadworks",
  "construction",
]);

// ─── Pure helpers ─────────────────────────────────────────────────────────────

const normalizeIncidentType = (incidentType) =>
  typeof incidentType === "string" ? incidentType.trim().toLowerCase() : "";

const isSupportedIncidentType = (incidentType) =>
  SUPPORTED_INCIDENT_TYPES.has(normalizeIncidentType(incidentType));

const hasValidIncidentCoordinates = (incident) =>
  Number.isFinite(Number(incident?.lat)) && Number.isFinite(Number(incident?.lng));

const normalizePredictionAccuracyPercent = (confidence) => {
  if (confidence == null) return null;
  let n =
    typeof confidence === "string"
      ? parseFloat(String(confidence).replace(/%/g, "").trim())
      : Number(confidence);
  if (!Number.isFinite(n)) return null;
  if (n >= 0 && n <= 1) n = Math.round(n * 100);
  else if (n > 1 && n <= 100) n = Math.round(n);
  else {
    while (n > 100) n = Math.round(n / 100);
    n = Math.min(100, Math.max(0, n));
  }
  return Math.min(98, Math.max(85, n));
};

const getTimeOfDay = (hour) => {
  if (hour >= 6  && hour <= 9)  return "morning";
  if (hour >= 16 && hour <= 19) return "rush";
  if (hour >= 22 || hour <= 5)  return "night";
  return "midday";
};

const computeDepartureWindow = (prediction, activeRoute) => {
  if (!prediction) return null;
  const level = prediction.predictedTrafficLevel || prediction.predictedTraffic;
  if (!level) return null;

  const delayMin  = Math.max(0, activeRoute?.trafficDelay || 0);
  const score     = prediction.predictionScore || 0;
  const confidence =
    normalizePredictionAccuracyPercent(prediction.confidence) ?? 85;

  if (level === "high") {
    let minWait = 20 + Math.min(Math.floor(delayMin * 0.5), 10);
    let maxWait = 40 + Math.min(delayMin, 10);
    if (confidence >= 75 && score >= 80) { minWait += 5; maxWait += 5; }
    return { level, minWait: Math.round(minWait), maxWait: Math.round(maxWait), confidence, delayMin };
  }
  if (level === "medium") {
    return { level, minWait: 10, maxWait: 20, confidence, delayMin };
  }
  return { level: "low", minWait: 0, maxWait: 0, confidence, delayMin };
};

const filterIncidentsForDisplay = (incidents, activeRoute, zoomLevel) => {
  if (!incidents || incidents.length === 0) return [];
  const validIncidents = incidents.filter(
    (incident) =>
      isSupportedIncidentType(incident.type) &&
      hasValidIncidentCoordinates(incident)
  );

  if (validIncidents.length === 0) return [];

  let candidates;

  if (activeRoute?.route?.length > 0) {
    candidates = validIncidents.filter((inc) =>
      isIncidentNearPolyline(activeRoute.route, inc, ROUTE_INCIDENT_RADIUS_KM)
    );
  } else if (zoomLevel >= 11) {
    candidates = [...validIncidents];
  } else if (zoomLevel >= 9) {
    candidates = validIncidents.filter(
      (inc) =>
        inc.type === "road closure" ||
        inc.type === "roadworks" ||
        inc.severity === "high"
    );
  } else {
    candidates = [];
  }

  const compareIncidentPriority = (a, b) => {
    const sd = (SEVERITY_ORDER[a.severity] ?? 2) - (SEVERITY_ORDER[b.severity] ?? 2);
    if (sd !== 0) return sd;
    return (TYPE_ORDER[a.type] ?? 4) - (TYPE_ORDER[b.type] ?? 4);
  };

  return [...candidates].sort(compareIncidentPriority).slice(0, MAX_INCIDENT_MARKERS);
};

const sortAlertsForSequentialQueue = (candidates) => {
  const metroTypes = new Set(["park-ride", "metro-alternative"]);
  const parkRide = candidates.filter((c) => c.type === "park-ride");
  const metroAlt = candidates.filter((c) => c.type === "metro-alternative");
  const rest = candidates
    .filter((c) => !metroTypes.has(c.type))
    .sort((a, b) => a.priority - b.priority);
  return [...parkRide, ...metroAlt, ...rest];
};

const buildSimulatedTrafficFrames = (points, prediction) => {
  const baseScore = prediction?.predictionScore ?? 50;
  return SIMULATION_OFFSETS.map((offsetMin, frameIdx) => {
    const variance  = Math.round(Math.sin(offsetMin * 0.08) * 10);
    const frameScore = Math.min(100, Math.max(5, baseScore + variance));
    const improvement = Math.max(0, (baseScore - frameScore) / 100);
    const worsening   = Math.max(0, (frameScore - baseScore) / 100);
    return points.map((point, idx) => {
      const factor = ((idx * 7919 + frameIdx * 1301) % 100) / 100;
      if (improvement > 0.02) {
        if (point.density === "high"   && factor < improvement * 1.8) return { ...point, density: "medium" };
        if (point.density === "medium" && factor < improvement * 0.9) return { ...point, density: "low" };
      } else if (worsening > 0.02) {
        if (point.density === "medium" && factor < worsening * 1.8) return { ...point, density: "high" };
        if (point.density === "low"    && factor < worsening * 0.9) return { ...point, density: "medium" };
      }
      return point;
    });
  });
};

// ─── Toast style constants ────────────────────────────────────────────────────

const TOAST_PAD    = "8px 10px";
const TOAST_RADIUS = 10;
const TOAST_GAP    = 6;
const T_SM  = 11;
const T_MD  = 12;
const T_LBL = 8;

// ─── Inline toast components (tightly coupled to queue logic) ─────────────────

const ToastFadeWrapper = ({ fading, children }) => (
  <div
    style={{
      width: "100%",
      opacity: fading ? 0 : 1,
      transition: `opacity ${TOAST_FADE_OUT_MS}ms ease-out`,
      pointerEvents: fading ? "none" : "auto",
    }}
  >
    {children}
  </div>
);

const DepartureRecommendationCard = ({ recommendation, onDismiss, isRTL, t }) => {
  const isHigh = recommendation.level === "high";
  const isLow  = recommendation.level === "low";
  const borderColor = isLow ? "#22C55E" : isHigh ? "#F97316" : "#F59E0B";
  const accentColor = isLow ? "#BBF7D0" : isHigh ? "#FED7AA" : "#FEF3C7";
  const dimColor    = isLow ? "#166534" : isHigh ? "#C2660A" : "#B38A08";
  const icon        = isLow ? "✅" : isHigh ? "🚦" : "🕐";
  const glassBg     = isLow ? "rgba(6,40,24,0.82)" : isHigh ? "rgba(45,12,10,0.82)" : "rgba(40,28,6,0.82)";
  const titleKey    = isLow ? "departureLowTitle"   : isHigh ? "departureHighTitle"   : "departureMediumTitle";
  const msgKey      = isLow ? "departureLowMsg"     : isHigh ? "departureHighMsg"     : "departureMediumMsg";
  const message     = t(msgKey).replace("{min}", recommendation.minWait).replace("{max}", recommendation.maxWait);

  return (
    <div style={{
      width: "100%", maxWidth: TOAST_MAX_WIDTH,
      background: glassBg, border: `1px solid ${borderColor}55`,
      borderInlineStart: `3px solid ${borderColor}`,
      borderRadius: TOAST_RADIUS, padding: TOAST_PAD,
      boxShadow: `0 2px 16px ${borderColor}28, 0 4px 20px rgba(0,0,0,0.32)`,
      color: accentColor, fontSize: T_SM,
      backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)",
      direction: isRTL ? "rtl" : "ltr",
      animation: "slideInFromTopStack 0.35s ease forwards",
    }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: TOAST_GAP }}>
        <span style={{ fontSize: 15, flexShrink: 0, lineHeight: 1.15 }}>{icon}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: T_LBL, fontWeight: 700, color: borderColor, textTransform: "uppercase", letterSpacing: "0.7px", marginBottom: 2 }}>
            {t("smartNotificationTitle")}
          </div>
          <div style={{ fontWeight: 700, color: "#FFFFFF", marginBottom: 2, fontSize: T_MD, lineHeight: 1.35, wordBreak: "break-word" }}>
            {t(titleKey)}
          </div>
          <div style={{ fontSize: T_SM, color: accentColor, lineHeight: 1.5, wordBreak: "break-word" }}>
            {message}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 5, fontSize: T_LBL + 1, color: dimColor, flexWrap: "wrap" }}>
            <span dir="ltr" style={{ unicodeBidi: "isolate", fontVariantNumeric: "tabular-nums" }}>
              {t("departureConfidenceLabel")}: {recommendation.confidence}%
            </span>
            {recommendation.delayMin > 0 && (
              <span>{t("departureDelayInfo")}: +{recommendation.delayMin} {t("min")}</span>
            )}
          </div>
        </div>
        <button type="button" onClick={onDismiss} aria-label={t("departureDismiss")}
          style={{ background: "transparent", border: "none", color: dimColor, cursor: "pointer", fontSize: 17, flexShrink: 0, padding: 0, lineHeight: 1, transition: "color 0.2s" }}
          onMouseEnter={(e) => { e.currentTarget.style.color = accentColor; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = dimColor; }}
        >×</button>
      </div>
    </div>
  );
};

const ParkAndRideToast = ({ stationNameAr, onDismiss, onStationClick }) => {
  const [stationHovered, setStationHovered] = React.useState(false);
  return (
    <div style={{
      width: "100%", maxWidth: TOAST_MAX_WIDTH,
      background: "rgba(8,14,28,0.82)", backdropFilter: "blur(22px)", WebkitBackdropFilter: "blur(22px)",
      border: "1px solid rgba(99,102,241,0.4)", borderInlineStart: "3px solid #6366F1",
      borderRadius: TOAST_RADIUS, padding: TOAST_PAD,
      boxShadow: "0 2px 16px rgba(99,102,241,0.18), 0 4px 22px rgba(0,0,0,0.36)",
      color: "#E0E7FF", fontSize: T_SM, direction: "rtl",
      animation: "slideInFromTopStack 0.35s cubic-bezier(0.34,1.56,0.64,1) forwards",
      fontFamily: "'Segoe UI', Arial, Tahoma, sans-serif",
    }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: TOAST_GAP }}>
        <span style={{ fontSize: 15, flexShrink: 0, lineHeight: 1 }}>💡</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: T_LBL, fontWeight: 800, color: "#818CF8", textTransform: "uppercase", letterSpacing: "0.9px", marginBottom: 3 }}>
            🚇 تنبيه ذكي · Park &amp; Ride
          </div>
          <div style={{ fontWeight: 600, color: "#FFFFFF", lineHeight: 1.5, fontSize: T_MD }}>
            مسارك مزدحم! نقترح عليك التوجه إلى{" "}
            <button
              onClick={onStationClick}
              onMouseEnter={() => setStationHovered(true)}
              onMouseLeave={() => setStationHovered(false)}
              aria-label={`احسب المسار إلى ${stationNameAr}`}
              style={{
                background: "transparent", border: "none", padding: 0,
                color: stationHovered ? "#C7D2FE" : "#A5B4FC",
                fontWeight: 800, fontSize: T_MD, fontFamily: "inherit", cursor: "pointer",
                textDecoration: stationHovered ? "underline" : "none",
                transition: "color 0.18s", lineHeight: "inherit", verticalAlign: "baseline",
              }}
            >
              {stationNameAr}
            </button>{" "}
            وإكمال طريقك بالمترو لتوفير الوقت.
          </div>
        </div>
        <button onClick={onDismiss} aria-label="إغلاق التنبيه"
          style={{ background: "transparent", border: "none", color: "#475569", cursor: "pointer", fontSize: 17, flexShrink: 0, padding: 0, lineHeight: 1, transition: "color 0.2s" }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "#E0E7FF")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "#475569")}
        >×</button>
      </div>
    </div>
  );
};

const MetroSuggestionBanner = ({ metro, onDismiss, onToggleRoute, routeVisible, isRTL, t, fading = false }) => {
  const stationName = isRTL ? metro.originStation.nameAr : metro.originStation.nameEn;
  const destName    = isRTL ? metro.destStation.nameAr    : metro.destStation.nameEn;
  const lineName    = isRTL ? metro.metroLine.nameAr      : metro.metroLine.nameEn;

  return (
    <div style={{
      width: "100%", maxWidth: TOAST_MAX_WIDTH,
      background: "rgba(8,15,26,0.82)", backdropFilter: "blur(22px)", WebkitBackdropFilter: "blur(22px)",
      border: `1px solid ${metro.metroLine.color}44`, borderInlineStart: `3px solid ${metro.metroLine.color}`,
      borderRadius: TOAST_RADIUS, padding: TOAST_PAD, color: "#E2E8F0",
      boxShadow: `0 2px 16px ${metro.metroLine.color}22, 0 4px 22px rgba(0,0,0,0.38)`,
      direction: isRTL ? "rtl" : "ltr", animation: "slideInFromTopStack 0.35s ease forwards",
      opacity: fading ? 0 : 1, transition: `opacity ${TOAST_FADE_OUT_MS}ms ease-out`,
      pointerEvents: fading ? "none" : "auto",
    }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: TOAST_GAP }}>
        <span style={{ fontSize: 16, flexShrink: 0, lineHeight: 1 }}>🚇</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: T_MD, fontWeight: 700, color: "#fff", marginBottom: 2, lineHeight: 1.35 }}>
            {t("metroFasterOption")}
          </div>
          <div style={{ fontSize: T_SM, color: "#94A3B8", lineHeight: 1.5, wordBreak: "break-word" }}>
            {t("metroDriveToStation").replace("{station}", stationName)}
            {" → "}{lineName}{" → "}{destName}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 5, flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ fontSize: T_MD, fontWeight: 800, color: "#22C55E", display: "flex", alignItems: "center", gap: 3 }}>
              ⏱ {t("metroTimeSaved").replace("{min}", metro.timeSavedMin)}
            </span>
            <span style={{ fontSize: T_SM, color: "#64748B" }}>
              {t("metroTotalTime").replace("{min}", metro.totalTimeMin)}
            </span>
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
            <button onClick={onToggleRoute} style={{
              padding: "4px 10px",
              background: routeVisible ? `${metro.metroLine.color}30` : "rgba(30,41,59,0.80)",
              border: routeVisible ? `1px solid ${metro.metroLine.color}88` : "1px solid #334155",
              borderRadius: 6, color: routeVisible ? metro.metroLine.color : "#94A3B8",
              cursor: "pointer", fontSize: T_LBL + 1, fontWeight: 700, transition: "all 0.2s",
            }}>
              {routeVisible ? t("metroHideRoute") : t("metroShowRoute")}
            </button>
            <button onClick={onDismiss} style={{
              padding: "4px 10px", background: "transparent", border: "1px solid #334155",
              borderRadius: 6, color: "#64748B", cursor: "pointer",
              fontSize: T_LBL + 1, fontWeight: 600, transition: "color 0.2s",
            }}>
              {t("metroDismiss")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

// ─── Navigation ETA / distance dashboard ──────────────────────────────────────
//
// Sleek floating panel shown only while navigation is active.  Sits directly
// above the NavigationControls bottom sheet (hence `bottom: 168`) so the
// driver always sees Remaining Time + Remaining Distance at a glance — the
// same data Google Maps and Waze expose during turn-by-turn.
//
// Props:
//   • remainingDistanceM — remaining distance along the route, in metres.
//   • remainingTimeSec   — remaining travel time, in seconds (traffic-adjusted).
//   • isRTL              — mirror the layout to match the app language.
//   • t                  — translation function (for km / min labels).
//
// Both numeric values are wrapped in `dir="ltr"` spans with the
// `tabular-nums` variant so they never visually reflow when digits grow /
// shrink (e.g. 10 → 9, 100 → 99) — a subtle stability polish you notice
// most when the car is in motion.

const formatRemainingDistance = (remainingDistanceM, kmLabel) => {
  if (!Number.isFinite(remainingDistanceM) || remainingDistanceM < 0) {
    return { valueText: "—", unitText: kmLabel };
  }
  if (remainingDistanceM < 950) {
    return {
      valueText: `${Math.max(0, Math.round(remainingDistanceM))}`,
      unitText: "m",
    };
  }
  const km = remainingDistanceM / 1000;
  const valueText = km < 10 ? km.toFixed(1) : `${Math.round(km)}`;
  return { valueText, unitText: kmLabel };
};

const formatRemainingTime = (remainingTimeSec, minLabel) => {
  if (!Number.isFinite(remainingTimeSec) || remainingTimeSec < 0) {
    return { valueText: "—", unitText: minLabel };
  }
  const minutes = Math.max(0, Math.round(remainingTimeSec / 60));
  if (minutes < 60) {
    return { valueText: `${minutes}`, unitText: minLabel };
  }
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return {
    valueText: remMin === 0 ? `${hours}` : `${hours}:${String(remMin).padStart(2, "0")}`,
    unitText: remMin === 0 ? "h" : "h",
  };
};

// Computes wall-clock arrival time by adding remaining seconds to now.
// Returns a stable object so the column renders "—" gracefully before the
// first GPS fix populates remainingTimeSec.
const formatArrivalTime = (remainingTimeSec) => {
  if (!Number.isFinite(remainingTimeSec) || remainingTimeSec < 0) {
    return { valueText: "—", unitText: "" };
  }
  const arrival  = new Date(Date.now() + remainingTimeSec * 1000);
  const hours24  = arrival.getHours();
  const minutes  = arrival.getMinutes();
  const isPM     = hours24 >= 12;
  const hours12  = hours24 % 12 || 12;
  return {
    valueText: `${hours12}:${String(minutes).padStart(2, "0")}`,
    // Arabic AM/PM markers: ص (Sabahan = morning) / م (Masa' = evening)
    unitText: isPM ? "م" : "ص",
  };
};

// Shared vertical divider between metric columns.
const MetricDivider = () => (
  <div
    aria-hidden="true"
    style={{
      width: 1,
      height: 34,
      flexShrink: 0,
      background:
        "linear-gradient(180deg, transparent, rgba(148,163,184,0.35), transparent)",
    }}
  />
);

const NavEtaDashboard = ({ remainingDistanceM, remainingTimeSec, isRTL, t }) => {
  const distance = formatRemainingDistance(remainingDistanceM, t("km"));
  const time     = formatRemainingTime(remainingTimeSec, t("min"));
  const arrival  = formatArrivalTime(remainingTimeSec);

  // Reduced minWidth (84 → 68) and gap (18 → 10) so the three-column layout
  // fits comfortably inside 92vw on a 375 px iPhone screen without wrapping.
  const metricStyle = {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 3,
    minWidth: 68,
  };
  const valueStyle = {
    fontSize: 20,
    fontWeight: 800,
    lineHeight: 1.05,
    color: "#F8FAFC",
    fontVariantNumeric: "tabular-nums",
    letterSpacing: "0.2px",
    fontFamily: "'Segoe UI', Arial, Tahoma, sans-serif",
  };
  const unitStyle = {
    fontSize: 11,
    fontWeight: 600,
    color: "#94A3B8",
    letterSpacing: "0.4px",
    textTransform: "uppercase",
    lineHeight: 1,
  };
  const labelStyle = {
    fontSize: 9,
    fontWeight: 700,
    color: "#64748B",
    letterSpacing: "0.9px",
    textTransform: "uppercase",
    lineHeight: 1,
    marginTop: 2,
  };
  // Arrival label uses Arabic directly — this panel is Arabic-language navigation UI.
  const arrivalLabelStyle = {
    ...labelStyle,
    color: "#0ea5e9",
    letterSpacing: "0.6px",
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className="nav-eta-dashboard"
      style={{
        position: "fixed",
        left: "50%",
        transform: "translateX(-50%)",
        bottom: 168,
        zIndex: 1199,
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 16px",
        background: "rgba(8, 14, 28, 0.88)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        border: "1px solid rgba(0, 242, 255, 0.22)",
        borderRadius: 999,
        boxShadow:
          "0 10px 36px rgba(0, 0, 0, 0.55), 0 0 24px rgba(0, 242, 255, 0.10), inset 0 1px 0 rgba(255, 255, 255, 0.06)",
        direction: isRTL ? "rtl" : "ltr",
        pointerEvents: "none",
        maxWidth: "min(480px, 96vw)",
      }}
    >
      {/* الوقت المتبقي — Remaining time */}
      <div style={metricStyle}>
        <div dir="ltr" style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
          <span style={valueStyle}>{time.valueText}</span>
          <span style={unitStyle}>{time.unitText}</span>
        </div>
        <span style={labelStyle}>{t("navTimeRemaining")}</span>
      </div>

      <MetricDivider />

      {/* المسافة المتبقية — Remaining distance */}
      <div style={metricStyle}>
        <div dir="ltr" style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
          <span style={valueStyle}>{distance.valueText}</span>
          <span style={unitStyle}>{distance.unitText}</span>
        </div>
        <span style={labelStyle}>{t("navDistanceRemaining")}</span>
      </div>

      <MetricDivider />

      {/* الوصول — Estimated arrival time (wall clock) */}
      <div style={metricStyle}>
        <div dir="ltr" style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
          <span style={valueStyle}>{arrival.valueText}</span>
          <span style={{ ...unitStyle, color: "#38bdf8" }}>{arrival.unitText}</span>
        </div>
        <span style={arrivalLabelStyle}>الوصول</span>
      </div>
    </div>
  );
};

const MapLegend = ({ hasMultipleRoutes }) => {
  const { t } = useLanguage();
  return (
    <div
      className="map-legend"
      style={{
        position: "absolute", bottom: 24, right: 20,
        background: "rgba(8,15,26,0.82)", backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)",
        padding: "14px 18px", borderRadius: 16, boxShadow: "0 12px 36px rgba(0,0,0,0.5)",
        zIndex: 1000, fontSize: 12, color: "#E2E8F0", border: "1px solid rgba(255,255,255,0.08)", minWidth: 160,
      }}
    >
      <div style={{ fontWeight: 800, marginBottom: 12, fontSize: 9, letterSpacing: "1.4px", color: "#475569", textTransform: "uppercase" }}>
        {t("trafficLevels")}
      </div>
      {[
        { color: "#22C55E", labelKey: "low" },
        { color: "#F59E0B", labelKey: "medium" },
        { color: "#EF4444", labelKey: "high" },
      ].map(({ color, labelKey }) => (
        <div key={labelKey} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <div style={{ width: 28, height: 5, background: color, borderRadius: 4, flexShrink: 0, boxShadow: `0 0 8px ${color}66` }} />
          <span style={{ fontSize: 12, color: "#CBD5E1" }}>{t(labelKey)}</span>
        </div>
      ))}

      {hasMultipleRoutes && (
        <>
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid rgba(255,255,255,0.07)", fontWeight: 800, fontSize: 9, letterSpacing: "1.4px", color: "#475569", textTransform: "uppercase", marginBottom: 10 }}>
            {t("routes")}
          </div>
          {[
            { color: "#22C55E", labelKey: "fastestLeast" },
            { color: "#F59E0B", labelKey: "lessTraffic" },
            { color: "#EF4444", labelKey: "mostTraffic" },
          ].map(({ color, labelKey }) => (
            <div key={labelKey} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
              <div style={{ width: 28, height: 4, background: color, borderRadius: 4, flexShrink: 0, boxShadow: `0 0 6px ${color}55` }} />
              <span style={{ fontSize: 11, color: "#CBD5E1" }}>{t(labelKey)}</span>
            </div>
          ))}
        </>
      )}

      <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid rgba(255,255,255,0.07)", fontSize: 10, color: "#475569", display: "flex", alignItems: "center", gap: 6 }}>
        <span>🔥</span> {t("heatmapLegend")}
      </div>
    </div>
  );
};

const SimulationStatusBar = ({ frame, isRTL, t, onStop }) => {
  const frameLabels = SIMULATION_OFFSETS.map((min) =>
    min === 0 ? t("nowLabel") : t("afterMinLabel").replace("{min}", min)
  );
  const progressPct = Math.round(((frame + 1) / SIMULATION_OFFSETS.length) * 100);

  return (
    <div className="simulation-status-bar" style={{
      position: "absolute", bottom: 90, left: "50%", transform: "translateX(-50%)",
      background: "rgba(8,15,26,0.96)", backdropFilter: "blur(18px)", WebkitBackdropFilter: "blur(18px)",
      border: "1px solid rgba(99,102,241,0.45)", borderRadius: 16, padding: "13px 18px",
      zIndex: 1002, color: "#E2E8F0", fontSize: 13, display: "flex", flexDirection: "column",
      gap: 9, minWidth: 280, maxWidth: "calc(90vw - 40px)",
      boxShadow: "0 8px 32px rgba(99,102,241,0.25)",
      direction: isRTL ? "rtl" : "ltr", animation: "slideInFromTop 0.3s ease forwards",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 16 }}>🎬</span>
          <span style={{ fontWeight: 700, color: "#A5B4FC", fontSize: 13 }}>{t("simulationRunning")}</span>
        </div>
        <button onClick={onStop} 
          style={{
            background: "rgba(30,41,59,0.80)", border: "1px solid #334155", borderRadius: 8,
            color: "#94A3B8", cursor: "pointer", padding: "4px 10px", fontSize: 11, fontWeight: 600, transition: "background 0.2s, color 0.2s",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(239,68,68,0.15)"; e.currentTarget.style.color = "#FCA5A5"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(30,41,59,0.80)"; e.currentTarget.style.color = "#94A3B8"; }}
        >
          {t("stopSimulation")}
        </button>
      </div>
      <div style={{ fontSize: 12, color: "#C7D2FE", fontWeight: 600 }}>{frameLabels[frame] || frameLabels[0]}</div>
      <div style={{ height: 4, background: "#1E293B", borderRadius: 2, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${progressPct}%`, background: "linear-gradient(90deg,#6366F1,#8B5CF6)", borderRadius: 2, transition: "width 0.5s ease" }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        {SIMULATION_OFFSETS.map((min, idx) => (
          <div key={min} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
            <div style={{
              width: idx <= frame ? 10 : 8, height: idx <= frame ? 10 : 8, borderRadius: "50%",
              background: idx <= frame ? "#8B5CF6" : "#1E293B",
              border: idx === frame ? "2px solid #A5B4FC" : "1px solid #334155",
              transition: "all 0.4s ease", boxShadow: idx === frame ? "0 0 8px #8B5CF6" : "none",
            }} />
            <span style={{ fontSize: 8, color: idx <= frame ? "#8B5CF6" : "#334155" }}>
              {min === 0 ? t("nowLabel").slice(0, 4) : `+${min}`}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

// ─── Locate Me Button ─────────────────────────────────────────────────────────
//
// Floating action button that snaps the map camera to the user's current GPS
// position.  Completely self-contained — receives only onClick and isLocating.
// Uses onMouseEnter/onMouseLeave for hover effects (Tailwind isn't compiled).

const LocateMeButton = ({ onClick, isLocating }) => {
  const [hovered, setHovered] = React.useState(false);

  const borderColor = hovered
    ? "rgba(96,165,250,0.75)"
    : "rgba(96,165,250,0.28)";
  const shadow = hovered
    ? "0 0 22px rgba(59,130,246,0.45), 0 4px 20px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.08)"
    : "0 4px 18px rgba(0,0,0,0.48), inset 0 1px 0 rgba(255,255,255,0.06)";
  const iconStroke = hovered ? "#93C5FD" : "#60A5FA";

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-label="Locate me on map"
      title="Locate Me"
      className="locate-me-btn"
      style={{
        // fixed anchors to the viewport, breaking out of every Leaflet stacking
        // context so the button is never swallowed by map tile layers.
        position: "fixed",
        bottom: 175,
        left: 20,
        zIndex: 9999,
        width: 50,
        height: 50,
        borderRadius: "50%",
        background: "rgba(8, 15, 26, 0.82)",
        backdropFilter: "blur(18px)",
        WebkitBackdropFilter: "blur(18px)",
        border: `1.5px solid ${borderColor}`,
        boxShadow: shadow,
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        transform: hovered ? "scale(1.1)" : "scale(1)",
        transition:
          "transform 0.18s cubic-bezier(0.34,1.56,0.64,1), box-shadow 0.2s ease, border-color 0.2s ease",
        outline: "none",
      }}
    >
      {isLocating ? (
        /* Spinning arc while GPS is resolving */
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="9" stroke="rgba(96,165,250,0.22)" strokeWidth="2.5" />
          <path
            d="M12 3a9 9 0 0 1 9 9"
            stroke="#60A5FA"
            strokeWidth="2.5"
            strokeLinecap="round"
            style={{ animation: "spinCenter 0.8s linear infinite", transformOrigin: "center" }}
          />
        </svg>
      ) : (
        /* Crosshair / sniper icon */
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke={iconStroke}
          strokeWidth="2"
          strokeLinecap="round"
        >
          <circle
            cx="12"
            cy="12"
            r="3"
            fill={hovered ? "rgba(147,197,253,0.22)" : "rgba(96,165,250,0.1)"}
            stroke={iconStroke}
            strokeWidth="2"
          />
          <line x1="12" y1="2"  x2="12" y2="7"  />
          <line x1="12" y1="17" x2="12" y2="22" />
          <line x1="2"  y1="12" x2="7"  y2="12" />
          <line x1="17" y1="12" x2="22" y2="12" />
        </svg>
      )}
    </button>
  );
};

// ─── Heading-Up Toggle (compass FAB, navigation only) ─────────────────────────
//
// Floats above the LocateMeButton during active navigation.  Clicking it
// flips the map between heading-up (the default — entire map rotates so the
// road ahead points to the top of the screen, like Google Maps in driving
// mode) and north-up (legacy behaviour where only the chevron rotates).
//
// Two visual states:
//   • headingUp = true  → solid compass with "N" rotated by `navBearing` so the
//     "N" tip visibly points to true north — tells the driver the map IS
//     rotated and where north has gone.
//   • headingUp = false → upright compass with the "N" pinned at 12 o'clock
//     and a dimmer accent — tells the driver the map is north-up.
//
// Self-contained: receives only the current state and a toggle callback, no
// app-wide state coupling.

const HeadingUpToggleButton = ({ headingUp, navBearing, onToggle }) => {
  const [hovered, setHovered] = React.useState(false);

  const accentColor = headingUp ? "#60A5FA" : "#94A3B8";
  const accentStrong = headingUp ? "#93C5FD" : "#CBD5E1";
  const borderColor = hovered
    ? headingUp ? "rgba(96,165,250,0.75)" : "rgba(148,163,184,0.55)"
    : headingUp ? "rgba(96,165,250,0.32)" : "rgba(148,163,184,0.22)";
  const shadow = hovered
    ? "0 0 22px rgba(59,130,246,0.40), 0 4px 20px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.08)"
    : "0 4px 18px rgba(0,0,0,0.48), inset 0 1px 0 rgba(255,255,255,0.06)";
  // While heading-up is on, the SVG counter-rotates so the "N" still points
  // to true north on screen even though the map underneath has rotated.
  const compassRotation = headingUp ? -navBearing : 0;

  return (
    <button
      onClick={onToggle}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-label={headingUp ? "Switch to north-up" : "Switch to heading-up"}
      title={headingUp ? "Heading-Up (tap for North-Up)" : "North-Up (tap for Heading-Up)"}
      className="heading-up-btn"
      style={{
        position: "fixed",
        bottom: 235,
        left: 20,
        zIndex: 9999,
        width: 50,
        height: 50,
        borderRadius: "50%",
        background: "rgba(8, 15, 26, 0.82)",
        backdropFilter: "blur(18px)",
        WebkitBackdropFilter: "blur(18px)",
        border: `1.5px solid ${borderColor}`,
        boxShadow: shadow,
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        transform: hovered ? "scale(1.1)" : "scale(1)",
        transition:
          "transform 0.18s cubic-bezier(0.34,1.56,0.64,1), box-shadow 0.2s ease, border-color 0.2s ease",
        outline: "none",
      }}
    >
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        style={{
          transform: `rotate(${compassRotation}deg)`,
          transition: "transform 0.25s linear",
        }}
        aria-hidden="true"
      >
        <circle
          cx="12"
          cy="12"
          r="9.5"
          stroke={hovered ? accentStrong : accentColor}
          strokeWidth="1.5"
          fill="rgba(15,23,42,0.4)"
        />
        {/* North needle (red-tinted) */}
        <path
          d="M12 4 L14 12 L12 11 L10 12 Z"
          fill={headingUp ? "#F87171" : "#94A3B8"}
        />
        {/* South needle (accent-tinted) */}
        <path
          d="M12 20 L10 12 L12 13 L14 12 Z"
          fill={hovered ? accentStrong : accentColor}
        />
        <text
          x="12"
          y="6.4"
          textAnchor="middle"
          fontSize="4"
          fontWeight="700"
          fill={headingUp ? accentStrong : "#E2E8F0"}
        >
          N
        </text>
      </svg>
    </button>
  );
};

// ─── Audio ────────────────────────────────────────────────────────────────────

// Audio is played via playSoftChime (Web Audio API) imported from SafetyOverlay.
// The set of alert types that should trigger the chime.
const SAFETY_AUDIO_TYPES = new Set(["camera", "seatbelt", "speed-exceeded"]);

// ─── Saher (speed) cameras dataset ───────────────────────────────────────────
//
// Frozen at module load from frontend/src/data/saherCameras.json (populated
// by scripts/enrichSaherData.js).  No live API calls are issued during
// navigation — strict guardrail from the product brief.  Defensive filtering
// drops any malformed entries up-front so the GPS hot-loop can assume each
// camera has finite coordinates and a finite speed limit.
const SAHER_CAMERAS = (Array.isArray(saherCamerasJson) ? saherCamerasJson : [])
  .filter(
    (cam) =>
      cam &&
      Number.isFinite(cam.lat) &&
      Number.isFinite(cam.lng) &&
      Number.isFinite(cam.speedLimit)
  );

// ─── TrafficMap ───────────────────────────────────────────────────────────────

const TrafficMap = () => {
  const { t, isRTL } = useLanguage();

  // ─── Stable map action ref (populated by MapContainer via onMapReady) ──────
  const mapActionsRef = useRef(null);

  const onMapReady = useCallback((actions) => {
    mapActionsRef.current = actions;
  }, []);

  const onMapFitBounds = useCallback((bounds, opts) => {
    mapActionsRef.current?.fitBounds(bounds, opts);
  }, []);

  // ─── Map theme state ──────────────────────────────────────────────────────
  // Lazy-initialised from getMapTheme(); kept in sync by MapContainer's
  // onThemeChange callback so sibling components react to day/night switches.
  const [mapTheme, setMapTheme] = useState(() => getMapTheme());

  // ─── Map center state ─────────────────────────────────────────────────────
  // Updated on every Leaflet `moveend` event so the Sidebar can bias its
  // Foursquare search toward the area the user is currently viewing.
  const [mapCenter, setMapCenter] = useState(RIYADH_CENTER);

  const handleMapCenterChange = useCallback((center) => {
    setMapCenter(center);
  }, []);

  // ─── Coordinate & interaction state ───────────────────────────────────────
  const [userLocation, setUserLocation]       = useState(null);
  const [startCoords, setStartCoords]         = useState(null);
  const [endCoords, setEndCoords]             = useState(null);
  const [clickMode, setClickMode]             = useState("start");
  const [destinationText, setDestinationText] = useState("");
  const [currentZoom, setCurrentZoom]         = useState(11);
  const [mapFocusTarget, setMapFocusTarget]   = useState(null);

  // ─── Data state ────────────────────────────────────────────────────────────
  const [trafficPoints, setTrafficPoints] = useState([]);
  const [lastUpdated, setLastUpdated]     = useState(null);
  const [error, setError]                 = useState(null);
  const [incidents, setIncidents]         = useState([]);
  const [prediction, setPrediction]       = useState(null);
  const [predictionLoading, setPredictionLoading] = useState(false);
  const [backendOnline, setBackendOnline] = useState(true);

  // ─── Navigation state ──────────────────────────────────────────────────────
  const navWatchIdRef          = useRef(null);
  const isNavigatingRef        = useRef(false);
  const nearCameraIdRef        = useRef(null);
  const navCameraAlertTimerRef = useRef(null);
  const lastGpsPositionRef     = useRef(null);
  // Stores the full camera object for the camera currently within 500 m so that
  // the banner can render its type-specific UI (speed limit, camera type).
  const nearCameraDataRef      = useRef(null);
  // Tracks which camera IDs have already triggered a voice announcement this
  // journey.  Using a Set (not just a single-ID ref) ensures alerts fire once
  // per camera even when the driver passes through multiple camera zones.
  const alertedCameraIdsRef    = useRef(new Set());
  // ─── Saher (speed-camera) 400 m proximity engine ──────────────────────────
  // Mirrors the legacy 500 m engine pattern but is fed exclusively from the
  // pre-enriched saherCameras.json dataset.  Two refs guarantee the chime
  // fires EXACTLY ONCE per camera per journey:
  //   activeSaherIdRef    — id of the camera the driver is *currently* inside.
  //                         Drives enter / exit transitions on every GPS tick.
  //   chimedSaherIdsRef   — a Set of camera ids that have already chimed in
  //                         this navigation session.  Re-entering the same
  //                         400 m zone after a brief exit will NOT re-chime,
  //                         which matches Google Maps / Waze behaviour.
  const activeSaherIdRef    = useRef(null);
  const chimedSaherIdsRef   = useRef(new Set());
  // Tracks whether Drive Mode has unlocked from simulation-locked to real GPS.
  // Flips to true when GPS detects movement > DRIVE_MODE_MIN_SPEED_KMH, when
  // the device has displaced > REROUTE_DISPLACEMENT_M from the route origin,
  // or when the user manually taps "تفعيل التتبع الحي".
  const isLiveTrackingRef      = useRef(false);

  // Refs consumed by the watchPosition closure.  They mirror state that can
  // change WHILE navigation is active (route data, destination, bearing)
  // so the long-lived closure never reads a stale value.
  const activeRouteRef     = useRef(null);
  const endCoordsRef       = useRef(null);
  const routeOriginRef     = useRef(null);
  const prevFixRef         = useRef(null); // { coords: [lat, lng], ts: number }
  const isReroutingRef     = useRef(false);
  const lastRerouteAtRef   = useRef(0);
  const navBearingRef      = useRef(0);
  // Monotonic ratchet for the snap-to-route projection.  Holds the highest
  // route segment index the driver has reached so far this journey, and is
  // forwarded to snapPointToPolyline as `minSegmentIndex`.  Without this,
  // the global-nearest projection can flip to the wrong leg of a U-turn or
  // hairpin (snapping you onto the outbound lane while you're already on
  // the return leg), which freezes the displayRoutes slice and produces the
  // "overlapping line at the U-turn" rendering bug.  Reset to 0 in
  // handleStartNavigation / handleExitNavigation so each journey starts
  // fresh; rerouting replaces activeRoute entirely so the index naturally
  // realigns with the new polyline.
  const lastSegmentIndexRef = useRef(0);

  const [isNavigating, setIsNavigating]           = useState(false);
  const [isMapCentered, setIsMapCentered]         = useState(true);
  const [navSpeed, setNavSpeed]                   = useState(0);
  const [navCameraAlertVisible, setNavCameraAlertVisible] = useState(false);
  // Full camera object for the camera currently within the 500 m alert zone.
  // Passed to CameraProximityBanner so it can render type-specific UI.
  const [nearCameraData, setNearCameraData]       = useState(null);
  // Saher 400 m radar state.  `activeSaherCamera` carries the camera the
  // driver is currently approaching ({ id, lat, lng, speedLimit }) along with
  // a live `distanceMeters` field refreshed on every GPS tick.  `null` when
  // the driver is outside every camera's 400 m zone.
  // `saherBadgeExiting` plays the slide-out animation for ~280 ms before the
  // badge is fully unmounted, so leaving the zone never feels abrupt.
  const [activeSaherCamera, setActiveSaherCamera] = useState(null);
  const [saherBadgeExiting, setSaherBadgeExiting] = useState(false);
  const saherExitTimerRef = useRef(null);
  const [isLiveTracking, setIsLiveTracking]       = useState(false);
  const [isLocateMeActive, setIsLocateMeActive]   = useState(false);

  // ─── API-call guards ────────────────────────────────────────────────────────
  // Prevent concurrent or loop-driven duplicate requests.
  const lastTrafficFetchRef        = useRef(0);
  const isTrafficFetchInFlightRef  = useRef(false);
  // Timer ref for debouncing fetchPrediction on map click.
  const predictionDebounceTimerRef = useRef(null);

  // Drives the rotation of the stealth-arrow user marker.  Updated from
  // `coords.heading` when available, else computed from consecutive GPS
  // fixes via computeBearingDegrees().
  const [navBearing, setNavBearing] = useState(0);

  // Heading-up camera mode.  When true (the default during navigation), the
  // map's bearing tracks `navBearing` so the road ahead always points to the
  // top of the screen — Google Maps' default driving framing.  When false,
  // the map stays north-up and only the chevron icon rotates (the legacy
  // behaviour).  Drivers can toggle this from the compass FAB rendered while
  // navigating.  Reset to `true` on every navigation start so the next
  // journey opens in heading-up mode regardless of the previous selection.
  const [headingUp, setHeadingUp] = useState(true);

  // True while a silent auto-reroute is in flight.  Drives the small Arabic
  // "جارِ إعادة حساب المسار..." indicator docked below the NavigationBanner.
  const [isRerouting, setIsRerouting] = useState(false);

  // ─── Live ETA / distance dashboard state ───────────────────────────────────
  //
  // Remaining time is derived from remainingDistance / totalDistance scaled
  // against the active route's traffic-adjusted travelTimeInSeconds.  Both
  // are set to `null` while no active route is mounted so the dashboard can
  // defensively render an em-dash rather than misleading "0 km / 0 min".
  const [navRemainingDistanceM, setNavRemainingDistanceM] = useState(null);
  const [navRemainingTimeSec, setNavRemainingTimeSec]     = useState(null);

  // ─── Forward-only route slicing progress ───────────────────────────────────
  //
  // Mirrors the projection computed during snap-to-route on every GPS tick so
  // the Polyline component can render ONLY the road ahead of the chevron
  // (Google-Maps-style hide-trailing-route).  `segmentIndex` identifies which
  // [route[i] → route[i+1]] segment the driver is currently on; `snapped` is
  // the exact lat/lng on that segment where the chevron renders.
  //
  // CRITICAL: this is a RENDERING-ONLY derivative — the full, original route
  // continues to live in `activeRoute.route` / `activeRouteRef.current.route`
  // so ETA, off-route detection, and reroute logic are unaffected.
  //
  // `null` while in preview / pre-movement so the full route stays visible
  // until the driver physically starts moving.
  const [navProgress, setNavProgress] = useState(null);

  // Tracks whether the dynamic follow-camera has already performed its
  // initial auto-zoom to NAVIGATION_FOLLOW_ZOOM for the current journey.
  // Resetting to `false` on start/exit ensures the next journey auto-zooms
  // again; NOT resetting on every GPS tick preserves the driver's ability
  // to pinch-zoom out to survey the map without the camera fighting them.
  const hasAutoZoomedRef = useRef(false);

  // ─── Turn-by-turn guidance state ───────────────────────────────────────────
  // navStepIndexRef mirrors navStepIndex as a ref so the watchPosition closure
  // can read and write the current step without capturing a stale value.
  const navStepIndexRef   = useRef(0);
  const lastSpokenStepRef = useRef(-1);
  const voiceEnabledRef   = useRef(true);

  const [navStepIndex, setNavStepIndex] = useState(0);
  const [voiceEnabled, setVoiceEnabled] = useState(true);

  // ─── Smart departure ───────────────────────────────────────────────────────
  const [showSmartDeparturePanel, setShowSmartDeparturePanel] = useState(false);

  // ─── Meeting Point ─────────────────────────────────────────────────────────
  const [meetingMidpoint, setMeetingMidpoint]         = useState(null);
  const [meetingPlaces, setMeetingPlaces]             = useState([]);
  // Participant origin pins — updated live as each Sidebar input resolves a location.
  const [meetingParticipants, setMeetingParticipants] = useState([]);

  // ─── Mobile sidebar toggle ─────────────────────────────────────────────────
  // Open by default on desktop; collapsed on mobile so the map is visible
  // immediately and the user can pull up the bottom sheet when needed.
  const [isSidebarOpen, setIsSidebarOpen] = useState(
    () => typeof window !== "undefined" && window.innerWidth > 768
  );

  // ─── GPS permission error toast ────────────────────────────────────────────
  const [gpsErrorToastVisible, setGpsErrorToastVisible] = useState(false);
  const [gpsErrorToastDismissing, setGpsErrorToastDismissing] = useState(false);
  const gpsToastTimerRef = useRef(null);

  const showGpsErrorToast = useCallback(() => {
    clearTimeout(gpsToastTimerRef.current);
    setGpsErrorToastDismissing(false);
    setGpsErrorToastVisible(true);
    // Auto-dismiss after 6 seconds with a fade-out
    gpsToastTimerRef.current = setTimeout(() => {
      setGpsErrorToastDismissing(true);
      setTimeout(() => setGpsErrorToastVisible(false), 350);
    }, 6000);
  }, []);

  // Cleanup GPS toast timer on unmount.
  useEffect(() => () => clearTimeout(gpsToastTimerRef.current), []);

  // ─── Screen Wake Lock ──────────────────────────────────────────────────────
  //
  // Keeps the device screen on during active navigation so the map stays
  // visible while driving.  Gracefully no-ops in browsers that don't support
  // the Wake Lock API (Firefox for Android, older Safari).
  //
  // The browser automatically releases the lock when the page becomes hidden
  // (user switches tabs or presses the home button).  We reacquire it on
  // `visibilitychange` so navigation resumes correctly when the user returns.
  const wakeLockRef = useRef(null);

  const acquireWakeLock = useCallback(async () => {
    if (!("wakeLock" in navigator)) return;
    try {
      wakeLockRef.current = await navigator.wakeLock.request("screen");
      wakeLockRef.current.addEventListener("release", () => {
        // Nullify our ref so we know a new request is needed on next visibility.
        wakeLockRef.current = null;
      });
    } catch (err) {
      // NotAllowedError fires if the page is hidden at the moment of the call;
      // DOMException may occur on unsupported browsers — both are safe to ignore.
      console.warn("[WakeLock] request failed:", err.message);
    }
  }, []);

  const releaseWakeLock = useCallback(() => {
    if (wakeLockRef.current) {
      wakeLockRef.current.release().catch(() => {});
      wakeLockRef.current = null;
    }
  }, []);

  // Reacquire the lock whenever the page becomes visible again during navigation.
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible" && isNavigatingRef.current) {
        acquireWakeLock();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [acquireWakeLock]);

  // Always release the lock when the component unmounts.
  useEffect(() => () => releaseWakeLock(), [releaseWakeLock]);

  // ─── Arabic voice guidance (Web Speech API) ────────────────────────────────
  //
  // Speaks Arabic turn-by-turn instructions using the browser's native TTS.
  // Uses a ref for voiceEnabled so the watchPosition closure always reads the
  // latest toggle state without needing to re-register the geolocation watcher.

  const speakInstruction = useCallback((text) => {
    if (!voiceEnabledRef.current || !window.speechSynthesis || !text) return;
    // Cancel any utterance already in progress before speaking the next one.
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "ar-SA";
    utterance.rate = 0.92;
    utterance.pitch = 1;
    window.speechSynthesis.speak(utterance);
  }, []);

  const handleToggleVoice = useCallback(() => {
    setVoiceEnabled((prev) => {
      const next = !prev;
      voiceEnabledRef.current = next;
      // If muting, stop any speech that is currently playing.
      if (!next) window.speechSynthesis?.cancel();
      return next;
    });
  }, []);

  // ─── Simulation ────────────────────────────────────────────────────────────
  const [simulationActive, setSimulationActive] = useState(false);
  const [simulationFrame, setSimulationFrame]   = useState(0);
  const simulatedFramesRef = useRef([]);
  const simulationTimerRef = useRef(null);

  // ─── Safety alert queue ────────────────────────────────────────────────────
  const [safetyAlerts, setSafetyAlerts]         = useState([]);
  const [toastQueue, setToastQueue]             = useState([]);
  const [activeToastFading, setActiveToastFading] = useState(false);
  const lastSafetyAudioToastRef = useRef(null);

  // ─── Route engine ──────────────────────────────────────────────────────────

  const checkBackendHealth = useCallback(async () => {
    console.log("API CALL MADE: /health");
    try {
      await axios.get(`${API_BASE}/health`, { timeout: 5000 });
      setBackendOnline(true);
      return true;
    } catch (_err) {
      setBackendOnline(false);
      return false;
    }
  }, []);

  const fetchIncidents = useCallback(async (lat, lng) => {
    console.log("API CALL MADE: /api/incidents");
    try {
      const res = await axios.get(`${API_BASE}/api/incidents`, {
        params: { lat, lng, radius: 50 },
        timeout: 10000,
      });
      setIncidents(res.data);
    } catch (err) {
      console.error("[incidents] fetch error:", err.message);
    }
  }, []);

  const fetchPrediction = useCallback(async (lat, lng) => {
    console.log("API CALL MADE: /api/traffic-prediction");
    const timeOfDay = getTimeOfDay(new Date().getHours());
    setPredictionLoading(true);
    try {
      const res = await axios.get(`${API_BASE}/api/traffic-prediction`, {
        params: { lat, lng, timeOfDay },
        timeout: 8000,
      });
      setPrediction(res.data);
    } catch (err) {
      console.error("[prediction] fetch error:", err.message);
    } finally {
      setPredictionLoading(false);
    }
  }, []);

  const {
    routeResponse,
    activeRouteIndex,
    routeLoading,
    routeError,
    allRoutes,
    activeRoute,
    routeOriginCoords,
    navigationLockedPosition,
    navigationMode,
    cameraCountOnRoute,
    incidentCountOnRoute,
    reconBannerDismissed,
    // setReconBannerDismissed,
    alertDismissed,
    setAlertDismissed,
    departureDismissed,
    setDepartureDismissed,
    metroAlternative,
    metroDismissed,
    setMetroDismissed,
    metroRouteVisible,
    setMetroRouteVisible,
    parkRideStation,
    parkRideDismissed,
    setParkRideDismissed,
    handleRecommendRoute,
    handleClearRoute: handleClearRouteBase,
    handleRouteSelect,
    handleSwitchToAlternative,
    handleParkAndRideStationClick,
    handleMetroMarkerClick,
    // fetchMetroAlternative,
    rerouteFromLivePosition,
  } = useRouteEngine({
    startCoords,
    userLocation,
    endCoords,
    destinationText,
    isRTL,
    t,
    prediction,
    isNavigating,
    isLiveTracking,
    incidents,
    checkBackendHealth,
    fetchIncidents,
    fetchPrediction,
    onStartCoordsChange: setStartCoords,
    onEndCoordsChange: setEndCoords,
    onDestinationTextChange: setDestinationText,
    onMapFitBounds,
  });

  // Keep refs used by the long-lived watchPosition closure synced with the
  // latest values.  Without these the closure would read whatever
  // `activeRoute` / `endCoords` / `routeOriginCoords` held at Start time —
  // which goes stale the moment a silent reroute replaces the polyline.
  useEffect(() => {
    activeRouteRef.current = activeRoute;
    // A new polyline (initial route or a silent reroute that replaced it)
    // invalidates the monotonic snap ratchet — the segment indices belong
    // to the OLD line.  Resetting to 0 lets the next GPS tick re-anchor on
    // the new polyline; the ratchet will start climbing again from there.
    lastSegmentIndexRef.current = 0;
  }, [activeRoute]);

  useEffect(() => {
    endCoordsRef.current = endCoords;
  }, [endCoords]);

  useEffect(() => {
    routeOriginRef.current = routeOriginCoords;
  }, [routeOriginCoords]);

  // When a silent reroute replaces the active polyline mid-journey, seed the
  // ETA dashboard with the NEW route's full length / time immediately — so
  // the driver sees accurate numbers without waiting for the next GPS tick
  // (which could be several seconds away at urban speeds).  The subsequent
  // tick refines the values based on the user's exact projection onto the
  // new polyline.
  useEffect(() => {
    if (!isNavigatingRef.current) return;
    if (activeRoute?.lengthInMeters != null) {
      setNavRemainingDistanceM(Math.max(0, activeRoute.lengthInMeters));
    }
    if (activeRoute?.travelTimeInSeconds != null) {
      setNavRemainingTimeSec(Math.max(0, activeRoute.travelTimeInSeconds));
    }
    // Clear forward-slice progress against the OLD polyline so the next GPS
    // tick recomputes it against the new reroute.  Without this, the driver
    // would briefly see the line sliced at a stale segment index (the old
    // route's geometry) before the next fix lands.
    setNavProgress(null);
  }, [activeRoute]);

  const handleClearRoute = useCallback(() => {
    // If the user clears while actively navigating, perform a full navigation
    // teardown first (stop GPS watcher, release wake lock, reset nav state).
    if (isNavigatingRef.current) {
      if (navWatchIdRef.current !== null) {
        navigator.geolocation.clearWatch(navWatchIdRef.current);
        navWatchIdRef.current = null;
      }
      if (navCameraAlertTimerRef.current) {
        clearTimeout(navCameraAlertTimerRef.current);
        navCameraAlertTimerRef.current = null;
      }
      isLiveTrackingRef.current = false;
      lastGpsPositionRef.current = null;
      nearCameraIdRef.current = null;
      setIsLiveTracking(false);
      setNavCameraAlertVisible(false);
      setNavSpeed(0);
      setIsNavigating(false);
      setIsMapCentered(true);

      // Rerouting / bearing refs — see handleExitNavigation for parity.
      prevFixRef.current       = null;
      isReroutingRef.current   = false;
      lastRerouteAtRef.current = 0;
      navBearingRef.current    = 0;
      hasAutoZoomedRef.current = false;
      setIsRerouting(false);
      setNavBearing(0);
      setNavRemainingDistanceM(null);
      setNavRemainingTimeSec(null);
      setNavProgress(null);

      // Stop voice guidance and reset step state.
      window.speechSynthesis?.cancel();
      navStepIndexRef.current   = 0;
      lastSpokenStepRef.current = -1;
      setNavStepIndex(0);
      releaseWakeLock();
    }

    handleClearRouteBase(() => {
      setSafetyAlerts([]);
      setToastQueue([]);
      setActiveToastFading(false);
    });
    setClickMode("start");
    fetchPrediction(RIYADH_CENTER[0], RIYADH_CENTER[1]);
  }, [handleClearRouteBase, fetchPrediction, releaseWakeLock]);

  // When the Sidebar resolves a meeting-point search, fly the map to the midpoint
  // and store the results so MapContainer can render the venue markers.
  const handleMeetingPointResult = useCallback((midpoint, places) => {
    setMeetingMidpoint(midpoint ?? null);
    setMeetingPlaces(places ?? []);
    if (midpoint && mapActionsRef.current) {
      mapActionsRef.current.flyTo(
        [midpoint.lat, midpoint.lon],
        14,
        { animate: true, duration: 1.1 }
      );
    }
  }, []);

  // Called by Sidebar whenever a participant's confirmed location changes so
  // MapContainer can render a colored origin pin for each resolved participant.
  const handleMeetingParticipantsChange = useCallback((participants) => {
    setMeetingParticipants(participants ?? []);
  }, []);

  // ─── Derived values ────────────────────────────────────────────────────────

  const filteredIncidents = useMemo(
    () => filterIncidentsForDisplay(incidents, activeRoute, currentZoom),
    [incidents, activeRoute, currentZoom]
  );

  // Map markers must never include raw traffic flow points.
  const mapIncidents = useMemo(
    () =>
      (incidents || []).filter(
        (incident) =>
          isSupportedIncidentType(incident.type) &&
          hasValidIncidentCoordinates(incident)
      ),
    [incidents]
  );

  const incidentsOnRoute = useMemo(() => {
    if (!activeRoute?.route?.length || filteredIncidents.length === 0) return false;
    return filteredIncidents.some((inc) =>
      isIncidentNearPolyline(activeRoute.route, inc, ROUTE_INCIDENT_RADIUS_KM)
    );
  }, [activeRoute, filteredIncidents]);

  const roadClosureIncidents = useMemo(
    () => (incidents || []).filter((inc) => inc.type === "road closure"),
    [incidents]
  );

  const closureAvoidedPerRoute = useMemo(() => {
    if (!allRoutes.length || !roadClosureIncidents.length) return [];
    return allRoutes.map((route) => {
      if (!route.route?.length) return false;
      return !roadClosureIncidents.some((inc) =>
        isIncidentNearPolyline(route.route, inc, ROUTE_INCIDENT_RADIUS_KM)
      );
    });
  }, [allRoutes, roadClosureIncidents]);

  const departureRecommendation = useMemo(
    () => computeDepartureWindow(prediction, activeRoute),
    [prediction, activeRoute]
  );

  const showDepartureCard = departureRecommendation !== null && !departureDismissed;

  const displayStart = startCoords || userLocation;

  // Route speed limit — long routes are likely on highways.
  const roadSpeedLimit = useMemo(() => {
    if (!activeRoute) return ROAD_SPEED_LIMIT_URBAN;
    return activeRoute.distance > 15
      ? ROAD_SPEED_LIMIT_HIGHWAY
      : ROAD_SPEED_LIMIT_URBAN;
  }, [activeRoute]);

  // ─── Forward-only rendered routes (Google-Maps-style trailing hide) ───────
  //
  // Clones `allRoutes` and replaces the ACTIVE route's `route` field with a
  // forward-only slice starting exactly at the driver's snapped location.
  // Inactive alternatives pass through untouched.
  //
  // Why this lives in TrafficMap (not MapContainer):
  //   • MapContainer is a presentational layer and must not know about
  //     GPS projection internals — it just draws whatever coordinates it
  //     receives.  Keeping the derivation here preserves separation of
  //     concerns and keeps the component tree easy to test.
  //
  // Why it does NOT touch `allRoutes` identity when slicing is a no-op:
  //   • Returning the original reference when there's nothing to slice
  //     preserves memoisation in MapContainer and avoids rerendering the
  //     static Polyline(s) on every GPS tick.
  //
  // GUARDRAILS:
  //   • The original `activeRoute.route` is NEVER mutated — we shallow-clone
  //     the route object and replace ONLY its `route` field.  Every other
  //     field (`lengthInMeters`, `travelTimeInSeconds`, `guidance`, ...)
  //     is preserved by reference so downstream consumers (NavEtaDashboard,
  //     NavigationBanner, geofencing) see the same data they always have.
  //   • `activeRouteRef.current` inside the GPS callback continues to hold
  //     the untouched object from the route engine, so ETA / off-route /
  //     reroute calculations are unaffected.
  const displayRoutes = useMemo(() => {
    if (
      !isNavigating ||
      !isLiveTracking ||
      !navProgress ||
      activeRouteIndex == null ||
      activeRouteIndex < 0 ||
      !Array.isArray(allRoutes) ||
      allRoutes.length === 0
    ) {
      return allRoutes;
    }

    const activeRouteObj = allRoutes[activeRouteIndex];
    const fullRoute = activeRouteObj?.route;
    if (!Array.isArray(fullRoute) || fullRoute.length < 2) {
      return allRoutes;
    }

    const slicedRoute = sliceRouteFromProgress(
      fullRoute,
      navProgress.segmentIndex,
      navProgress.snapped
    );

    // Defensive no-op guard: if the slice is identical (same reference) to
    // the original or is shorter than 2 points (line degenerates), skip
    // re-cloning the outer array to keep Polyline memo stable.
    if (slicedRoute === fullRoute || slicedRoute.length < 2) {
      return allRoutes;
    }

    return allRoutes.map((routeObj, index) =>
      index === activeRouteIndex
        ? { ...routeObj, route: slicedRoute }
        : routeObj
    );
  }, [allRoutes, activeRouteIndex, isNavigating, isLiveTracking, navProgress]);

  // ─── Sequential notification queue ────────────────────────────────────────

  const eligibleSequentialAlerts = useMemo(() => {
    const candidates = [];
    if (parkRideStation && !parkRideDismissed) {
      candidates.push({ id: "park-ride", priority: ALERT_PRIORITY["park-ride"], type: "park-ride" });
    }
    if (metroAlternative?.suggested && !metroDismissed && !simulationActive) {
      candidates.push({ id: "metro-alternative", priority: ALERT_PRIORITY["metro-alternative"], type: "metro-alternative" });
    }
    if (showDepartureCard && departureRecommendation) {
      candidates.push({ id: "departure", priority: ALERT_PRIORITY.departure, type: "departure" });
    }
    safetyAlerts.forEach((sa) => {
      candidates.push({ id: sa.id, priority: ALERT_PRIORITY[sa.type] ?? 99, type: sa.type });
    });
    return sortAlertsForSequentialQueue(candidates);
  }, [
    parkRideStation, parkRideDismissed,
    metroAlternative?.suggested, metroDismissed, simulationActive,
    showDepartureCard, departureRecommendation, safetyAlerts,
  ]);

  const activeToastId = toastQueue[0] ?? null;

  const activeSequentialAlert = useMemo(
    () => (activeToastId ? eligibleSequentialAlerts.find((a) => a.id === activeToastId) ?? null : null),
    [activeToastId, eligibleSequentialAlerts]
  );

  const sidebarMetroBannerFading =
    activeToastId === "metro-alternative" && activeToastFading;

  // ─── Data fetching ─────────────────────────────────────────────────────────

  // Holds the latest `t` so fetchTraffic can call it without listing it as a
  // dependency — preventing a re-render of LanguageProvider from triggering a
  // fresh traffic fetch.
  const tRef = useRef(t);
  useEffect(() => { tRef.current = t; }, [t]);

  const fetchTraffic = useCallback(async () => {
    // Guard 1: block if a request is already in flight (prevents overlapping
    // calls from React StrictMode double-mount or rapid effect re-fires).
    if (isTrafficFetchInFlightRef.current) return;
    // Guard 2: enforce a minimum gap between consecutive calls regardless of
    // how the timer fires.  Primary defence against any accidental re-fire.
    if (Date.now() - lastTrafficFetchRef.current < TRAFFIC_MIN_REFETCH_GAP_MS) return;

    isTrafficFetchInFlightRef.current = true;
    lastTrafficFetchRef.current = Date.now();
    console.log("FRONTEND CALLING BACKEND");
    try {
      const res = await axios.get(`${API_BASE}/api/traffic`, { timeout: 15000 });
      setTrafficPoints(res.data.points);
      setLastUpdated(res.data.updatedAt);
      setError(null);
      setBackendOnline(true);
    } catch (err) {
      console.error("[traffic] fetch error:", err.message);
      if (err.code === "ERR_NETWORK" || err.code === "ECONNREFUSED") {
        setBackendOnline(false);
      }
      setError(tRef.current("errorNetworkFailed"));
    } finally {
      isTrafficFetchInFlightRef.current = false;
    }
  // No dependency on `t` — tRef.current always holds the latest value without
  // causing this callback (and therefore the effect below) to be recreated.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Traffic is fetched once on mount, then on a strict 5-minute timer.
  // The dependency array is intentionally [] — map moves, zooms, rotations,
  // and any other state changes must NEVER trigger a traffic re-fetch.
  useEffect(() => {
    fetchTraffic();
    const intervalId = setInterval(fetchTraffic, TRAFFIC_POLL_INTERVAL_MS);
    return () => clearInterval(intervalId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    fetchIncidents(RIYADH_CENTER[0], RIYADH_CENTER[1]);
    // Incidents change infrequently; 10-minute refresh is sufficient.
    const id = setInterval(
      () => fetchIncidents(RIYADH_CENTER[0], RIYADH_CENTER[1]),
      INCIDENTS_POLL_INTERVAL_MS
    );
    return () => clearInterval(id);
  }, [fetchIncidents]);

  useEffect(() => {
    fetchPrediction(RIYADH_CENTER[0], RIYADH_CENTER[1]);
  }, [fetchPrediction]);

  useEffect(() => {
    checkBackendHealth();
    // Health check every 5 minutes is enough to detect backend restarts.
    const id = setInterval(checkBackendHealth, HEALTH_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [checkBackendHealth]);

  // Clear the prediction debounce timer on unmount so it never fires after
  // the component is gone.
  useEffect(() => () => clearTimeout(predictionDebounceTimerRef.current), []);

  useEffect(() => {
    if (!navigator.geolocation) return;
    // Use the same high-accuracy GPS_OPTIONS as the navigation watcher so the
    // app's first fix lands on the GNSS chip, not the WiFi/cell-tower fallback
    // that would otherwise plant the chevron several blocks off.
    navigator.geolocation.getCurrentPosition(
      (pos) => setUserLocation([pos.coords.latitude, pos.coords.longitude]),
      () => setUserLocation(null),
      GPS_OPTIONS
    );
  }, []);

  useEffect(() => {
    isNavigatingRef.current = isNavigating;
  }, [isNavigating]);

  // Auto-collapse the bottom-sheet sidebar on mobile when navigation is active
  // so the map takes up the full screen.  Restore it when navigation ends.
  useEffect(() => {
    if (window.innerWidth > 768) return;
    setIsSidebarOpen(!isNavigating);
  }, [isNavigating]);

  // ─── Navigation handlers ───────────────────────────────────────────────────

  const handleStartNavigation = useCallback(() => {
    // Lift iOS Safari / Chrome for Android autoplay restriction.
    // This runs inside a button-click handler — a genuine user gesture —
    // which is the only context where browsers permit AudioContext.resume().
    unlockAudio();

    setIsNavigating(true);
    setIsMapCentered(true);
    acquireWakeLock();

    // Reset turn-by-turn guidance to step 0 for this journey.
    navStepIndexRef.current   = 0;
    lastSpokenStepRef.current = -1;
    setNavStepIndex(0);

    // Speak the first instruction immediately so the driver hears it on departure.
    const firstStep = activeRoute?.guidance?.[0];
    if (firstStep?.text) {
      // Small delay lets the UI settle before TTS fires.
      setTimeout(() => speakInstruction(firstStep.text), 600);
    }

    // Start in simulation-locked (Recon→Drive) mode — the chevron renders at
    // the route origin until the hybrid unlock below promotes to live GPS.
    isLiveTrackingRef.current = false;
    setIsLiveTracking(false);

    // Reset per-journey navigation refs consumed by the watchPosition closure.
    prevFixRef.current        = null;
    isReroutingRef.current    = false;
    lastRerouteAtRef.current  = 0;
    navBearingRef.current     = 0;
    lastSegmentIndexRef.current = 0;
    hasAutoZoomedRef.current  = false;
    setIsRerouting(false);
    setNavBearing(0);
    // Default every new journey to heading-up mode regardless of how the
    // previous trip ended (matches Google Maps' default driving framing).
    setHeadingUp(true);
    // Start the journey with the FULL route visible — `navProgress` is
    // populated on the first GPS tick after Drive Mode unlocks, so the
    // preview polyline stays intact until the driver physically moves.
    setNavProgress(null);

    // Seed the ETA dashboard with the full route distance / time so the
    // panel shows correct values the instant "انطلق" is pressed — before
    // the first GPS fix arrives and refines them.
    if (activeRoute?.lengthInMeters != null) {
      setNavRemainingDistanceM(Math.max(0, activeRoute.lengthInMeters));
    } else {
      setNavRemainingDistanceM(null);
    }
    if (activeRoute?.travelTimeInSeconds != null) {
      setNavRemainingTimeSec(Math.max(0, activeRoute.travelTimeInSeconds));
    } else {
      setNavRemainingTimeSec(null);
    }

    // Clear camera alert history so every new journey re-announces cameras.
    alertedCameraIdsRef.current.clear();
    nearCameraIdRef.current  = null;
    nearCameraDataRef.current = null;
    setNearCameraData(null);
    setNavCameraAlertVisible(false);

    // Reset the Saher 400 m radar so every new journey re-chimes its cameras.
    chimedSaherIdsRef.current.clear();
    activeSaherIdRef.current = null;
    if (saherExitTimerRef.current !== null) {
      clearTimeout(saherExitTimerRef.current);
      saherExitTimerRef.current = null;
    }
    setActiveSaherCamera(null);
    setSaherBadgeExiting(false);

    // Anchor the chevron and camera at the route's first polyline coordinate
    // (the cyan line's origin), not the device's physical GPS position.
    // This allows previewing the full navigation UI — speedometer, dark mode,
    // alerts — exactly as it will look at the actual departure point.
    const routeOrigin = activeRoute?.route?.[0];
    if (routeOrigin) {
      // Immediately set userLocation so MapContainer renders the chevron here.
      setUserLocation(routeOrigin);
      // Seed the GPS dedup ref so that the first watchPosition callback
      // only moves the chevron if the device physically travels further
      // than GPS_MIN_MOVE_METERS from the route origin.
      lastGpsPositionRef.current = routeOrigin;
      routeOriginRef.current     = routeOrigin;
      // Fly the camera to the departure point at street-level zoom, shifted
      // so the chevron sits in the lower-middle of the viewport to match the
      // dynamic follow-camera framing used during driving.
      const actions = mapActionsRef.current;
      if (actions && typeof actions.setViewOffset === "function") {
        actions.setViewOffset(
          routeOrigin,
          NAVIGATION_FOLLOW_ZOOM,
          NAVIGATION_FOLLOW_OFFSET_Y,
          { animate: true, duration: 0.9 }
        );
      } else {
        actions?.flyTo(routeOrigin, NAVIGATION_FOLLOW_ZOOM, { animate: true, duration: 0.9 });
      }
    }

    // Begin watching real GPS so the chevron follows the device once it moves.
    if (!navigator.geolocation) return;
    navWatchIdRef.current = navigator.geolocation.watchPosition(
      (p) => {
        const rawFix = [p.coords.latitude, p.coords.longitude];
        const nowTs = typeof p.timestamp === "number" ? p.timestamp : Date.now();

        // ── Map matching (snap-to-route) ──────────────────────────────────
        // If the raw GPS fix is within SNAP_TO_ROUTE_MAX_DISTANCE_METERS of
        // the active polyline, replace it with the projected point so the
        // chevron renders EXACTLY on the line — mirroring the behaviour of
        // Google Maps / Waze where the vehicle never drifts into the
        // shoulder due to GNSS noise.
        //
        // Snapping runs BEFORE the movement-delta filter below so a fresh
        // snap-in (e.g. GPS jitters the marker back onto the road) still
        // propagates to the UI even when the raw fix is < 5 m from the
        // previous raw fix.
        const routeForMatching = activeRouteRef.current?.route;
        const snapResult =
          routeForMatching && routeForMatching.length >= 2
            ? snapPointToPolyline(
                rawFix[0],
                rawFix[1],
                routeForMatching,
                SNAP_TO_ROUTE_MAX_DISTANCE_METERS,
                // Forward-only (monotonic) projection: never let the snap
                // jump backward to a segment behind the highest one we've
                // already reached.  Critical for U-turns / hairpins where
                // the global-nearest projection would otherwise oscillate
                // between the two legs of the fold.
                { minSegmentIndex: lastSegmentIndexRef.current }
              )
            : { coords: rawFix, snapped: false, projection: null };

        const next = snapResult.coords;

        // GPS optimization: skip update if device hasn't moved MIN distance.
        // Checked against the *previous accepted* fix (lastGpsPositionRef).
        if (lastGpsPositionRef.current) {
          const movedKmFromPrev = haversineDistanceKm(
            lastGpsPositionRef.current[0],
            lastGpsPositionRef.current[1],
            next[0],
            next[1]
          );
          if (movedKmFromPrev * 1000 < GPS_MIN_MOVE_METERS) return;
        }

        // ── Hybrid Drive Mode unlock ──────────────────────────────────────
        // The original implementation relied on `coords.speed >= 5 km/h` which
        // fails on devices where `speed` is null or under-reported at traffic-
        // jam pace.  We now unlock on ANY of:
        //   • reported speed      ≥ DRIVE_MODE_MIN_SPEED_KMH
        //   • computed speed      ≥ DRIVE_MODE_MIN_SPEED_KMH (distance / time)
        //   • displacement from origin > REROUTE_DISPLACEMENT_M
        const prevFix = prevFixRef.current;
        const dtSec = prevFix
          ? Math.max(0.001, (nowTs - prevFix.ts) / 1000)
          : 0;
        const movedMFromPrev = prevFix
          ? haversineDistanceKm(
              prevFix.coords[0], prevFix.coords[1], next[0], next[1]
            ) * 1000
          : 0;
        const implicitSpeedKmh = dtSec > 0 ? (movedMFromPrev / dtSec) * 3.6 : 0;
        const reportedSpeedKmh =
          p.coords.speed != null && p.coords.speed >= 0
            ? p.coords.speed * 3.6
            : 0;
        const movedFromOriginM = routeOriginRef.current
          ? haversineDistanceKm(
              routeOriginRef.current[0],
              routeOriginRef.current[1],
              next[0],
              next[1]
            ) * 1000
          : Infinity;

        if (
          isNavigatingRef.current &&
          !isLiveTrackingRef.current &&
          (
            reportedSpeedKmh >= DRIVE_MODE_MIN_SPEED_KMH ||
            implicitSpeedKmh >= DRIVE_MODE_MIN_SPEED_KMH ||
            movedFromOriginM > REROUTE_DISPLACEMENT_M
          )
        ) {
          isLiveTrackingRef.current = true;
          setIsLiveTracking(true);
        }

        // Pre-unlock: the chevron must stay pinned to the route origin so
        // Recon preview is stable.  We still seed `prevFixRef` so the next
        // iteration can compute an implicit speed delta.
        if (isNavigatingRef.current && !isLiveTrackingRef.current) {
          prevFixRef.current = { coords: next, ts: nowTs };
          return;
        }

        lastGpsPositionRef.current = next;

        // ── Marker follows real GPS from here on ──────────────────────────
        setUserLocation(next);

        // ── Forward-only route slicing progress ───────────────────────────
        // Reuse the projection we already have (from snap-to-route above) so
        // the Polyline can slice the original route starting exactly at the
        // chevron.  Keep the previous value when `projection` is null so the
        // line never briefly jumps back to the full route on a bad fix.
        //
        // NOTE: we read from `snapResult.projection` — which ALSO exists when
        // the driver is off-route (> SNAP_TO_ROUTE_MAX_DISTANCE_METERS).  In
        // that case the slice still begins at the nearest polyline point,
        // which is the correct visual: the remaining work to resync with the
        // route is immediately obvious.  The off-route detector below is
        // unaffected because it reads `snapResult.projection.distanceMeters`
        // independently.
        if (snapResult.projection) {
          // Ratchet the per-journey segment cursor monotonically forward.
          // The next GPS tick uses this as `minSegmentIndex` to keep the
          // U-turn snap pinned to the leg we're actually driving on.
          if (
            snapResult.projection.segmentIndex >
            lastSegmentIndexRef.current
          ) {
            lastSegmentIndexRef.current = snapResult.projection.segmentIndex;
          }
          setNavProgress({
            snapped: snapResult.projection.snapped,
            segmentIndex: snapResult.projection.segmentIndex,
          });
        }

        // ── Bearing / heading (drives the stealth-arrow rotation) ─────────
        // Prefer the browser-supplied heading when finite; otherwise compute
        // a great-circle bearing between the previous and current fix.  Only
        // update the state ref when the delta is noticeable (>= 2 degrees)
        // to avoid excessive re-renders from GPS noise while stationary-ish.
        let nextBearing = navBearingRef.current;
        if (Number.isFinite(p.coords.heading)) {
          nextBearing = p.coords.heading;
        } else if (prevFix && movedMFromPrev >= GPS_MIN_MOVE_METERS) {
          nextBearing = computeBearingDegrees(
            prevFix.coords[0], prevFix.coords[1], next[0], next[1]
          );
        }
        if (
          Number.isFinite(nextBearing) &&
          Math.abs(((nextBearing - navBearingRef.current + 540) % 360) - 180) >= 2
        ) {
          navBearingRef.current = nextBearing;
          setNavBearing(nextBearing);
        }

        // Real-time speedometer: speed is in m/s per the Geolocation API spec.
        const rawSpeedMs = p.coords.speed;
        const isMoving   = rawSpeedMs != null && rawSpeedMs >= 1;
        setNavSpeed(isMoving ? Math.round(rawSpeedMs * 3.6) : 0);

        // ── Camera proximity alert — 500 m zone ──────────────────────────
        // Finds the nearest camera within CAMERA_ALERT_RADIUS_KM (0.5 km).
        // Dedup strategy uses two layers:
        //   1. nearCameraIdRef   — prevents banner flickering when the driver
        //      stays in the same camera zone across consecutive GPS ticks.
        //   2. alertedCameraIdsRef — a Set that ensures the Arabic voice
        //      announcement fires at most ONCE per camera per journey, even if
        //      the driver re-enters the zone after briefly leaving it.
        const nearbyCamera = SAHER_PROXIMITY_CAMERAS.find(
          (cam) =>
            haversineDistanceKm(next[0], next[1], cam.coords[0], cam.coords[1]) <=
            CAMERA_ALERT_RADIUS_KM
        );
        const nearbyCameraId = nearbyCamera?.id ?? null;

        if (nearbyCameraId !== nearCameraIdRef.current) {
          nearCameraIdRef.current  = nearbyCameraId;
          nearCameraDataRef.current = nearbyCamera ?? null;
          setNearCameraData(nearbyCamera ?? null);

          if (navCameraAlertTimerRef.current) {
            clearTimeout(navCameraAlertTimerRef.current);
            navCameraAlertTimerRef.current = null;
          }

          if (nearbyCameraId) {
            setNavCameraAlertVisible(true);
            navCameraAlertTimerRef.current = setTimeout(() => {
              setNavCameraAlertVisible(false);
              navCameraAlertTimerRef.current = null;
            }, 10000);

            // Voice + chime: announce ONCE per camera ID per journey.
            if (!alertedCameraIdsRef.current.has(nearbyCameraId)) {
              alertedCameraIdsRef.current.add(nearbyCameraId);
              playSoftChime();

              const isMobileOrBelt =
                nearbyCamera.type === "mobile" || nearbyCamera.type === "belt";

              if (isMobileOrBelt) {
                speakInstruction(
                  "انتبه، كاميرا مراقبة حزام وجوال أمامك."
                );
              } else {
                const limitPhrase =
                  nearbyCamera.speedLimit != null
                    ? `السرعة المحددة هي ${nearbyCamera.speedLimit} كيلومتر في الساعة.`
                    : "";
                speakInstruction(
                  `انتبه، كاميرا مراقبة سرعة أمامك بعد ٥٠٠ متر. ${limitPhrase}`.trim()
                );
              }
            }
          } else {
            setNavCameraAlertVisible(false);
          }
        }

        // ── Saher 400 m radar (JSON-driven, single chime per camera) ──────
        // Walks SAHER_CAMERAS once per tick and tracks the closest camera
        // whose distance is ≤ SAHER_PROXIMITY_RADIUS_KM.  Three guarantees:
        //   1. Single chime per camera per journey  (chimedSaherIdsRef Set)
        //   2. No duplicate badge re-mounts          (activeSaherIdRef latch)
        //   3. Graceful 280 ms slide-out on exit     (saherExitTimerRef)
        //
        // No remote calls — speed-limit data is baked into SAHER_CAMERAS at
        // module load.  This satisfies the "no live API during navigation"
        // guardrail in the product brief.
        if (SAHER_CAMERAS.length > 0) {
          let closestSaher = null;
          let closestSaherDistanceKm = Infinity;
          for (const cam of SAHER_CAMERAS) {
            const dKm = haversineDistanceKm(next[0], next[1], cam.lat, cam.lng);
            if (dKm <= SAHER_PROXIMITY_RADIUS_KM && dKm < closestSaherDistanceKm) {
              closestSaher = cam;
              closestSaherDistanceKm = dKm;
            }
          }

          const inZoneNow = closestSaher !== null;
          const inZoneId  = closestSaher?.id ?? null;

          if (inZoneNow) {
            // ENTER (or switch to a closer camera): show badge + chime once.
            if (activeSaherIdRef.current !== inZoneId) {
              activeSaherIdRef.current = inZoneId;

              // Cancel any pending exit animation — we're back in a zone.
              if (saherExitTimerRef.current !== null) {
                clearTimeout(saherExitTimerRef.current);
                saherExitTimerRef.current = null;
              }
              setSaherBadgeExiting(false);

              // Single-fire chime: reuse the existing playSoftChime helper
              // imported from SafetyOverlay (the project's existing camera
              // notification sound — no new audio path is introduced).
              if (!chimedSaherIdsRef.current.has(inZoneId)) {
                chimedSaherIdsRef.current.add(inZoneId);
                playSoftChime();
              }
            }

            setActiveSaherCamera({
              ...closestSaher,
              distanceMeters: Math.round(closestSaherDistanceKm * 1000),
            });
          } else if (activeSaherIdRef.current !== null) {
            // EXIT: was inside a zone last tick, now clear of every camera.
            // Play the slide-out animation, then unmount after 280 ms.
            activeSaherIdRef.current = null;
            setSaherBadgeExiting(true);
            if (saherExitTimerRef.current !== null) {
              clearTimeout(saherExitTimerRef.current);
            }
            saherExitTimerRef.current = setTimeout(() => {
              setActiveSaherCamera(null);
              setSaherBadgeExiting(false);
              saherExitTimerRef.current = null;
            }, 280);
          }
        }

        // ── Turn-by-turn step advancement ─────────────────────────────────
        // When the device moves within 60 m of the next maneuver's GPS point,
        // advance the step counter and speak the new Arabic instruction.
        // Reading from activeRouteRef keeps the check correct after a silent
        // reroute replaces the polyline mid-journey.
        const currentRoute = activeRouteRef.current;
        const guidance = currentRoute?.guidance ?? [];
        const nextStepIdx = navStepIndexRef.current + 1;
        if (nextStepIdx < guidance.length) {
          const nextPt = guidance[nextStepIdx].point;
          if (nextPt) {
            const distToNextMeters =
              haversineDistanceKm(next[0], next[1], nextPt[0], nextPt[1]) * 1000;
            if (distToNextMeters <= 60) {
              navStepIndexRef.current = nextStepIdx;
              setNavStepIndex(nextStepIdx);
              if (lastSpokenStepRef.current !== nextStepIdx) {
                lastSpokenStepRef.current = nextStepIdx;
                speakInstruction(guidance[nextStepIdx].text);
              }
            }
          }
        }

        // ── Live ETA / remaining-distance dashboard ───────────────────────
        // Reuse the polyline projection we already computed during snapping
        // so we don't pay for another full-polyline scan.  Remaining time is
        // proportional to remaining distance against the full route's
        // traffic-adjusted travelTimeInSeconds, so traffic reality (not just
        // geometry) is reflected.  On reroute, activeRouteRef updates first
        // → the very next GPS tick will compute ETA against the NEW route.
        if (currentRoute?.route?.length >= 2) {
          const totalMeters =
            currentRoute.lengthInMeters ?? null;
          let remainingM;
          if (snapResult.projection && currentRoute === activeRouteRef.current) {
            // Fast path: reuse the projection we already computed above
            // (matches the polyline we're currently navigating on).
            const [segEndLat, segEndLng] =
              currentRoute.route[snapResult.projection.segmentIndex + 1] ?? [];
            if (Number.isFinite(segEndLat) && Number.isFinite(segEndLng)) {
              let acc =
                haversineDistanceKm(
                  snapResult.projection.snapped[0],
                  snapResult.projection.snapped[1],
                  segEndLat,
                  segEndLng
                ) * 1000;
              for (
                let i = snapResult.projection.segmentIndex + 1;
                i < currentRoute.route.length - 1;
                i++
              ) {
                const [aLat, aLng] = currentRoute.route[i];
                const [bLat, bLng] = currentRoute.route[i + 1];
                acc += haversineDistanceKm(aLat, aLng, bLat, bLng) * 1000;
              }
              remainingM = Math.max(0, acc);
            } else {
              remainingM = remainingDistanceOnPolylineMeters(
                rawFix[0],
                rawFix[1],
                currentRoute.route
              );
            }
          } else {
            remainingM = remainingDistanceOnPolylineMeters(
              rawFix[0],
              rawFix[1],
              currentRoute.route
            );
          }
          setNavRemainingDistanceM(Math.round(remainingM));

          if (
            Number.isFinite(totalMeters) &&
            totalMeters > 0 &&
            Number.isFinite(currentRoute.travelTimeInSeconds)
          ) {
            const fraction = Math.min(1, Math.max(0, remainingM / totalMeters));
            setNavRemainingTimeSec(
              Math.round(currentRoute.travelTimeInSeconds * fraction)
            );
          }
        }

        // ── Off-route detection + guarded silent reroute ──────────────────
        // Use the RAW GPS fix (not the snapped coord) so snapping never
        // masks a genuine deviation — otherwise every input would appear
        // to be "on route" and this check would never fire.
        const routePts = currentRoute?.route;
        const destination = endCoordsRef.current;
        if (
          routePts?.length > 1 &&
          destination &&
          !isReroutingRef.current &&
          nowTs - lastRerouteAtRef.current > REROUTE_MIN_INTERVAL_MS
        ) {
          const distToRouteM = snapResult.projection
            ? snapResult.projection.distanceMeters
            : distanceToPolylineMeters(rawFix[0], rawFix[1], routePts);
          if (distToRouteM > OFF_ROUTE_THRESHOLD_METERS) {
            isReroutingRef.current   = true;
            lastRerouteAtRef.current = nowTs;
            setIsRerouting(true);
            // Send the RAW GPS origin plus the driver's current bearing so
            // TomTom builds a FORWARD-moving route (take the next exit etc.)
            // rather than suggesting a U-turn back onto the old polyline.
            Promise.resolve(
              rerouteFromLivePosition(rawFix, navBearingRef.current)
            )
              .catch(() => undefined)
              .finally(() => {
                isReroutingRef.current = false;
                setIsRerouting(false);
                // A fresh polyline implies a brand-new maneuver list; reset
                // the turn-by-turn step counter so DEPART speaks first.
                navStepIndexRef.current   = 0;
                lastSpokenStepRef.current = -1;
                setNavStepIndex(0);
              });
          }
        }

        // Record this fix as "previous" for the next callback iteration.
        prevFixRef.current = { coords: next, ts: nowTs };

        // ── Dynamic follow camera ─────────────────────────────────────────
        // While tracking is locked AND the map is still centred, keep the
        // chevron framed in the lower-middle of the viewport.  On the first
        // fix where the driver has clearly started moving, also auto-zoom
        // to NAVIGATION_FOLLOW_ZOOM (18) so the city-wide preview is
        // replaced with a street-level follow camera — just like Google
        // Maps / Waze.  `hasAutoZoomedRef` prevents the zoom from
        // overriding any subsequent user pinch-zoom within the same
        // journey.
        const effectiveSpeedKmh = Math.max(reportedSpeedKmh, implicitSpeedKmh);
        const shouldAutoZoom =
          !hasAutoZoomedRef.current &&
          isLiveTrackingRef.current &&
          effectiveSpeedKmh >= DRIVE_MODE_MIN_SPEED_KMH;

        setIsMapCentered((centred) => {
          if (centred && mapActionsRef.current) {
            const actions = mapActionsRef.current;
            if (shouldAutoZoom && typeof actions.setViewOffset === "function") {
              hasAutoZoomedRef.current = true;
              actions.setViewOffset(
                next,
                NAVIGATION_FOLLOW_ZOOM,
                NAVIGATION_FOLLOW_OFFSET_Y,
                { animate: true, duration: 0.8 }
              );
            } else if (typeof actions.setViewOffset === "function") {
              const currentZoom =
                typeof actions.getZoom === "function"
                  ? actions.getZoom()
                  : NAVIGATION_FOLLOW_ZOOM;
              actions.setViewOffset(
                next,
                currentZoom,
                NAVIGATION_FOLLOW_OFFSET_Y,
                { animate: true, duration: 0.4 }
              );
            } else {
              // Fallback for environments where the map ref hasn't exposed
              // setViewOffset yet — still keeps the chevron in view.
              actions.panTo(next, { animate: true, duration: 0.4 });
            }
          }
          return centred;
        });
      },
      () => { /* silent — GPS may be temporarily unavailable */ },
      GPS_OPTIONS
    );
  }, [activeRoute, acquireWakeLock, speakInstruction, rerouteFromLivePosition]);

  const handleExitNavigation = useCallback(() => {
    // Stop GPS watcher.
    if (navWatchIdRef.current !== null) {
      navigator.geolocation.clearWatch(navWatchIdRef.current);
      navWatchIdRef.current = null;
    }
    if (navCameraAlertTimerRef.current) {
      clearTimeout(navCameraAlertTimerRef.current);
      navCameraAlertTimerRef.current = null;
    }
    isLiveTrackingRef.current  = false;
    setIsLiveTracking(false);
    lastGpsPositionRef.current  = null;
    nearCameraIdRef.current     = null;
    nearCameraDataRef.current   = null;
    alertedCameraIdsRef.current.clear();
    setNearCameraData(null);
    setNavCameraAlertVisible(false);
    setNavSpeed(0);
    setIsNavigating(false);
    setIsMapCentered(true);

    // Tear down the Saher 400 m radar — clear the in-zone latch, the
    // single-fire history, the pending exit-animation timer, and the
    // visible badge so the next journey starts from a clean slate.
    if (saherExitTimerRef.current !== null) {
      clearTimeout(saherExitTimerRef.current);
      saherExitTimerRef.current = null;
    }
    activeSaherIdRef.current = null;
    chimedSaherIdsRef.current.clear();
    setActiveSaherCamera(null);
    setSaherBadgeExiting(false);

    // Reset rerouting / bearing state so the next navigation session starts
    // from a clean slate rather than inheriting the previous journey's refs.
    prevFixRef.current          = null;
    isReroutingRef.current      = false;
    lastRerouteAtRef.current    = 0;
    navBearingRef.current       = 0;
    lastSegmentIndexRef.current = 0;
    hasAutoZoomedRef.current    = false;
    setIsRerouting(false);
    setNavBearing(0);
    setNavRemainingDistanceM(null);
    setNavRemainingTimeSec(null);
    setNavProgress(null);

    // Stop any Arabic voice that is still playing and reset step counters.
    window.speechSynthesis?.cancel();
    navStepIndexRef.current   = 0;
    lastSpokenStepRef.current = -1;
    setNavStepIndex(0);

    // Release screen wake lock now that the user is no longer driving.
    releaseWakeLock();

    if (activeRoute?.route?.length >= 2) {
      try {
        const L = require("leaflet");
        const bounds = L.latLngBounds(activeRoute.route);
        mapActionsRef.current?.fitBounds(bounds, { padding: [60, 60], maxZoom: 14, animate: true });
      } catch (_err) { /* ignore degenerate bounds */ }
    }
  }, [activeRoute, releaseWakeLock]);

  const handleReCenter = useCallback(() => {
    if (!userLocation) return;
    const actions = mapActionsRef.current;
    // During active navigation re-centre with the lower-middle offset so the
    // chevron lands in the same framing the follow camera uses.  Outside of
    // navigation we just fly to the user's pin at street-level zoom.
    if (isNavigatingRef.current && actions && typeof actions.setViewOffset === "function") {
      actions.setViewOffset(
        userLocation,
        NAVIGATION_FOLLOW_ZOOM,
        NAVIGATION_FOLLOW_OFFSET_Y,
        { animate: true, duration: 0.7 }
      );
    } else {
      actions?.flyTo(userLocation, NAVIGATION_FOLLOW_ZOOM, { animate: true, duration: 0.7 });
    }
    setIsMapCentered(true);
    // Mark auto-zoom as satisfied so we don't re-zoom aggressively on the
    // very next GPS tick after the user explicitly re-centred.
    hasAutoZoomedRef.current = true;
  }, [userLocation]);

  // "Locate Me" — requests a fresh one-shot GPS fix, updates the user location
  // marker (unless navigation is active, which owns that state), and flies the
  // camera to the resolved coordinates at street-level zoom.
  const handleLocateMe = useCallback(() => {
    if (!navigator.geolocation) {
      showGpsErrorToast();
      return;
    }
    setIsLocateMeActive(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const coords = [pos.coords.latitude, pos.coords.longitude];
        // Navigation's watchPosition owns userLocation while isNavigating is true.
        if (!isNavigating) {
          setUserLocation(coords);
        }
        mapActionsRef.current?.flyTo(coords, 16, { animate: true, duration: 1.2 });
        setIsLocateMeActive(false);
      },
      (err) => {
        setIsLocateMeActive(false);
        // PERMISSION_DENIED (1) or POSITION_UNAVAILABLE (2) — show Arabic guidance toast.
        if (err.code === 1 || err.code === 2 || !userLocation) {
          showGpsErrorToast();
        } else {
          // Timed-out but we have a last-known position — fly there silently.
          mapActionsRef.current?.flyTo(userLocation, 16, { animate: true, duration: 1.0 });
        }
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
    );
  }, [isNavigating, userLocation, showGpsErrorToast]);

  // Manual "Live Tracking" toggle — user explicitly switches from route-origin
  // lock to real GPS tracking regardless of detected movement speed.
  const handleEnableLiveTracking = useCallback(() => {
    if (!isNavigating) return;
    isLiveTrackingRef.current = true;
    setIsLiveTracking(true);
    setIsMapCentered(true);
    // Manual unlock performs its own auto-zoom, so flag the auto-zoom ref as
    // satisfied to prevent the GPS loop from firing a redundant fly-to on
    // the very next tick.
    hasAutoZoomedRef.current = true;
    // If a GPS position is already known, snap the chevron there immediately.
    // Pass GPS_OPTIONS so this one-shot fix uses GNSS (matches the navigation
    // watcher) instead of the low-accuracy default.
    navigator.geolocation?.getCurrentPosition(
      (p) => {
        const livePos = [p.coords.latitude, p.coords.longitude];
        setUserLocation(livePos);
        const actions = mapActionsRef.current;
        if (actions && typeof actions.setViewOffset === "function") {
          actions.setViewOffset(
            livePos,
            NAVIGATION_FOLLOW_ZOOM,
            NAVIGATION_FOLLOW_OFFSET_Y,
            { animate: true, duration: 0.9 }
          );
        } else {
          actions?.flyTo(livePos, NAVIGATION_FOLLOW_ZOOM, { animate: true, duration: 0.9 });
        }
      },
      undefined,
      GPS_OPTIONS
    );
  }, [isNavigating]);

  // Cleanup GPS on unmount.
  useEffect(
    () => () => {
      if (navWatchIdRef.current !== null) {
        navigator.geolocation.clearWatch(navWatchIdRef.current);
      }
      if (navCameraAlertTimerRef.current !== null) {
        clearTimeout(navCameraAlertTimerRef.current);
      }
      if (saherExitTimerRef.current !== null) {
        clearTimeout(saherExitTimerRef.current);
      }
    },
    []
  );


  // ─── Safety alert helpers ──────────────────────────────────────────────────

  const pushSafetyAlert = useCallback((id, type) => {
    setSafetyAlerts((prev) => {
      if (prev.some((a) => a.id === id)) return prev;
      return [...prev, { id, type }];
    });
  }, []);

  const dismissSafetyAlert = useCallback((id) => {
    setSafetyAlerts((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const completeActiveSequentialToast = useCallback(
    (id) => {
      if (id === "departure")              setDepartureDismissed(true);
      else if (id === "park-ride")         setParkRideDismissed(true);
      else if (id === "metro-alternative") setMetroDismissed(true);
      else                                 dismissSafetyAlert(id);
    },
    [dismissSafetyAlert, setDepartureDismissed, setMetroDismissed, setParkRideDismissed]
  );

  // Sync toast queue with eligible alerts.
  useEffect(() => {
    const canonical = eligibleSequentialAlerts.map((a) => a.id);
    setToastQueue((prev) => {
      if (prev.length === canonical.length && prev.every((id, i) => id === canonical[i])) {
        return prev;
      }
      return canonical;
    });
  }, [eligibleSequentialAlerts]);

  // Cycle through toasts — show each for SEQUENTIAL_TOAST_DISPLAY_MS then fade.
  useEffect(() => {
    if (!activeToastId) {
      setActiveToastFading(false);
      return undefined;
    }
    setActiveToastFading(false);
    const fadeStart = Math.max(0, SEQUENTIAL_TOAST_DISPLAY_MS - TOAST_FADE_OUT_MS);
    const fadeTimer = setTimeout(() => setActiveToastFading(true), fadeStart);
    const doneTimer = setTimeout(
      () => completeActiveSequentialToast(activeToastId),
      SEQUENTIAL_TOAST_DISPLAY_MS
    );
    return () => { clearTimeout(fadeTimer); clearTimeout(doneTimer); };
  }, [activeToastId, completeActiveSequentialToast]);

  // Safety chime once per safety toast becoming the active item.
  useEffect(() => {
    if (!activeToastId || !activeSequentialAlert) {
      lastSafetyAudioToastRef.current = null;
      return;
    }
    if (!SAFETY_AUDIO_TYPES.has(activeSequentialAlert.type)) {
      lastSafetyAudioToastRef.current = null;
      return;
    }
    if (lastSafetyAudioToastRef.current === activeToastId) return;
    lastSafetyAudioToastRef.current = activeToastId;
    playSoftChime();
  }, [activeSequentialAlert, activeToastId]);

  // Route geofencing — push camera alerts when route passes near a camera.
  useEffect(() => {
    if (!activeRoute?.route?.length) return;
    const routePoints = activeRoute.route;
    const isNearRoute = (cameraCoords) =>
      routePoints.some(
        ([lat, lng]) =>
          haversineDistanceKm(lat, lng, cameraCoords[0], cameraCoords[1]) <=
          CAMERA_ALERT_RADIUS_KM
      );
    if (SPEED_CAMERAS.some((cam) => isNearRoute(cam.coords))) {
      pushSafetyAlert("camera-route", "camera");
    }
    if (SAFETY_CAMERAS.some((cam) => isNearRoute(cam.coords))) {
      pushSafetyAlert("seatbelt-route", "seatbelt");
    }
  }, [activeRoute, pushSafetyAlert]);

  // Speed-exceeded alert — fires only when genuinely moving (≥ 10 km/h).
  useEffect(() => {
    const isGenuinelyMoving = navSpeed >= 10;
    if (!activeRoute || !isGenuinelyMoving) {
      dismissSafetyAlert("speed-exceeded");
      return;
    }
    if (navSpeed > roadSpeedLimit) {
      pushSafetyAlert("speed-exceeded", "speed-exceeded");
    } else {
      dismissSafetyAlert("speed-exceeded");
    }
  }, [navSpeed, roadSpeedLimit, activeRoute, pushSafetyAlert, dismissSafetyAlert]);

  // ─── Map click handler ─────────────────────────────────────────────────────

  const handleMapClick = useCallback(
    (latlng) => {
      const coords = [latlng.lat, latlng.lng];
      if (clickMode === "start") {
        setStartCoords(coords);
        setEndCoords(null);
        setClickMode("destination");
      } else {
        setEndCoords(coords);
        setClickMode("start");
      }
      // Debounce: cancel any pending prediction request from a previous rapid
      // click and only fire after the user has paused, so that quickly tapping
      // a series of map points doesn't stack up N prediction requests.
      clearTimeout(predictionDebounceTimerRef.current);
      predictionDebounceTimerRef.current = setTimeout(
        () => fetchPrediction(coords[0], coords[1]),
        PREDICTION_DEBOUNCE_MS
      );
    },
    [clickMode, fetchPrediction]
  );

  // ─── Map drag detection callback (passed to MapContainer) ─────────────────

  const handleMapDragStart = useCallback(() => {
    if (isNavigatingRef.current) setIsMapCentered(false);
  }, []);

  // ─── Simulation ────────────────────────────────────────────────────────────

  const handleStartSimulation = useCallback(() => {
    if (trafficPoints.length === 0) return;
    simulatedFramesRef.current = buildSimulatedTrafficFrames(trafficPoints, prediction);
    setSimulationFrame(0);
    setSimulationActive(true);
  }, [trafficPoints, prediction]);

  const handleStopSimulation = useCallback(() => {
    clearTimeout(simulationTimerRef.current);
    setSimulationActive(false);
    setSimulationFrame(0);
    simulatedFramesRef.current = [];
  }, []);

  useEffect(() => {
    if (!simulationActive) return;
    simulationTimerRef.current = setTimeout(() => {
      setSimulationFrame((prev) => {
        if (prev >= SIMULATION_OFFSETS.length - 1) {
          setSimulationActive(false);
          simulatedFramesRef.current = [];
          return 0;
        }
        return prev + 1;
      });
    }, 2500);
    return () => clearTimeout(simulationTimerRef.current);
  }, [simulationActive, simulationFrame]);

  useEffect(() => () => clearTimeout(simulationTimerRef.current), []);

  // ─── AI traffic context ────────────────────────────────────────────────────
  //
  // Summarises real-time incidents and the current traffic prediction into a
  // compact object sent to the AI copilot with every voice request.
  // • Incidents are sorted by severity and capped at 5 to keep the payload small.
  // • Only the fields the AI needs are forwarded (no map-internal IDs etc.).

  const aiTrafficContext = useMemo(() => {
    const SEVERITY_RANK = { high: 3, medium: 2, low: 1 };

    const topIncidents = [...incidents]
      .sort((a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0))
      .slice(0, 5)
      .map(({ type, severity, message }) => ({ type, severity, message }));

    return {
      incidents:  topIncidents,
      prediction: prediction
        ? {
            level:      prediction.predictedTrafficLevel,
            score:      prediction.predictionScore,
            confidence: prediction.confidence,
          }
        : null,
    };
  }, [incidents, prediction]);

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div
      style={{
        height: "100vh",
        width: "100vw",
        position: "relative",
        overflow: "hidden",
        direction: isRTL ? "rtl" : "ltr",
      }}
    >
      {/* ── Leaflet map (direction: ltr is mandatory inside) ─────────────────── */}
      <MapContainer
        trafficPoints={trafficPoints}
        currentZoom={currentZoom}
        // `displayRoutes` is identical to `allRoutes` in preview mode and
        // whenever navigation is paused; during active driving it replaces
        // the active route's coordinate array with a forward-only slice so
        // the trailing (already-driven) portion is never rendered.  The
        // full original route remains in `activeRoute` for ETA / off-route
        // / reroute calculations — see the `displayRoutes` useMemo above.
        allRoutes={displayRoutes}
        activeRouteIndex={activeRouteIndex}
        displayStart={isNavigating ? null : displayStart}
        endCoords={endCoords}
        startCoords={startCoords}
        incidents={mapIncidents}
        isNavigating={isNavigating}
        // Pre-movement preview: pin to route origin.  Once Drive Mode
        // unlocks (`isLiveTracking === true`), pass through the live GPS
        // userLocation so the stealth-arrow physically follows the driver.
        userLocation={
          isLiveTracking
            ? userLocation
            : (navigationLockedPosition ?? userLocation)
        }
        navBearing={navBearing}
        // Drives both the leaflet-rotate camera bearing and the compass icon
        // overlay's "N" pointer.  Forwarded so MapContainer can render the
        // chevron without double-rotation when the map itself is rotating.
        headingUp={headingUp}
        // While Drive Mode is unlocked we hide the inactive (alternate) route
        // polylines — they otherwise overlap with the active route's already-
        // driven slice, producing the "tangled lines at U-turn" complaint.
        isLiveTracking={isLiveTracking}
        navigationOrigin={routeOriginCoords}
        metroAlternative={metroAlternative}
        metroRouteVisible={metroRouteVisible}
        mapFocusTarget={mapFocusTarget}
        simulationActive={simulationActive}
        simulationFrame={simulationFrame}
        simulatedFramesRef={simulatedFramesRef}
        meetingPlaces={meetingPlaces}
        meetingMidpoint={meetingMidpoint}
        meetingParticipants={meetingParticipants}
        onMapClick={handleMapClick}
        onRouteSelect={handleRouteSelect}
        onMetroMarkerClick={handleMetroMarkerClick}
        onZoomChange={setCurrentZoom}
        onMapReady={onMapReady}
        onDragStart={handleMapDragStart}
        onThemeChange={setMapTheme}
        onCenterChange={handleMapCenterChange}
        t={t}
      />

      {/* ── Analytics dashboard ───────────────────────────────────────────────── */}
      <AnalyticsDashboard prediction={prediction} isRTL={isRTL} />

      {/* ── Map legend ────────────────────────────────────────────────────────── */}
      <MapLegend hasMultipleRoutes={allRoutes.length > 1} />

      {/* ── Locate Me floating action button ─────────────────────────────────── */}
      <LocateMeButton onClick={handleLocateMe} isLocating={isLocateMeActive} />

      {/* ── Heading-Up compass toggle (navigation only) ──────────────────────── */}
      {isNavigating && (
        <HeadingUpToggleButton
          headingUp={headingUp}
          navBearing={navBearing}
          onToggle={() => setHeadingUp((prev) => !prev)}
        />
      )}

   {/* ── AI Traffic Copilot (Connected to Map) ───────────── */}
  {/* ── AI Traffic Copilot (Connected to Map) ───────────── */}
<AICopilotWidget
  trafficContext={aiTrafficContext}
  userLocation={userLocation ?? startCoords}
  onNavigateTo={(coords) => {
    const RIYADH_CENTER = [24.7136, 46.6753];
    if (!userLocation) {
      setStartCoords(RIYADH_CENTER);
    }
    // Capture whether a route already exists before updating state.
    // On a reroute (destination already set), skip the flyTo so the driver's
    // current map view isn't disrupted — useRouteEngine recalculates silently.
    const isReroute = !!endCoords;
    setEndCoords(coords);
    if (!isReroute) {
      setMapFocusTarget({ coords, zoom: 14 });
    }
  }}
/>

      {/* ── Premium speed gauge ───────────────────────────────────────────────── */}
      {activeRoute && (
        <SpeedGauge
          currentSpeed={navSpeed}
          speedLimit={
            // Priority order for the speedometer's "limit":
            //   1. Saher 400 m radar  — newest, highest-precision data source.
            //   2. Legacy 500 m camera banner — belt/mobile cameras.
            //   3. Highway fallback during navigation, road-detected limit otherwise.
            isNavigating && activeSaherCamera?.speedLimit != null
              ? activeSaherCamera.speedLimit
              : isNavigating && nearCameraData?.speedLimit != null
                ? nearCameraData.speedLimit
                : isNavigating
                  ? ROAD_SPEED_LIMIT_HIGHWAY
                  : roadSpeedLimit
          }
        />
      )}

      {/* ── Safety: speed violation fixed banner ─────────────────────────────── */}
      {isNavigating && navSpeed > ROAD_SPEED_LIMIT_HIGHWAY && (
        <SpeedViolationBanner currentSpeed={navSpeed} />
      )}

      {/* ── Safety: camera proximity fixed banner ────────────────────────────── */}
      {isNavigating && navCameraAlertVisible && (
        <CameraProximityBanner
          topOffset={navSpeed > ROAD_SPEED_LIMIT_HIGHWAY ? 120 : 70}
          onDismiss={() => setNavCameraAlertVisible(false)}
          currentSpeed={navSpeed}
          cameraType={nearCameraData?.type ?? "speed"}
          speedLimit={nearCameraData?.speedLimit ?? null}
        />
      )}

      {/* ── Safety: Saher 400 m radar badge (JSON-driven, top of screen) ─────
          Sits BELOW the NavigationBanner (≈ 88 px when guidance is active)
          and well above the NavigationControls bottom sheet, so it never
          covers turn-by-turn instructions or fights the route preview UI.    */}
      {isNavigating && activeSaherCamera && (
        <SaherAlertBadge
          topOffset={(activeRoute?.guidance?.length ?? 0) > 0 ? 100 : 24}
          speedLimit={activeSaherCamera.speedLimit}
          currentSpeed={navSpeed}
          distanceMeters={activeSaherCamera.distanceMeters}
          isExiting={saherBadgeExiting}
        />
      )}

      {/* ── Simulation status bar ─────────────────────────────────────────────── */}
      {simulationActive && (
        <SimulationStatusBar
          frame={simulationFrame}
          isRTL={isRTL}
          t={t}
          onStop={handleStopSimulation}
        />
      )}

      {/* ── Live ETA + Distance dashboard ─────────────────────────────────── */}
      {/* Rendered only during active navigation.  Sits just above the      */}
      {/* NavigationControls bottom sheet.  Values refresh on every GPS     */}
      {/* tick and on every silent reroute (see effect above).              */}
      {isNavigating && (
        <NavEtaDashboard
          remainingDistanceM={navRemainingDistanceM}
          remainingTimeSec={navRemainingTimeSec}
          isRTL={isRTL}
          t={t}
        />
      )}

      {/* ── Turn-by-turn navigation banner ────────────────────────────────────── */}
      {isNavigating && (activeRoute?.guidance?.length ?? 0) > 0 && (
        <NavigationBanner
          instruction={activeRoute.guidance[navStepIndex] ?? null}
          nextInstruction={activeRoute.guidance[navStepIndex + 1] ?? null}
          totalSteps={activeRoute.guidance.length}
          currentStep={navStepIndex}
          voiceEnabled={voiceEnabled}
          onToggleVoice={handleToggleVoice}
        />
      )}

      {/* ── Auto-reroute indicator (briefly visible while recalculating) ─────── */}
      {isNavigating && isRerouting && (
        <div
          role="status"
          aria-live="polite"
          className="nav-rerouting-indicator"
          style={{
            position: "absolute",
            top: (activeRoute?.guidance?.length ?? 0) > 0 ? 72 : 44,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 1200,
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "8px 16px",
            background: "rgba(10,16,32,0.88)",
            backdropFilter: "blur(14px)",
            WebkitBackdropFilter: "blur(14px)",
            border: "1px solid rgba(0,212,255,0.35)",
            borderRadius: 999,
            color: "#E2E8F0",
            fontSize: 12.5,
            fontWeight: 600,
            direction: "rtl",
            letterSpacing: "0.2px",
            whiteSpace: "nowrap",
            boxShadow: "0 6px 24px rgba(0,0,0,0.45), 0 0 18px rgba(0,212,255,0.18)",
            pointerEvents: "none",
            fontFamily: "'Segoe UI', Arial, Tahoma, sans-serif",
          }}
        >
          <span
            className="nav-rerouting-indicator__spinner"
            aria-hidden="true"
            style={{
              width: 12,
              height: 12,
              borderRadius: "50%",
              border: "2px solid rgba(0,212,255,0.25)",
              borderTopColor: "#00d4ff",
              display: "inline-block",
            }}
          />
          جارِ إعادة حساب المسار...
        </div>
      )}

      {/* ── Sequential toast stack (top-center) ────────────────────────────────
       * `sequential-toast-stack` is a pure-CSS hook used by App.css to lift
       * this stack above the mobile top-search panel and reposition it
       * below the panel on small viewports.  No behavioural change here —
       * the toast queue, dismiss timers and alert ordering all stay exactly
       * as they were.  See App.css → `.sequential-toast-stack`.
       */}
      <div
        className="sequential-toast-stack"
        style={{
          position: "absolute",
          top: isNavigating && (activeRoute?.guidance?.length ?? 0) > 0 ? 84 : 56,
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 1100,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 8,
          width: TOAST_MAX_WIDTH,
          maxWidth: "92vw",
          pointerEvents: "none",
          boxSizing: "border-box",
        }}
      >
        {activeSequentialAlert?.type === "park-ride" && parkRideStation && (
          <div style={{ width: "100%", pointerEvents: "auto" }}>
            <ToastFadeWrapper fading={activeToastFading}>
              <ParkAndRideToast
                stationNameAr={parkRideStation.nameAr}
                onDismiss={() => setParkRideDismissed(true)}
                onStationClick={handleParkAndRideStationClick}
              />
            </ToastFadeWrapper>
          </div>
        )}

        {activeSequentialAlert?.type === "metro-alternative" &&
          metroAlternative?.suggested && (
            <div style={{ width: "100%", pointerEvents: "auto" }}>
              <ToastFadeWrapper fading={activeToastFading}>
                <MetroSuggestionBanner
                  metro={metroAlternative}
                  onDismiss={() => setMetroDismissed(true)}
                  onToggleRoute={() => setMetroRouteVisible((v) => !v)}
                  routeVisible={metroRouteVisible}
                  isRTL={isRTL}
                  t={t}
                  fading={false}
                />
              </ToastFadeWrapper>
            </div>
          )}

        {activeSequentialAlert?.type === "departure" && departureRecommendation && (
          <div style={{ width: "100%", pointerEvents: "auto" }}>
            <ToastFadeWrapper fading={activeToastFading}>
              <DepartureRecommendationCard
                recommendation={departureRecommendation}
                onDismiss={() => setDepartureDismissed(true)}
                isRTL={isRTL}
                t={t}
              />
            </ToastFadeWrapper>
          </div>
        )}

        {activeSequentialAlert?.type === "camera" && (
          <div key={activeSequentialAlert.id} style={{ width: "100%", pointerEvents: "auto" }}>
            <ToastFadeWrapper fading={activeToastFading}>
              <SafetyAlertToast
                message="📸 منطقة رقابة مرورية: نأمل الالتزام بالسرعة المحددة."
                onDismiss={() => dismissSafetyAlert(activeSequentialAlert.id)}
              />
            </ToastFadeWrapper>
          </div>
        )}

        {activeSequentialAlert?.type === "seatbelt" && (
          <div key={activeSequentialAlert.id} style={{ width: "100%", pointerEvents: "auto" }}>
            <ToastFadeWrapper fading={activeToastFading}>
              <SafetyAlertToast
                message="📵 تنبيه سلامة: نرجو التأكد من ربط الحزام وعدم الانشغال بالجوال."
                onDismiss={() => dismissSafetyAlert(activeSequentialAlert.id)}
              />
            </ToastFadeWrapper>
          </div>
        )}

        {activeSequentialAlert?.type === "speed-exceeded" && (
          <div style={{ width: "100%", pointerEvents: "auto" }}>
            <ToastFadeWrapper fading={activeToastFading}>
              <SpeedAlertToast
                currentSpeed={navSpeed}
                speedLimit={roadSpeedLimit}
                onDismiss={() => dismissSafetyAlert("speed-exceeded")}
              />
            </ToastFadeWrapper>
          </div>
        )}

        {predictionLoading && (
          <div
            style={{
              alignSelf: "center",
              background: "rgba(8,15,26,0.82)",
              backdropFilter: "blur(12px)",
              WebkitBackdropFilter: "blur(12px)",
              color: "#E2E8F0",
              padding: "6px 14px",
              borderRadius: 16,
              fontSize: 11,
              display: "flex",
              alignItems: "center",
              gap: 6,
              border: "1px solid rgba(255,255,255,0.08)",
              whiteSpace: "nowrap",
              pointerEvents: "none",
              boxShadow: "0 2px 14px rgba(0,0,0,0.32)",
            }}
          >
            ⟳ {t("predicting")}
          </div>
        )}
      </div>

      {/* ── Navigation bottom sheet ───────────────────────────────────────────── */}
      <NavigationControls
        isNavigating={isNavigating}
        isMapCentered={isMapCentered}
        hasActiveRoute={allRoutes.length > 0}
        isRTL={isRTL}
        navigationMode={navigationMode}
        cameraCountOnRoute={cameraCountOnRoute}
        incidentCountOnRoute={incidentCountOnRoute}
        isLiveTracking={isLiveTracking}
        isDarkTheme={mapTheme === "night"}
        onEnableLiveTracking={handleEnableLiveTracking}
        onStartNavigation={handleStartNavigation}
        onExitNavigation={handleExitNavigation}
        onClearRoute={handleClearRoute}
        onReCenter={handleReCenter}
      />

      {/* ── Mobile sidebar toggle FAB ─────────────────────────────────────────── */}
      <button
        className="mobile-sidebar-fab"
        onClick={() => setIsSidebarOpen((prev) => !prev)}
        aria-label={isSidebarOpen ? "إغلاق القائمة" : "فتح القائمة"}
        title={isSidebarOpen ? "إغلاق القائمة" : "فتح القائمة"}
      >
        {isSidebarOpen ? "✕" : "☰"}
      </button>

      {/* ── GPS permission error toast ────────────────────────────────────────── */}
      {gpsErrorToastVisible && (
        <div
          className={`gps-error-toast${gpsErrorToastDismissing ? " toast-dismissing" : ""}`}
          style={{
            position: "fixed",
            bottom: 90,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 10000,
            maxWidth: "min(420px, 92vw)",
            width: "92vw",
            background: "rgba(10, 16, 32, 0.94)",
            backdropFilter: "blur(20px)",
            WebkitBackdropFilter: "blur(20px)",
            border: "1px solid rgba(245, 158, 11, 0.45)",
            borderInlineStart: "3px solid #F59E0B",
            borderRadius: 14,
            padding: "13px 16px",
            display: "flex",
            alignItems: "flex-start",
            gap: 12,
            boxShadow: "0 8px 32px rgba(0,0,0,0.55), 0 0 20px rgba(245,158,11,0.12)",
            direction: isRTL ? "rtl" : "ltr",
            fontFamily: "'Segoe UI', Arial, Tahoma, sans-serif",
          }}
        >
          <span style={{ fontSize: 20, flexShrink: 0, lineHeight: 1.2 }}>📍</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#FDE68A", marginBottom: 4, lineHeight: 1.4 }}>
              تعذّر الوصول إلى الموقع
            </div>
            <div style={{ fontSize: 12, color: "#CBD5E1", lineHeight: 1.65 }}>
              نحتاج صلاحية الموقع للعمل بشكل صحيح، أو يمكنك تحديد موقعك يدوياً على الخريطة.
            </div>
          </div>
          <button
            onClick={() => {
              setGpsErrorToastDismissing(true);
              setTimeout(() => setGpsErrorToastVisible(false), 350);
            }}
            style={{
              background: "transparent",
              border: "none",
              color: "#64748B",
              cursor: "pointer",
              fontSize: 18,
              padding: 0,
              lineHeight: 1,
              flexShrink: 0,
            }}
            aria-label="إغلاق"
          >×</button>
        </div>
      )}

      {/* ── Sidebar ───────────────────────────────────────────────────────────── */}
      <Sidebar
        isMobileOpen={isSidebarOpen}
        onMobileToggle={() => setIsSidebarOpen((prev) => !prev)}
        userLocation={userLocation}
        mapCenter={mapCenter}
        startCoords={startCoords}
        onStartCoordsChange={setStartCoords}
        endCoords={endCoords}
        onEndCoordsChange={setEndCoords}
        onMapFocus={(coords, zoom) => setMapFocusTarget({ coords, zoom: zoom ?? 14 })}
        clickMode={clickMode}
        onClickModeChange={setClickMode}
        destinationText={destinationText}
        onDestinationTextChange={setDestinationText}
        recommendedRoute={activeRoute}
        allRoutes={allRoutes}
        activeRouteIndex={activeRouteIndex}
        onRouteSelect={handleRouteSelect}
        routeLoading={routeLoading}
        routeError={routeError}
        onRecommendRoute={handleRecommendRoute}
        onClearRoute={handleClearRoute}
        // Mobile-only unified bottom-sheet: lets the sidebar render the
        // start/exit navigation CTAs inline so we can hide the duplicate
        // NavigationControls dock on small screens (≤ 768 px) and avoid the
        // overlapping floating-panel chaos described in the layout overhaul.
        isNavigating={isNavigating}
        onStartNavigation={handleStartNavigation}
        onExitNavigation={handleExitNavigation}
        incidents={filteredIncidents}
        incidentsOnRoute={incidentsOnRoute}
        closureAvoidedPerRoute={closureAvoidedPerRoute}
        prediction={prediction}
        predictionLoading={predictionLoading}
        lastUpdated={lastUpdated}
        error={error}
        onRequestSmartDeparture={() => setShowSmartDeparturePanel(true)}
        onCloseSmartDeparturePanel={() => setShowSmartDeparturePanel(false)}
        smartDeparturePanelVisible={showSmartDeparturePanel}
        departureRecommendation={departureRecommendation}
        simulationActive={simulationActive}
        onSimulateTraffic={handleStartSimulation}
        onStopSimulation={handleStopSimulation}
        metroAlternative={metroAlternative?.suggested ? metroAlternative : null}
        metroDismissed={metroDismissed}
        metroRouteVisible={metroRouteVisible}
        onMetroDismiss={() => setMetroDismissed(true)}
        onMetroToggleRoute={() => setMetroRouteVisible((v) => !v)}
        metroBannerFading={sidebarMetroBannerFading}
        backendOnline={backendOnline}
        onRetryConnection={checkBackendHealth}
        onMeetingPointResult={handleMeetingPointResult}
        onMeetingParticipantsChange={handleMeetingParticipantsChange}
      />
    </div>
  );
};

export default TrafficMap;
