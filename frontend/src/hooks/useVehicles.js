import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../AuthContext";
import {
  readSelectedVehicleId,
  toEstimatePayload,
  writeSelectedVehicleId,
} from "../utils/vehicleStorage";

/**
 * Saved-vehicle store for authenticated users only.
 * Guests estimate fuel via a one-off form (see FuelEstimate).
 */
export default function useVehicles() {
  const { user, authFetch } = useAuth();
  const [vehicles, setVehicles] = useState([]);
  const [selectedId, setSelectedId] = useState(() => readSelectedVehicleId());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (!user) {
      setVehicles([]);
      return [];
    }
    setLoading(true);
    setError("");
    try {
      const data = await authFetch("/api/vehicles");
      const list = data.vehicles || [];
      setVehicles(list);
      return list;
    } catch (err) {
      setError(err.message || "تعذر تحميل المركبات");
      return [];
    } finally {
      setLoading(false);
    }
  }, [user, authFetch]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!user) {
        setVehicles([]);
        setLoading(false);
        setError("");
        return;
      }
      setLoading(true);
      try {
        const data = await authFetch("/api/vehicles");
        if (!cancelled) setVehicles(data.vehicles || []);
      } catch (err) {
        if (!cancelled) setError(err.message || "تعذر تحميل المركبات");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, authFetch]);

  useEffect(() => {
    if (!user || !vehicles.length) {
      if (!user) {
        setSelectedId(null);
        writeSelectedVehicleId(null);
      }
      return;
    }
    const stillValid = vehicles.some((v) => String(v.id) === String(selectedId));
    if (stillValid) return;
    const fallback = vehicles.find((v) => v.isDefault) || vehicles[0];
    setSelectedId(fallback.id);
    writeSelectedVehicleId(fallback.id);
  }, [user, vehicles, selectedId]);

  const selectedVehicle = useMemo(
    () => vehicles.find((v) => String(v.id) === String(selectedId)) || null,
    [vehicles, selectedId]
  );

  const selectVehicle = useCallback((id) => {
    setSelectedId(id);
    writeSelectedVehicleId(id);
  }, []);

  const saveVehicle = useCallback(
    async (payload, editingId = null) => {
      if (!user) {
        const err = new Error("SIGN_IN_REQUIRED");
        err.code = "SIGN_IN_REQUIRED";
        throw err;
      }
      setError("");
      const path = editingId ? `/api/vehicles/${editingId}` : "/api/vehicles";
      const method = editingId ? "PUT" : "POST";
      const data = await authFetch(path, { method, body: payload });
      await refresh();
      selectVehicle(data.vehicle.id);
      return data.vehicle;
    },
    [user, authFetch, refresh, selectVehicle]
  );

  const removeVehicle = useCallback(
    async (id) => {
      if (!user) {
        const err = new Error("SIGN_IN_REQUIRED");
        err.code = "SIGN_IN_REQUIRED";
        throw err;
      }
      setError("");
      await authFetch(`/api/vehicles/${id}`, { method: "DELETE" });
      await refresh();
    },
    [user, authFetch, refresh]
  );

  const makeDefault = useCallback(
    async (id) => {
      if (!user) {
        const err = new Error("SIGN_IN_REQUIRED");
        err.code = "SIGN_IN_REQUIRED";
        throw err;
      }
      setError("");
      await authFetch(`/api/vehicles/${id}/default`, { method: "POST" });
      await refresh();
      selectVehicle(id);
    },
    [user, authFetch, refresh, selectVehicle]
  );

  return {
    vehicles,
    selectedVehicle,
    selectedId,
    selectVehicle,
    saveVehicle,
    removeVehicle,
    makeDefault,
    loading,
    error,
    estimatePayload: toEstimatePayload(selectedVehicle),
    refresh,
    canPersist: Boolean(user),
  };
}
