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
  const originTimer = useRef(null);
  const destTimer = useRef(null);

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
          fuelLiters: activeRoute.fuelEstimate?.liters,
          fuelCostSar: activeRoute.fuelEstimate?.costSar,
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
          <button type="button" className="planner-btn ghost" onClick={onClear}>
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
          <FuelEstimate fuelEstimate={activeRoute?.fuelEstimate} />
          <DepartureTrends
            trends={decision.trends}
            departureComparison={decision.departureComparison}
          />
          <div className="planner-actions">
            <button type="button" className="planner-btn primary" onClick={saveTrip}>
              {t("saveTrip")}
            </button>
          </div>
          {saveMessage && <div className="planner-save-msg">{saveMessage}</div>}
        </>
      )}

      <TripHistory onReuse={reuseTrip} refreshKey={historyKey} />

      <AuthModal open={authOpen} onClose={() => setAuthOpen(false)} />
    </aside>
  );
}
