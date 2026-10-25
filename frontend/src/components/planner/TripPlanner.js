import React, { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { API_BASE, RIYADH_CENTER } from "../map/mapConfig";
import DecisionPanel from "./DecisionPanel";
import PlannerMap from "./PlannerMap";

/**
 * Pre-trip planner shell: map preview + decision panel.
 * No turn-by-turn navigation.
 */
export default function TripPlanner() {
  const [origin, setOrigin] = useState(null);
  const [destination, setDestination] = useState(null);
  const [originLabel, setOriginLabel] = useState("");
  const [destLabel, setDestLabel] = useState("");
  const [decision, setDecision] = useState(null);
  const [activeRouteId, setActiveRouteId] = useState(null);
  const [loadingDecision, setLoadingDecision] = useState(false);
  const [decisionError, setDecisionError] = useState("");
  const [trafficPoints, setTrafficPoints] = useState([]);

  useEffect(() => {
    let cancelled = false;
    axios
      .get(`${API_BASE}/api/traffic`, { timeout: 20000 })
      .then((res) => {
        if (!cancelled) setTrafficPoints(res.data?.points || []);
      })
      .catch(() => {
        if (!cancelled) setTrafficPoints([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Default origin to Riyadh center if GPS unavailable later — user can override
  useEffect(() => {
    if (origin) return;
    if (!navigator.geolocation) {
      setOrigin(RIYADH_CENTER);
      setOriginLabel("الرياض");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setOrigin([pos.coords.latitude, pos.coords.longitude]);
        setOriginLabel("موقعي الحالي");
      },
      () => {
        setOrigin(RIYADH_CENTER);
        setOriginLabel("الرياض");
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }, [origin]);

  const onPlanTrip = useCallback(async (start, end) => {
    if (!start || !end) return;
    setLoadingDecision(true);
    setDecisionError("");
    try {
      const res = await axios.post(
        `${API_BASE}/api/trip-decision`,
        {
          startLat: start[0],
          startLng: start[1],
          endLat: end[0],
          endLng: end[1],
          departureSlotsMinutes: [0, 15, 30, 45, 60],
        },
        { timeout: 60000 }
      );
      setDecision(res.data);
      const routes = res.data.routes || [];
      const recommended =
        routes[res.data.recommendedIndex] || routes.find((r) => r.isRecommended) || routes[0];
      setActiveRouteId(recommended?.id || null);
    } catch (err) {
      setDecision(null);
      setDecisionError(
        err.response?.data?.error || err.message || "تعذر الحصول على القرار"
      );
    } finally {
      setLoadingDecision(false);
    }
  }, []);

  const onClear = () => {
    setDestination(null);
    setDestLabel("");
    setDecision(null);
    setActiveRouteId(null);
    setDecisionError("");
  };

  return (
    <div className="planner-shell">
      <div className="planner-map-plane">
        <PlannerMap
          origin={origin}
          destination={destination}
          routes={decision?.routes || []}
          activeRouteId={activeRouteId}
          trafficPoints={trafficPoints}
        />
        <div className="planner-map-veil" aria-hidden="true" />
      </div>
      <DecisionPanel
        origin={origin}
        setOrigin={setOrigin}
        destination={destination}
        setDestination={setDestination}
        originLabel={originLabel}
        setOriginLabel={setOriginLabel}
        destLabel={destLabel}
        setDestLabel={setDestLabel}
        decision={decision}
        loadingDecision={loadingDecision}
        decisionError={decisionError}
        activeRouteId={activeRouteId}
        setActiveRouteId={setActiveRouteId}
        onPlanTrip={onPlanTrip}
        onClear={onClear}
      />
    </div>
  );
}
