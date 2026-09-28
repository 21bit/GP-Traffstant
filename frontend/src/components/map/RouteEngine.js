/**
 * useRouteEngine — custom hook encapsulating all routing, metro-alternative,
 * and Park & Ride state and logic.
 *
 * Accepts external dependencies via a config object to avoid prop-drilling and
 * enable clean unit testing.  State setters for coordinates that live outside
 * this hook (startCoords, endCoords, destinationText) are received as callbacks
 * so the caller remains the single source of truth for those values.
 */

import { useState, useMemo, useCallback } from "react";
import axios from "axios";
import L from "leaflet";
import {
  API_BASE,
  METRO_STATIONS,
  ROUTE_INCIDENT_RADIUS_KM,
  SPEED_CAMERAS,
  SAFETY_CAMERAS,
  CAMERA_ALERT_RADIUS_KM,
  ROUTE_COLORS_BY_THEME,
} from "./mapConfig";
import { haversineDistanceKm, isIncidentNearPolyline } from "./geoUtils";

// ─── Visual design tokens ──────────────────────────────────────────────────────

/**
 * Fallback / night-mode neon colour for the active route polyline.
 * Kept for backward compatibility; prefer getRouteLineColor(theme) at call sites
 * that are aware of the current map theme.
 */
export const NEON_ACTIVE_ROUTE_COLOR = ROUTE_COLORS_BY_THEME.night;

/**
 * Returns the route polyline core colour appropriate for the active map theme.
 *
 * Day   (06:00–17:59) → Standard Blue  (#2563EB) — legible on light OSM tiles.
 * Night (18:00–05:59) → Electric Cyan (#00f2ff)  — neon pop on dark CartoDB tiles.
 *
 * The `mapTheme` value ('day' | 'night') is resolved by `getMapTheme()` in
 * mapConfig.js and propagated through MapContainer → onThemeChange so all
 * consumers (MapContainer route polylines, NavigationControls, etc.) stay in sync.
 */
export const getRouteLineColor = (theme) =>
  ROUTE_COLORS_BY_THEME[theme] ?? ROUTE_COLORS_BY_THEME.night;

// ─── Alert dismissed state lives here because it is owned by the route context ─

export function useRouteEngine({
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
  onStartCoordsChange,
  onEndCoordsChange,
  onDestinationTextChange,
  onMapFitBounds,
}) {
  const [routeResponse, setRouteResponse] = useState(null);
  const [activeRouteIndex, setActiveRouteIndex] = useState(0);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState(null);
  const [alertDismissed, setAlertDismissed] = useState(false);
  const [departureDismissed, setDepartureDismissed] = useState(false);

  const [metroAlternative, setMetroAlternative] = useState(null);
  const [metroDismissed, setMetroDismissed] = useState(false);
  const [metroRouteVisible, setMetroRouteVisible] = useState(false);

  const [parkRideStation, setParkRideStation] = useState(null);
  const [parkRideDismissed, setParkRideDismissed] = useState(false);

  // ─── Derived values ─────────────────────────────────────────────────────────

  const allRoutes = useMemo(() => routeResponse?.routes || [], [routeResponse]);
  const activeRoute = allRoutes[activeRouteIndex] || null;

  /**
   * The very first [lat, lng] coordinate of the active route's polyline.
   * Used by MapContainer to anchor the navigation chevron and the camera flyTo
   * at the true departure point, rather than at the device's physical GPS fix.
   */
  const routeOriginCoords = useMemo(
    () => activeRoute?.route?.[0] ?? null,
    [activeRoute]
  );

  /**
   * Pre-movement preview anchor.
   *
   * While the driver has pressed Start but hasn't physically moved yet (the
   * "Recon -> Drive" preview phase), the chevron is pinned to the route's
   * first polyline coordinate so the UI renders a stable departure view.
   *
   * Once `isLiveTracking` flips to `true` (GPS speed/displacement threshold
   * met — see the hybrid unlock in TrafficMap.handleStartNavigation) this
   * value becomes `null` so the chevron starts following the real GPS
   * position passed via `userLocation`.  Keeping the lock tied to
   * `isLiveTracking` (not just `isNavigating`) is what makes the marker
   * physically move as the driver drives.
   */
  const navigationLockedPosition = useMemo(
    () => (isNavigating && !isLiveTracking ? routeOriginCoords : null),
    [isNavigating, isLiveTracking, routeOriginCoords]
  );

  // ─── Route Recon analytics ────────────────────────────────────────────────────

  /**
   * Number of Saher speed cameras AND seatbelt cameras that fall within
   * CAMERA_ALERT_RADIUS_KM of any point on the active route polyline.
   * Displayed in the Recon Radar banner so drivers can see risk before leaving.
   */
  const cameraCountOnRoute = useMemo(() => {
    if (!activeRoute?.route?.length) return 0;
    const routePoints = activeRoute.route;
    const isNearRoute = (camCoords) =>
      routePoints.some(
        ([lat, lng]) =>
          haversineDistanceKm(lat, lng, camCoords[0], camCoords[1]) <=
          CAMERA_ALERT_RADIUS_KM
      );
    return [...SPEED_CAMERAS, ...SAFETY_CAMERAS].filter((cam) =>
      isNearRoute(cam.coords)
    ).length;
  }, [activeRoute]);

  /**
   * Number of live incidents that fall on the active route polyline.
   * Displayed in the Recon Radar banner alongside the camera count.
   */
  const incidentCountOnRoute = useMemo(() => {
    if (!activeRoute?.route?.length || !incidents?.length) return 0;
    return incidents.filter((inc) =>
      isIncidentNearPolyline(activeRoute.route, inc, ROUTE_INCIDENT_RADIUS_KM)
    ).length;
  }, [activeRoute, incidents]);

  /**
   * Current navigation mode:
   *   "recon" — route is planned but Start has not been pressed; the user is
   *             previewing the path from home (Predictive Radar mode).
   *   "drive" — Start was pressed; navigation is active (simulation-locked or
   *             real GPS once movement is detected).
   *   null    — no active route.
   */
  const navigationMode = useMemo(() => {
    if (isNavigating) return "drive";
    if (activeRoute) return "recon";
    return null;
  }, [isNavigating, activeRoute]);

  // Tracks whether the user dismissed the Recon Radar banner for this route.
  // Reset whenever a new route is generated or the route is cleared.
  const [reconBannerDismissed, setReconBannerDismissed] = useState(false);

  // ─── Metro alternative fetch ─────────────────────────────────────────────────

  const fetchMetroAlternative = useCallback(
    async (from, to, drivingTimeMin, trafficLevel) => {
      try {
        const res = await axios.post(
          `${API_BASE}/api/metro-alternative`,
          {
            startLat: from[0],
            startLng: from[1],
            endLat: to[0],
            endLng: to[1],
            drivingTimeMin,
            trafficLevel,
          },
          { timeout: 10000 }
        );

        if (res.data?.suggested) {
          setMetroAlternative(res.data);
          setMetroDismissed(false);
          setMetroRouteVisible(false);
        } else {
          setMetroAlternative(null);
        }
      } catch (err) {
        console.error("[metro-alt] fetch error:", err.message);
        setMetroAlternative(null);
      }
    },
    []
  );

  // ─── Metro station marker click ─────────────────────────────────────────────
  // Called from the stable ref in MapContainer; both endpoints must be set.

  const handleMetroMarkerClick = useCallback(() => {
    const origin = startCoords || userLocation;
    const destination = endCoords;

    if (!origin || !destination) return;

    const drivingTimeMin = activeRoute?.travelTime ?? 30;
    const trafficLevel =
      activeRoute?.trafficLevel ||
      prediction?.predictedTrafficLevel ||
      "medium";

    fetchMetroAlternative(origin, destination, drivingTimeMin, trafficLevel);
    setMetroDismissed(false);
  }, [
    startCoords,
    userLocation,
    endCoords,
    activeRoute,
    prediction,
    fetchMetroAlternative,
  ]);

  // ─── Route recommendation ────────────────────────────────────────────────────

  const handleRecommendRoute = useCallback(
    async (opts = {}) => {
      const { toCoords = null, destinationLabel = null } = opts;

      setRouteError(null);
      setMetroAlternative(null);
      setRouteLoading(true);

      if (destinationLabel !== null) {
        onDestinationTextChange(destinationLabel);
      }

      try {
        const isOnline = await checkBackendHealth();
        if (!isOnline) {
          setRouteError(t("errorBackendOffline"));
          return;
        }

        const from = startCoords || userLocation;
        let to = toCoords ?? endCoords;

        // Geocode a typed destination that was never selected from the dropdown.
        if (!to && destinationText.trim()) {
          try {
            const res = await axios.get(`${API_BASE}/api/geocode`, {
              params: {
                q: destinationText.trim(),
                language: isRTL ? "ar" : "en-US",
              },
              timeout: 8000,
            });

            if (res.data?.[0]) {
              to = [res.data[0].lat, res.data[0].lng];
              onEndCoordsChange(to);
            } else {
              setRouteError(t("errorGeocodeNotFound"));
              return;
            }
          } catch (err) {
            console.error("[route] geocode error:", err.message);
            const isNetworkError =
              err.code === "ERR_NETWORK" || err.code === "ECONNREFUSED";
            const isServerError = (err.response?.status ?? 0) >= 500;
            const isTimeout     = err.code === "ECONNABORTED";
            setRouteError(
              isNetworkError
                ? t("errorBackendOffline")
                : (isServerError || isTimeout)
                  ? "السيرفر عليه ضغط حالياً، يرجى المحاولة مرة أخرى بعد قليل"
                  : t("errorGeocodeFailed")
            );
            return;
          }
        }

        if (!from) { setRouteError(t("errorNoStart"));  return; }
        if (!to)   { setRouteError(t("errorNoDest"));   return; }

        // Guard: if both points are the same (or within ~10 metres of each other),
        // the routing API returns a zero-distance path which breaks polyline rendering.
        const sameLocationThresholdKm = 0.01;
        if (haversineDistanceKm(from[0], from[1], to[0], to[1]) < sameLocationThresholdKm) {
          setRouteError("نقطة البداية والوجهة متطابقتان. يُرجى تحديد موقعين مختلفين.");
          return;
        }

        if (toCoords !== null) onEndCoordsChange(toCoords);

        console.log("🛣️ FRONTEND: Fetching real route from backend ->", `${API_BASE}/api/recommend-route`);
        console.log("🛣️ FRONTEND: Route coordinates ->", { from, to });

        const res = await axios.post(
          `${API_BASE}/api/recommend-route`,
          {
            startLat: from[0],
            startLng: from[1],
            endLat: to[0],
            endLng: to[1],
          },
          { timeout: 20000 }
        );

        const pointCount = res.data?.routes?.[res.data?.recommendedIndex ?? 0]?.route?.length ?? 0;
        console.log(`🛣️ FRONTEND: Route received — ${res.data?.routes?.length ?? 0} option(s), recommended has ${pointCount} road-snapped points`);

        setRouteResponse(res.data);
        setActiveRouteIndex(res.data.recommendedIndex ?? 0);
        onStartCoordsChange(from);
        onEndCoordsChange(to);
        setRouteError(null);
        setAlertDismissed(false);
        setDepartureDismissed(false);
        setReconBannerDismissed(false);

        const recommended = res.data.routes?.[res.data.recommendedIndex ?? 0];

        // Fit the map to the FULL curved polyline geometry, not just the two
        // endpoints.  This guarantees the user sees the entire path — including
        // any detours — immediately after route generation (Preview mode).
        // maxZoom is intentionally uncapped so fitBounds picks the optimal
        // zoom level for the actual path length.
        const boundsPoints =
          recommended?.route?.length > 1 ? recommended.route : [from, to];
        const routeBounds = L.latLngBounds(boundsPoints);

        // Mobile (≤768px) reserves vertical space for the floating-top
        // inputs container (~150px) and the bottom-sheet action panel
        // (≤46vh, capped at 380px) so the polyline never sits underneath
        // a fixed UI element.  Desktop keeps the original symmetrical
        // 50px padding.
        const isMobileViewport =
          typeof window !== "undefined" && window.innerWidth <= 768;
        if (isMobileViewport) {
          const viewportHeight =
            typeof window !== "undefined" ? window.innerHeight : 800;
          const reservedTopPx = 160;
          const reservedBottomPx = Math.min(380, Math.round(viewportHeight * 0.46)) + 24;
          onMapFitBounds(routeBounds, {
            paddingTopLeft:     [40, reservedTopPx],
            paddingBottomRight: [40, reservedBottomPx],
          });
        } else {
          onMapFitBounds(routeBounds, { padding: [50, 50] });
        }

        const midLat = (from[0] + to[0]) / 2;
        const midLng = (from[1] + to[1]) / 2;
        fetchIncidents(midLat, midLng);
        fetchPrediction(midLat, midLng);

        if (recommended && recommended.trafficLevel !== "low") {
          fetchMetroAlternative(from, to, recommended.travelTime, recommended.trafficLevel);
        }

        // Park & Ride: suggest nearest metro station for trips > 20 minutes.
        if (recommended && recommended.travelTime > 20) {
          const nearest = METRO_STATIONS.reduce((best, station) => {
            const distKm = haversineDistanceKm(
              from[0],
              from[1],
              station.coords[0],
              station.coords[1]
            );
            return !best || distKm < best.distKm
              ? { station, distKm }
              : best;
          }, null);

          if (nearest) {
            setParkRideStation(nearest.station);
            setParkRideDismissed(false);
          }
        } else {
          setParkRideStation(null);
        }
      } catch (err) {
        console.error("[route] recommendation error:", err.message);
        const isNetworkError =
          err.code === "ERR_NETWORK" || err.code === "ECONNREFUSED";
        const isServerError  = (err.response?.status ?? 0) >= 500;
        const isTimeout      = err.code === "ECONNABORTED";

        if (isNetworkError) {
          setRouteError(t("errorBackendOffline"));
        } else if (isServerError || isTimeout) {
          // Mirror the same string used in Sidebar.js SERVER_PRESSURE_MESSAGE so
          // the component's routeError useEffect can identify and promote it to
          // the floating toast alongside the inline error block.
          setRouteError(
            "السيرفر عليه ضغط حالياً، يرجى المحاولة مرة أخرى بعد قليل"
          );
        } else {
          setRouteError(t("errorRouteFailed"));
        }
      } finally {
        setRouteLoading(false);
      }
    },
    [
      startCoords,
      userLocation,
      endCoords,
      destinationText,
      isRTL,
      t,
      checkBackendHealth,
      fetchIncidents,
      fetchPrediction,
      fetchMetroAlternative,
      onStartCoordsChange,
      onEndCoordsChange,
      onDestinationTextChange,
      onMapFitBounds,
    ]
  );

  // ─── Park & Ride station link click ─────────────────────────────────────────
  // Sets the destination to the nearest metro station and recalculates the route.

  const handleParkAndRideStationClick = useCallback(() => {
    if (!parkRideStation) return;
    setParkRideDismissed(true);
    handleRecommendRoute({
      toCoords: parkRideStation.coords,
      destinationLabel: parkRideStation.nameAr,
    });
  }, [parkRideStation, handleRecommendRoute]);

  // ─── Switch to alternative route ────────────────────────────────────────────

  const handleSwitchToAlternative = useCallback(() => {
    if (allRoutes.length < 2) return;
    const recommendedIdx = routeResponse?.recommendedIndex ?? 0;
    const targetIndex =
      activeRouteIndex !== recommendedIdx
        ? recommendedIdx
        : allRoutes.findIndex((_, i) => i !== activeRouteIndex);
    if (targetIndex >= 0) {
      setActiveRouteIndex(targetIndex);
      setAlertDismissed(true);
    }
  }, [allRoutes, routeResponse, activeRouteIndex]);

  const handleRouteSelect = useCallback((index) => {
    setActiveRouteIndex(index);
    setAlertDismissed(false);
  }, []);

  // ─── Silent reroute from live GPS ────────────────────────────────────────────
  //
  // Called by the navigation watchPosition loop when the driver deviates
  // beyond OFF_ROUTE_THRESHOLD_METERS from the active polyline.  Intentionally
  // stripped-down: we only refresh `routeResponse` + `activeRouteIndex`.
  //
  // Deliberately skipped (vs. handleRecommendRoute):
  //   • `onMapFitBounds`         — preserves the driver's current zoom/camera.
  //   • `fetchIncidents` / `fetchPrediction` — incidents don't move with us.
  //   • `fetchMetroAlternative`  — no transit-modality prompts mid-drive.
  //   • `setParkRideStation`     — Park & Ride prompt is a pre-trip UX.
  //   • `onStartCoordsChange`    — keeps the Recon "start pin" anchored.
  //   • `onEndCoordsChange`      — destination is unchanged by definition.
  //
  // Returns `{ok: boolean}` so the caller can clear the Arabic rerouting
  // indicator regardless of success/failure.

  const rerouteFromLivePosition = useCallback(
    async (liveOrigin, heading) => {
      if (
        !liveOrigin ||
        !Number.isFinite(liveOrigin[0]) ||
        !Number.isFinite(liveOrigin[1])
      ) {
        return { ok: false };
      }
      if (!endCoords) return { ok: false };

      // Sanitise heading: TomTom's `vehicleHeading` expects integer degrees in
      // `[0, 360)`.  Any non-finite / out-of-range value is simply omitted so
      // the backend can fall back to the legacy (headingless) request.
      const headingValue = Number(heading);
      const safeHeading =
        Number.isFinite(headingValue)
          ? ((Math.round(headingValue) % 360) + 360) % 360
          : null;

      try {
        const res = await axios.post(
          `${API_BASE}/api/recommend-route`,
          {
            startLat: liveOrigin[0],
            startLng: liveOrigin[1],
            endLat:   endCoords[0],
            endLng:   endCoords[1],
            // Forward the driver's current bearing so TomTom can build a
            // FORWARD-moving route (e.g. "take the next exit") instead of
            // asking the driver to perform an illegal U-turn back onto the
            // previous polyline.  Only sent when we actually have a finite
            // bearing value.
            ...(safeHeading !== null ? { heading: safeHeading } : {}),
          },
          { timeout: 15000 }
        );

        if (!res.data?.routes?.length) return { ok: false };

        setRouteResponse(res.data);
        setActiveRouteIndex(res.data.recommendedIndex ?? 0);
        return { ok: true };
      } catch (err) {
        console.error("[reroute] silent rerouting error:", err.message);
        return { ok: false };
      }
    },
    [endCoords]
  );

  // ─── Clear route ─────────────────────────────────────────────────────────────

  const handleClearRoute = useCallback(
    (onClearSafetyAlerts) => {
      setRouteResponse(null);
      setActiveRouteIndex(0);
      setRouteError(null);
      setAlertDismissed(false);
      setDepartureDismissed(false);
      setReconBannerDismissed(false);
      setMetroAlternative(null);
      setMetroDismissed(false);
      setMetroRouteVisible(false);
      setParkRideStation(null);
      setParkRideDismissed(false);

      onStartCoordsChange(null);
      onEndCoordsChange(null);
      onDestinationTextChange("");

      if (typeof onClearSafetyAlerts === "function") {
        onClearSafetyAlerts();
      }
    },
    [onStartCoordsChange, onEndCoordsChange, onDestinationTextChange]
  );

  return {
    // Route state
    routeResponse,
    activeRouteIndex,
    routeLoading,
    routeError,
    allRoutes,
    activeRoute,
    routeOriginCoords,
    // The authoritative position during navigation — locked to routeOriginCoords.
    // Callers MUST use this instead of real GPS while isNavigating is true.
    navigationLockedPosition,
    // Route Recon & Prediction
    navigationMode,
    cameraCountOnRoute,
    incidentCountOnRoute,
    reconBannerDismissed,
    setReconBannerDismissed,
    // Alert dismissal
    alertDismissed,
    setAlertDismissed,
    departureDismissed,
    setDepartureDismissed,
    // Metro alternative
    metroAlternative,
    metroDismissed,
    setMetroDismissed,
    metroRouteVisible,
    setMetroRouteVisible,
    // Park & Ride
    parkRideStation,
    parkRideDismissed,
    setParkRideDismissed,
    // Handlers
    handleRecommendRoute,
    handleClearRoute,
    handleRouteSelect,
    handleSwitchToAlternative,
    handleParkAndRideStationClick,
    handleMetroMarkerClick,
    fetchMetroAlternative,
    // Silent reroute primitive for the live-navigation off-route detector.
    rerouteFromLivePosition,
  };
}
