import React, { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { API_BASE } from "../map/mapConfig";
import { useAuth } from "../../AuthContext";
import { useLanguage } from "../../LanguageContext";
import { calculateTripFuel } from "../../utils/fuelMath";
import { toEstimatePayload, vehicleDisplayName } from "../../utils/vehicleStorage";
import VehicleForm from "./VehicleForm";
import VehicleManager from "./VehicleManager";

function basisLabel(t, basis) {
  if (basis === "published_specification") return t("efficiencyPublished");
  if (basis === "approximation") return t("efficiencyApprox");
  return t("efficiencyUnavailable");
}

export default function FuelEstimate({
  distanceKm,
  onEstimate,
  vehiclesApi,
  onRequestAuth,
}) {
  const { user } = useAuth();
  const { t } = useLanguage();
  const {
    vehicles,
    selectedVehicle,
    selectedId,
    selectVehicle,
    saveVehicle,
    removeVehicle,
    makeDefault,
    loading: vehiclesLoading,
    error: vehiclesError,
    canPersist,
  } = vehiclesApi;

  const [guestVehicle, setGuestVehicle] = useState(null);
  const [fuelGrade, setFuelGrade] = useState("91");
  const [prices, setPrices] = useState(null);
  const [efficiency, setEfficiency] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const onGuestVehicleChange = useCallback((payload) => {
    setGuestVehicle(payload);
  }, []);

  useEffect(() => {
    let cancelled = false;
    axios
      .get(`${API_BASE}/api/fuel-prices`, { timeout: 8000 })
      .then((res) => {
        if (!cancelled) setPrices(res.data);
      })
      .catch(() => {
        if (!cancelled) setPrices(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setEfficiency(null);
    setError("");
  }, [selectedId, guestVehicle, user]);

  const vehicle = user
    ? toEstimatePayload(selectedVehicle)
    : guestVehicle
      ? {
          modified: Boolean(guestVehicle.modified),
          manufacturer: guestVehicle.manufacturer || "",
          model: guestVehicle.model || "",
          year: guestVehicle.year || null,
          engineDisplacementL: guestVehicle.engineDisplacementL ?? null,
          fuelType: guestVehicle.fuelType || "gasoline",
          transmission: "",
          forcedInduction: guestVehicle.forcedInduction || "unknown",
          modifications: guestVehicle.modifications || "",
        }
      : null;

  const diesel = vehicle?.fuelType === "diesel";
  const distance = Number(distanceKm);
  const pricePerLiter = prices?.grades?.[fuelGrade]?.pricePerLiterSar;
  const localFuel =
    efficiency?.kmPerLiter && !diesel
      ? calculateTripFuel(distance, efficiency.kmPerLiter, pricePerLiter)
      : null;
  const readyForEstimate = Boolean(vehicle) && distance > 0;

  useEffect(() => {
    if (!onEstimate) return;
    if (!efficiency?.kmPerLiter || diesel || !(distance > 0) || !(Number(pricePerLiter) > 0)) {
      onEstimate(null);
      return;
    }
    const fuel = calculateTripFuel(distance, efficiency.kmPerLiter, pricePerLiter);
    onEstimate(
      fuel
        ? {
            liters: fuel.liters,
            costSar: fuel.costSar,
            kmPerLiter: efficiency.kmPerLiter,
            fuelGrade,
            pricePerLiterSar: pricePerLiter,
          }
        : null
    );
  }, [distance, efficiency, diesel, pricePerLiter, fuelGrade, onEstimate]);

  const estimate = async () => {
    if (!vehicle) {
      setError(user ? t("selectVehicleFirst") : t("vehicleIncomplete"));
      return;
    }
    if (!(distance > 0)) {
      setError(t("fuelNeedRoute"));
      return;
    }
    setLoading(true);
    setError("");
    try {
      const res = await axios.post(
        `${API_BASE}/api/fuel-estimate`,
        { vehicle, distanceKm: distance, fuelGrade },
        { timeout: 55000 }
      );
      const data = res.data || {};
      const nextEfficiency = data.efficiency || null;
      const km = Number(nextEfficiency?.kmPerLiter);
      if (nextEfficiency?.kmPerLiter != null && (!Number.isFinite(km) || km <= 0)) {
        setEfficiency(null);
        setError(t("fuelUnavailable"));
        return;
      }
      setEfficiency(nextEfficiency);
      if (data.price?.pricePerLiterSar) {
        setPrices((prev) => ({
          ...(prev || {}),
          source: data.price.source || prev?.source,
          reviewedOn: data.price.reviewedOn || prev?.reviewedOn,
          disclaimer: prev?.disclaimer,
          grades: {
            ...(prev?.grades || {}),
            [data.price.grade]: {
              id: data.price.grade,
              label: data.price.label,
              pricePerLiterSar: data.price.pricePerLiterSar,
            },
          },
        }));
      }
      if (!nextEfficiency?.kmPerLiter) {
        setError(nextEfficiency?.explanation || t("fuelUnavailable"));
      }
    } catch (err) {
      setEfficiency(null);
      setError(err.response?.data?.error || err.message || t("fuelUnavailable"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      {user && (
        <VehicleManager
          vehicles={vehicles}
          selectedId={selectedId}
          onSelect={selectVehicle}
          onSave={saveVehicle}
          onDelete={removeVehicle}
          onMakeDefault={makeDefault}
          loading={vehiclesLoading}
          error={vehiclesError}
          canPersist={canPersist}
          onRequestAuth={onRequestAuth}
        />
      )}

      <section className="planner-section planner-fuel">
        <h3>{t("fuelEstimate")}</h3>
        <p className="planner-note">{t("fuelDisclaimer")}</p>
        <p className="planner-muted">
          {distance > 0
            ? t("routeDistanceLabel").replace("{km}", String(distance))
            : t("fuelNeedRoute")}
        </p>

        {user ? (
          selectedVehicle ? (
            <div className="planner-selected-vehicle">
              <span>{t("selectedVehicle")}</span>
              <strong>{vehicleDisplayName(selectedVehicle)}</strong>
            </div>
          ) : (
            !vehiclesLoading && (
              <div className="planner-empty-card compact">
                <p>{t("selectVehicleFirst")}</p>
              </div>
            )
          )
        ) : (
          <>
            <p className="planner-muted">{t("guestFuelHint")}</p>
            <VehicleForm variant="estimate" onChange={onGuestVehicleChange} />
            <div className="planner-empty-card compact planner-save-hint">
              <p>{t("signInToSaveVehicles")}</p>
              {onRequestAuth && (
                <button
                  type="button"
                  className="planner-btn ghost compact"
                  onClick={onRequestAuth}
                >
                  {t("login")}
                </button>
              )}
            </div>
          </>
        )}

        {vehicle && !diesel && (
          <label className="planner-field">
            {t("fuelGrade")}
            <select value={fuelGrade} onChange={(e) => setFuelGrade(e.target.value)}>
              <option value="91">
                {t("grade91")}
                {prices?.grades?.["91"]
                  ? ` — ${prices.grades["91"].pricePerLiterSar} ${t("sar")}`
                  : ""}
              </option>
              <option value="95">
                {t("grade95")}
                {prices?.grades?.["95"]
                  ? ` — ${prices.grades["95"].pricePerLiterSar} ${t("sar")}`
                  : ""}
              </option>
            </select>
          </label>
        )}

        {prices?.reviewedOn && vehicle && !diesel && (
          <p className="planner-note">
            {t("priceSourceNote").replace("{date}", prices.reviewedOn)}
          </p>
        )}

        {vehicle && (
          <button
            type="button"
            className="planner-btn primary"
            disabled={loading || !readyForEstimate}
            onClick={estimate}
          >
            {loading ? (
              <span className="planner-btn-loading">
                <span className="planner-spinner" aria-hidden="true" />
                {t("estimatingFuel")}
              </span>
            ) : (
              t("estimateFuelBtn")
            )}
          </button>
        )}

        {error && <div className="planner-error">{error}</div>}

        {efficiency?.kmPerLiter && (
          <div className="planner-fuel-results">
            <div className="planner-fuel-row">
              <div>
                <strong>{efficiency.kmPerLiter}</strong>
                <span>{t("kmPerLiter")}</span>
              </div>
              <div>
                <strong>{localFuel ? localFuel.liters : "—"}</strong>
                <span>{t("liters")}</span>
              </div>
              {!diesel && (
                <div>
                  <strong>{localFuel ? localFuel.costSar : "—"}</strong>
                  <span>{t("sar")}</span>
                </div>
              )}
            </div>
            <p className="planner-note">
              {basisLabel(t, efficiency.basis)}
              {efficiency.confidence ? ` · ${t(`confidence_${efficiency.confidence}`)}` : ""}
            </p>
            {efficiency.explanation && (
              <p className="planner-muted">{efficiency.explanation}</p>
            )}
            {diesel && <p className="planner-note">{t("dieselCostUnavailable")}</p>}
            <p className="planner-estimate-badge">{t("estimateOnlyBadge")}</p>
          </div>
        )}
      </section>
    </>
  );
}
