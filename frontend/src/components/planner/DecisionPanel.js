import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import { API_BASE, RIYADH_CENTER } from "../map/mapConfig";
import { useAuth } from "../../AuthContext";
import { useLanguage } from "../../LanguageContext";
import AuthModal from "./AuthModal";
import DepartureAdvice from "./DepartureAdvice";
import DepartureTrends from "./DepartureTrends";
import FuelEstimate from "./FuelEstimate";
import RouteHealthCard from "./RouteHealthCard";
import TripHistory from "./TripHistory";
import { canStartTrip, finishTrip, startTrip } from "../../utils/tripSession";

const SEARCH_DEBOUNCE_MS = 400;

export default function DecisionPanel({
  origin,
  setOrigin,
  destination,
  setDestination,
  originLabel,
  setOriginLabel,
  destLabel,
  setDestLabel,
  decision,
  loadingDecision,
  decisionError,
  activeRouteId,
  setActiveRouteId,
  onPlanTrip,
  onClear,
}) {
  const { user, logout, authFetch } = useAuth();
  const { t } = useLanguage();
  const [authOpen, setAuthOpen] = useState(false);
  const [originQuery, setOriginQuery] = useState("");
  const [destQuery, setDestQuery] = useState("");
  const [originSuggestions, setOriginSuggestions] = useState([]);
  const [destSuggestions, setDestSuggestions] = useState([]);
  const [locating, setLocating] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [historyKey, setHistoryKey] = useState(0);
  const [vehicleFuel, setVehicleFuel] = useState(null);
  const [tripSession, setTripSession] = useState(null);
  const [tripBusy, setTripBusy] = useState(false);
  const originTimer = useRef(null);
  const destTimer = useRef(null);
  const tripLock = useRef(false);

  const onFuelEstimate = useCallback((next) => {
    setVehicleFuel((prev) =>
      JSON.stringify(prev) === JSON.stringify(next) ? prev : next
    );
  }, []);

  const activeRoute = useMemo(() => {
    if (!decision?.routes?.length) return null;
    return (
      decision.routes.find((r) => r.id === activeRouteId) ||
      decision.routes[decision.recommendedIndex] ||
      decision.routes[0]
    );
  }, [decision, activeRouteId]);

  const searchPlaces = useCallback(async (query, bias) => {
    if (!query || query.trim().length < 2) return [];
    const params = { query: query.trim() };
    if (bias) {
      params.lat = bias[0];
      params.lon = bias[1];
    }
    const res = await axios.get(`${API_BASE}/api/search-places`, {
      params,
      timeout: 8000,
    });
    return Array.isArray(res.data) ? res.data : [];
  }, []);

  useEffect(() => {
    clearTimeout(originTimer.current);
    if (originQuery.trim().length < 2) {
      setOriginSuggestions([]);
      return;
    }
    originTimer.current = setTimeout(async () => {
      try {
        const results = await searchPlaces(originQuery, origin);
        setOriginSuggestions(results.slice(0, 6));
      } catch (_err) {
        setOriginSuggestions([]);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(originTimer.current);
  }, [originQuery, origin, searchPlaces]);

  useEffect(() => {
    clearTimeout(destTimer.current);
    if (destQuery.trim().length < 2) {
      setDestSuggestions([]);
      return;
    }
    destTimer.current = setTimeout(async () => {
      try {
        const bias = origin || RIYADH_CENTER;
        const results = await searchPlaces(destQuery, bias);
        setDestSuggestions(results.slice(0, 6));
      } catch (_err) {
        setDestSuggestions([]);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(destTimer.current);
  }, [destQuery, origin, searchPlaces]);

  const useMyLocation = () => {
    if (!navigator.geolocation) return;
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const coords = [pos.coords.latitude, pos.coords.longitude];
        setOrigin(coords);
        setOriginLabel(t("currentLocation"));
        setOriginQuery("");
        setOriginSuggestions([]);
        setLocating(false);
      },
      () => setLocating(false),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  const pickOrigin = (place) => {
    setOrigin([place.lat, place.lng]);
    setOriginLabel(place.name);
    setOriginQuery("");
    setOriginSuggestions([]);
  };

  const pickDest = (place) => {
    setDestination([place.lat, place.lng]);
    setDestLabel(place.name);
    setDestQuery("");
    setDestSuggestions([]);
  };

  useEffect(() => {
    if (!user || tripSession) return undefined;
    let cancelled = false;
    authFetch("/api/trips")
      .then((data) => {
        if (cancelled) return;
        const active = (data.trips || []).find((trip) => trip.status === "active");
        if (!active) return;
        setTripSession({
          id: active.id,
          persisted: true,
          status: "active",
          originName: active.originName,
          destName: active.destName,
          startLat: active.startLat,
          startLng: active.startLng,
          endLat: active.endLat,
          endLng: active.endLng,
          chosenRouteLabel: active.chosenRouteLabel,
          distanceKm: active.distanceKm,
          travelTimeMinutes: active.travelTimeMinutes,
          routeHealthScore: active.routeHealthScore,
          fuelLiters: active.fuelLiters,
          fuelCostSar: active.fuelCostSar,
          startedAt: active.startedAt,
          endedAt: null,
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [user, authFetch, tripSession]);

  const routeForTrip = () => {
    if (!origin || !destination || !activeRoute) return null;
    return {
      originName: originLabel,
      destName: destLabel,
      startLat: origin[0],
      startLng: origin[1],
      endLat: destination[0],
      endLng: destination[1],
      chosenRouteLabel: activeRoute.label,
      distanceKm: activeRoute.distanceKm,
      travelTimeMinutes: activeRoute.travelTimeMinutes,
      routeHealthScore: activeRoute.routeHealthScore,
      fuelLiters: vehicleFuel?.liters ?? null,
      fuelCostSar: vehicleFuel?.costSar ?? null,
    };
  };

  const beginTrip = async () => {
    if (tripLock.current || tripBusy) return;
    const route = routeForTrip();
    const started = startTrip(tripSession, route);
    if (!started.ok) {
      setSaveMessage(t(started.code));
      return;
    }

    tripLock.current = true;
    setTripBusy(true);
    try {
      let session = started.session;
      if (user) {
        const data = await authFetch("/api/trips", {
          method: "POST",
          body: {
            ...session,
            recommendationAction: decision?.recommendation?.action,
            recommendationWaitMinutes: decision?.recommendation?.waitMinutes,
            predictedEtaMinutes: activeRoute.travelTimeMinutes,
            snapshot: {
              recommendation: decision?.recommendation,
              prediction: decision?.prediction,
            },
          },
        });
        session = {
          ...session,
          id: data.trip.id,
          persisted: true,
          startedAt: data.trip.startedAt || session.startedAt,
        };
        setHistoryKey((k) => k + 1);
      }
      setTripSession(session);
      setSaveMessage("");
    } catch (err) {
      setSaveMessage(err.message);
    } finally {
      tripLock.current = false;
      setTripBusy(false);
    }
  };

  const closeTrip = async (outcome) => {
    if (tripLock.current || tripBusy) return;
    const closed = finishTrip(tripSession, outcome);
    if (!closed.ok) {
      setSaveMessage(t(closed.code));
      return;
    }
    tripLock.current = true;
    setTripBusy(true);
    try {
      if (user && tripSession.id) {
        const data = await authFetch(`/api/trips/${tripSession.id}`, {
          method: "PATCH",
          body: { status: outcome },
        });
        setTripSession({
          ...closed.session,
          id: data.trip.id,
          persisted: true,
          status: data.trip.status,
          endedAt: data.trip.endedAt,
        });
        setHistoryKey((k) => k + 1);
      } else {
        setTripSession(closed.session);
      }
      setSaveMessage(outcome === "completed" ? t("tripCompleted") : t("tripCancelled"));
    } catch (err) {
      setSaveMessage(err.message);
    } finally {
      tripLock.current = false;
      setTripBusy(false);
    }
  };

  const saveTrip = async () => {
    if (!user) {
      setAuthOpen(true);
      return;
    }
    if (!origin || !destination || !activeRoute || !decision) return;

    try {
      await authFetch("/api/trips", {
        method: "POST",
        body: {
          originName: originLabel,
          destName: destLabel,
          startLat: origin[0],
          startLng: origin[1],
          endLat: destination[0],
          endLng: destination[1],
          chosenRouteLabel: activeRoute.label,
          routeHealthScore: activeRoute.routeHealthScore,
          travelTimeMinutes: activeRoute.travelTimeMinutes,
          distanceKm: activeRoute.distanceKm,
          recommendationAction: decision.recommendation?.action,
          recommendationWaitMinutes: decision.recommendation?.waitMinutes,
          predictedEtaMinutes: activeRoute.travelTimeMinutes,
          fuelLiters: vehicleFuel?.liters ?? null,
          fuelCostSar: vehicleFuel?.costSar ?? null,
          snapshot: {
            recommendation: decision.recommendation,
            prediction: decision.prediction,
          },
        },
      });
      setSaveMessage(t("tripSaved"));
      setHistoryKey((k) => k + 1);
      setTimeout(() => setSaveMessage(""), 2500);
    } catch (err) {
      setSaveMessage(err.message);
    }
  };

  const reuseTrip = (trip) => {
    setOrigin([trip.startLat, trip.startLng]);
    setDestination([trip.endLat, trip.endLng]);
    setOriginLabel(trip.originName || t("startPoint"));
    setDestLabel(trip.destName || t("destinationPoint"));
    onPlanTrip([trip.startLat, trip.startLng], [trip.endLat, trip.endLng]);
  };

  return (
    <aside className="planner-panel">
      <header className="planner-brand">
        <div>
          <div className="planner-logo">Traffstant</div>
          <p>{t("appSubtitle")}</p>
        </div>
        <div className="planner-auth-slot">
          {user ? (
            <>
              <span className="planner-user">{user.name || user.email}</span>
              <button type="button" className="planner-link" onClick={logout}>
                {t("logout")}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="planner-btn ghost"
              onClick={() => setAuthOpen(true)}
            >
              {t("login")}
            </button>
          )}
        </div>
      </header>

      <section className="planner-section">
        <h3>{t("planTrip")}</h3>

        <label className="planner-field">
          {t("from")}
          <div className="planner-input-row">
            <input
              value={originQuery}
              onChange={(e) => setOriginQuery(e.target.value)}
              placeholder={originLabel || t("fromPlaceholder")}
            />
            <button type="button" className="planner-btn ghost" onClick={useMyLocation}>
              {locating ? t("locating") : t("gps")}
            </button>
          </div>
          {originSuggestions.length > 0 && (
            <ul className="planner-suggestions">
              {originSuggestions.map((place, idx) => (
                <li key={`${place.lat}-${place.lng}-${idx}`}>
                  <button type="button" onClick={() => pickOrigin(place)}>
                    {place.name}
                    {place.neighborhood ? ` · ${place.neighborhood}` : ""}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {originLabel && !originQuery && (
            <div className="planner-selected">{originLabel}</div>
          )}
        </label>

        <label className="planner-field">
          {t("to")}
          <input
            value={destQuery}
            onChange={(e) => setDestQuery(e.target.value)}
            placeholder={destLabel || t("searchPlaceholder")}
          />
          {destSuggestions.length > 0 && (
            <ul className="planner-suggestions">
              {destSuggestions.map((place, idx) => (
                <li key={`${place.lat}-${place.lng}-${idx}`}>
                  <button type="button" onClick={() => pickDest(place)}>
                    {place.name}
                    {place.neighborhood ? ` · ${place.neighborhood}` : ""}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {destLabel && !destQuery && (
            <div className="planner-selected">{destLabel}</div>
          )}
        </label>

        <div className="planner-actions">
          <button
            type="button"
            className="planner-btn primary"
            disabled={!origin || !destination || loadingDecision}
            onClick={() => onPlanTrip(origin, destination)}
          >
            {loadingDecision ? t("calculating") : t("getDecision")}
          </button>
          <button
            type="button"
            className="planner-btn ghost"
            onClick={() => {
              if (tripSession?.status === "active") {
                setSaveMessage(t("endTripBeforeClear"));
                return;
              }
              setTripSession(null);
              setVehicleFuel(null);
              onClear();
            }}
          >
            {t("clear")}
          </button>
        </div>
        {decisionError && <div className="planner-error">{decisionError}</div>}
      </section>

      {decision && (
        <>
          <DepartureAdvice
            recommendation={decision.recommendation}
            prediction={decision.prediction}
          />
          <RouteHealthCard
            routes={decision.routes}
            activeRouteId={activeRoute?.id}
            onSelectRoute={setActiveRouteId}
          />
          <FuelEstimate distanceKm={activeRoute?.distanceKm} onEstimate={onFuelEstimate} />
          <DepartureTrends
            trends={decision.trends}
            departureComparison={decision.departureComparison}
          />
          {tripSession?.status !== "active" && (
            <div className="planner-actions">
              <button
                type="button"
                className="planner-btn primary"
                disabled={
                  tripBusy || !canStartTrip(tripSession, routeForTrip()).ok
                }
                onClick={beginTrip}
              >
                {t("startTrip")}
              </button>
              <button type="button" className="planner-btn ghost" onClick={saveTrip}>
                {t("saveTrip")}
              </button>
            </div>
          )}
          {saveMessage && <div className="planner-save-msg">{saveMessage}</div>}
        </>
      )}

      {tripSession?.status === "active" && (
        <section className="planner-advice go planner-trip-active">
          <div className="planner-advice-title">{t("tripActive")}</div>
          <p>
            {tripSession.originName || t("startPoint")} →{" "}
            {tripSession.destName || t("destinationPoint")}
            {tripSession.distanceKm != null ? ` · ${tripSession.distanceKm} ${t("km")}` : ""}
          </p>
          <p className="planner-note">{t("tripActiveNote")}</p>
          {tripSession.startedAt && (
            <div className="planner-advice-meta">
              {new Date(tripSession.startedAt).toLocaleString()}
            </div>
          )}
          {!user && <p className="planner-note">{t("guestTripNote")}</p>}
          <div className="planner-actions">
            <button
              type="button"
              className="planner-btn primary"
              disabled={tripBusy}
              onClick={() => closeTrip("completed")}
            >
              {t("endTrip")}
            </button>
            <button
              type="button"
              className="planner-btn ghost"
              disabled={tripBusy}
              onClick={() => closeTrip("cancelled")}
            >
              {t("cancelTrip")}
            </button>
          </div>
        </section>
      )}

      <TripHistory onReuse={reuseTrip} refreshKey={historyKey} />

      <AuthModal open={authOpen} onClose={() => setAuthOpen(false)} />
    </aside>
  );
}
