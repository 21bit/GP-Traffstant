import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import { API_BASE, RIYADH_CENTER } from "../map/mapConfig";
import { useAuth } from "../../AuthContext";
import { useLanguage } from "../../LanguageContext";
import useVehicles from "../../hooks/useVehicles";
import { pushRecentLocation, recentFromTrips } from "../../utils/recentLocations";
import { canStartTrip, finishTrip, startTrip } from "../../utils/tripSession";
import AuthModal from "./AuthModal";
import DecisionLoading from "./DecisionLoading";
import DepartureAdvice from "./DepartureAdvice";
import DepartureTrends from "./DepartureTrends";
import FuelEstimate from "./FuelEstimate";
import PlaceSearchField from "./PlaceSearchField";
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
  onInvalidateDecision,
  locationNotice,
  setLocationNotice,
}) {
  const { user, logout, authFetch } = useAuth();
  const { t } = useLanguage();
  const vehiclesApi = useVehicles();
  const [authOpen, setAuthOpen] = useState(false);
  const [originQuery, setOriginQuery] = useState("");
  const [destQuery, setDestQuery] = useState("");
  const [originSuggestions, setOriginSuggestions] = useState([]);
  const [destSuggestions, setDestSuggestions] = useState([]);
  const [originSearching, setOriginSearching] = useState(false);
  const [destSearching, setDestSearching] = useState(false);
  const [originNoResults, setOriginNoResults] = useState(false);
  const [destNoResults, setDestNoResults] = useState(false);
  const [recentLocations, setRecentLocations] = useState([]);
  const [locating, setLocating] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [historyKey, setHistoryKey] = useState(0);
  const [vehicleFuel, setVehicleFuel] = useState(null);
  const [tripSession, setTripSession] = useState(null);
  const [tripBusy, setTripBusy] = useState(false);
  const originTimer = useRef(null);
  const destTimer = useRef(null);
  const tripLock = useRef(false);
  const planLock = useRef(false);

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
      setOriginNoResults(false);
      setOriginSearching(false);
      return;
    }
    setOriginSearching(true);
    originTimer.current = setTimeout(async () => {
      try {
        const results = await searchPlaces(originQuery, origin);
        const sliced = results.slice(0, 6);
        setOriginSuggestions(sliced);
        setOriginNoResults(sliced.length === 0);
      } catch (_err) {
        setOriginSuggestions([]);
        setOriginNoResults(true);
      } finally {
        setOriginSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(originTimer.current);
  }, [originQuery, origin, searchPlaces]);

  useEffect(() => {
    clearTimeout(destTimer.current);
    if (destQuery.trim().length < 2) {
      setDestSuggestions([]);
      setDestNoResults(false);
      setDestSearching(false);
      return;
    }
    setDestSearching(true);
    destTimer.current = setTimeout(async () => {
      try {
        const bias = origin || RIYADH_CENTER;
        const results = await searchPlaces(destQuery, bias);
        const sliced = results.slice(0, 6);
        setDestSuggestions(sliced);
        setDestNoResults(sliced.length === 0);
      } catch (_err) {
        setDestSuggestions([]);
        setDestNoResults(true);
      } finally {
        setDestSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(destTimer.current);
  }, [destQuery, origin, searchPlaces]);

  useEffect(() => {
    if (!user) return undefined;
    let cancelled = false;
    authFetch("/api/trips")
      .then((data) => {
        if (cancelled) return;
        setRecentLocations((prev) => {
          const fromTrips = recentFromTrips(data.trips || []);
          let merged = prev;
          for (const place of fromTrips.slice().reverse()) {
            merged = pushRecentLocation(merged, place);
          }
          return merged;
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [user, authFetch, historyKey]);

  const rememberPlace = useCallback((place) => {
    setRecentLocations((prev) => pushRecentLocation(prev, place));
  }, []);

  const useMyLocation = () => {
    if (!navigator.geolocation) {
      setOrigin(RIYADH_CENTER);
      setOriginLabel(t("riyadhCenter"));
      setOriginQuery("");
      setOriginSuggestions([]);
      if (setLocationNotice) setLocationNotice(t("gpsFallbackNotice"));
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const coords = [pos.coords.latitude, pos.coords.longitude];
        setOrigin(coords);
        setOriginLabel(t("currentLocation"));
        setOriginQuery("");
        setOriginSuggestions([]);
        setLocating(false);
        if (setLocationNotice) setLocationNotice("");
      },
      (err) => {
        setLocating(false);
        const denied = err?.code === 1;
        const unavailable = err?.code === 2;
        const timeout = err?.code === 3;
        if (denied || unavailable || timeout || err) {
          setOrigin(RIYADH_CENTER);
          setOriginLabel(t("riyadhCenter"));
          if (setLocationNotice) setLocationNotice(t("gpsFallbackNotice"));
        }
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  const pickOrigin = (place) => {
    setOrigin([place.lat, place.lng]);
    setOriginLabel(place.name);
    setOriginQuery("");
    setOriginSuggestions([]);
    setOriginNoResults(false);
    rememberPlace(place);
    if (setLocationNotice) setLocationNotice("");
  };

  const pickDest = (place) => {
    setDestination([place.lat, place.lng]);
    setDestLabel(place.name);
    setDestQuery("");
    setDestSuggestions([]);
    setDestNoResults(false);
    rememberPlace(place);
  };

  const swapOriginDestination = () => {
    const nextOrigin = destination;
    const nextDest = origin;
    const nextOriginLabel = destLabel;
    const nextDestLabel = originLabel;
    setOrigin(nextOrigin);
    setDestination(nextDest);
    setOriginLabel(nextOriginLabel);
    setDestLabel(nextDestLabel);
    setOriginQuery("");
    setDestQuery("");
    setOriginSuggestions([]);
    setDestSuggestions([]);
    setOriginNoResults(false);
    setDestNoResults(false);
    if (setLocationNotice) setLocationNotice("");
    if (onInvalidateDecision) onInvalidateDecision();
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
    rememberPlace({
      name: trip.originName || t("startPoint"),
      lat: trip.startLat,
      lng: trip.startLng,
    });
    rememberPlace({
      name: trip.destName || t("destinationPoint"),
      lat: trip.endLat,
      lng: trip.endLng,
    });
    onPlanTrip([trip.startLat, trip.startLng], [trip.endLat, trip.endLng]);
  };

  const handlePlan = async () => {
    if (planLock.current || loadingDecision || !origin || !destination) return;
    planLock.current = true;
    try {
      await onPlanTrip(origin, destination);
    } finally {
      planLock.current = false;
    }
  };

  const showInitialHint = !decision && !loadingDecision && !decisionError;

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

        <PlaceSearchField
          label={t("from")}
          query={originQuery}
          onQueryChange={setOriginQuery}
          placeholder={originLabel || t("fromPlaceholder")}
          selectedLabel={originLabel && !originQuery ? originLabel : ""}
          suggestions={originSuggestions}
          searching={originSearching}
          noResults={originNoResults}
          recentLocations={recentLocations}
          onPick={pickOrigin}
          listId="origin-suggestions"
          trailing={
            <button type="button" className="planner-btn ghost" onClick={useMyLocation}>
              {locating ? t("locating") : t("gps")}
            </button>
          }
        />

        <div className="planner-swap-row">
          <button
            type="button"
            className="planner-swap-btn"
            onClick={swapOriginDestination}
            aria-label={t("swapLocations")}
            title={t("swapLocations")}
            disabled={!origin && !destination}
          >
            ⇅
          </button>
        </div>

        <PlaceSearchField
          label={t("to")}
          query={destQuery}
          onQueryChange={setDestQuery}
          placeholder={destLabel || t("searchPlaceholder")}
          selectedLabel={destLabel && !destQuery ? destLabel : ""}
          suggestions={destSuggestions}
          searching={destSearching}
          noResults={destNoResults}
          recentLocations={recentLocations}
          onPick={pickDest}
          listId="dest-suggestions"
        />

        {locationNotice && (
          <div className="planner-gps-notice" role="status">
            {locationNotice}
          </div>
        )}

        <div className="planner-actions">
          <button
            type="button"
            className="planner-btn primary"
            disabled={!origin || !destination || loadingDecision}
            onClick={handlePlan}
          >
            {loadingDecision ? (
              <span className="planner-btn-loading">
                <span className="planner-spinner" aria-hidden="true" />
                {t("calculating")}
              </span>
            ) : (
              t("getDecision")
            )}
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

      {showInitialHint && (
        <div className="planner-hint-card">
          <p>{t("initialEmptyHint")}</p>
        </div>
      )}

      {loadingDecision && <DecisionLoading />}

      {!loadingDecision && decision && (
        <>
          <DepartureAdvice
            recommendation={decision.recommendation}
            prediction={decision.prediction}
            activeRoute={activeRoute}
            departureComparison={decision.departureComparison}
          />
          <DepartureTrends
            trends={decision.trends}
            departureComparison={decision.departureComparison}
          />
          <RouteHealthCard
            routes={decision.routes}
            activeRouteId={activeRoute?.id}
            onSelectRoute={setActiveRouteId}
          />
          <FuelEstimate
            distanceKm={activeRoute?.distanceKm}
            onEstimate={onFuelEstimate}
            vehiclesApi={vehiclesApi}
            onRequestAuth={() => setAuthOpen(true)}
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
