import React, { useEffect, useMemo, useState } from "react";
import axios from "axios";
import { API_BASE } from "../map/mapConfig";
import { useLanguage } from "../../LanguageContext";
import { OTHER_VEHICLE, VEHICLE_CATALOG, modelYears } from "../../data/vehicles";
import { calculateTripFuel } from "../../utils/fuelMath";

const EMPTY_FORM = {
  modified: null,
  manufacturer: "",
  model: "",
  year: "",
  otherManufacturer: "",
  otherModel: "",
  otherYear: "",
  engineDisplacementL: "",
  forcedInduction: "unknown",
  modifications: "",
  fuelType: "gasoline",
  fuelGrade: "91",
};

function basisLabel(t, basis) {
  if (basis === "published_specification") return t("efficiencyPublished");
  if (basis === "approximation") return t("efficiencyApprox");
  return t("efficiencyUnavailable");
}

export default function FuelEstimate({ distanceKm, onEstimate }) {
  const { t } = useLanguage();
  const [form, setForm] = useState(EMPTY_FORM);
  const [prices, setPrices] = useState(null);
  const [efficiency, setEfficiency] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const years = useMemo(() => modelYears(), []);

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

  const usingOther = form.modified === true || form.manufacturer === OTHER_VEHICLE;
  const selectedManufacturer = usingOther
    ? form.otherManufacturer.trim()
    : form.manufacturer;
  const selectedModel = usingOther ? form.otherModel.trim() : form.model;
  const selectedYear = usingOther ? form.otherYear : form.year;
  const models =
    VEHICLE_CATALOG.find((item) => item.manufacturer === form.manufacturer)?.models || [];

  const vehicle = useMemo(() => {
    if (form.modified === null) return null;
    const payload = {
      modified: form.modified,
      manufacturer: selectedManufacturer,
      model: selectedModel,
      year: selectedYear || null,
      fuelType: form.modified ? form.fuelType : "gasoline",
      engineDisplacementL: form.engineDisplacementL || null,
      forcedInduction: form.modified ? form.forcedInduction : "none",
      modifications: form.modified ? form.modifications.trim() : "",
    };
    if (!form.modified) {
      return payload.manufacturer && payload.model ? payload : null;
    }
    const hasIdentity = payload.manufacturer && payload.model;
    const hasEngine = payload.engineDisplacementL !== null && payload.engineDisplacementL !== "";
    const hasNotes = payload.modifications.length >= 3;
    if ((payload.manufacturer && !payload.model) || (!payload.manufacturer && payload.model)) {
      return null;
    }
    return hasIdentity || hasEngine || hasNotes ? payload : null;
  }, [form, selectedManufacturer, selectedModel, selectedYear]);

  const vehicleKey = JSON.stringify(vehicle);
  useEffect(() => {
    setEfficiency(null);
    setError("");
  }, [vehicleKey]);

  const pricePerLiter = prices?.grades?.[form.fuelGrade]?.pricePerLiterSar;
  const diesel = form.modified && form.fuelType === "diesel";
  const distance = Number(distanceKm);
  const localFuel =
    efficiency?.kmPerLiter && !diesel
      ? calculateTripFuel(distance, efficiency.kmPerLiter, pricePerLiter)
      : null;

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
            fuelGrade: form.fuelGrade,
            pricePerLiterSar: pricePerLiter,
          }
        : null
    );
  }, [distance, efficiency, diesel, pricePerLiter, form.fuelGrade, onEstimate]);

  const setField = (key, value) => {
    setForm((prev) => {
      const next = { ...prev, [key]: value };
      if (key === "manufacturer") next.model = "";
      if (key === "modified") {
        return { ...EMPTY_FORM, modified: value, fuelGrade: prev.fuelGrade };
      }
      return next;
    });
  };

  const estimate = async () => {
    if (!vehicle) {
      setError(t("vehicleIncomplete"));
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
        { vehicle, distanceKm: distance, fuelGrade: form.fuelGrade },
        { timeout: 20000 }
      );
      const data = res.data || {};
      setEfficiency(data.efficiency || null);
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
      if (!data.efficiency?.kmPerLiter) {
        setError(data.efficiency?.explanation || t("fuelUnavailable"));
      }
    } catch (err) {
      setEfficiency(null);
      setError(err.response?.data?.error || err.message || t("fuelUnavailable"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="planner-section planner-fuel">
      <h3>{t("fuelEstimate")}</h3>
      <p className="planner-note">{t("fuelDisclaimer")}</p>
      <p className="planner-muted">
        {distance > 0
          ? t("routeDistanceLabel").replace("{km}", String(distance))
          : t("fuelNeedRoute")}
      </p>

      <p className="planner-field-label">{t("vehicleQuestion")}</p>
      <div className="planner-choice-row">
        <button
          type="button"
          className={`planner-choice ${form.modified === false ? "active" : ""}`}
          onClick={() => setField("modified", false)}
        >
          {t("vehicleStock")}
        </button>
        <button
          type="button"
          className={`planner-choice ${form.modified === true ? "active" : ""}`}
          onClick={() => setField("modified", true)}
        >
          {t("vehicleModified")}
        </button>
      </div>

      {form.modified === false && (
        <>
          <label className="planner-field">
            {t("manufacturer")}
            <select
              value={form.manufacturer}
              onChange={(e) => setField("manufacturer", e.target.value)}
            >
              <option value="">{t("selectManufacturer")}</option>
              {VEHICLE_CATALOG.map((item) => (
                <option key={item.manufacturer} value={item.manufacturer}>
                  {item.manufacturer}
                </option>
              ))}
              <option value={OTHER_VEHICLE}>{t("other")}</option>
            </select>
          </label>
          {form.manufacturer && form.manufacturer !== OTHER_VEHICLE && (
            <label className="planner-field">
              {t("model")}
              <select value={form.model} onChange={(e) => setField("model", e.target.value)}>
                <option value="">{t("selectModel")}</option>
                {models.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            </label>
          )}
          {form.manufacturer === OTHER_VEHICLE && (
            <>
              <label className="planner-field">
                {t("manufacturer")}
                <input
                  value={form.otherManufacturer}
                  onChange={(e) => setField("otherManufacturer", e.target.value)}
                />
              </label>
              <label className="planner-field">
                {t("model")}
                <input
                  value={form.otherModel}
                  onChange={(e) => setField("otherModel", e.target.value)}
                />
              </label>
              <label className="planner-field">
                {t("yearOptional")}
                <input
                  inputMode="numeric"
                  value={form.otherYear}
                  onChange={(e) => setField("otherYear", e.target.value)}
                />
              </label>
            </>
          )}
          {form.manufacturer && form.manufacturer !== OTHER_VEHICLE && (
            <label className="planner-field">
              {t("yearOptional")}
              <select value={form.year} onChange={(e) => setField("year", e.target.value)}>
                <option value="">{t("unspecified")}</option>
                {years.map((year) => (
                  <option key={year} value={year}>
                    {year}
                  </option>
                ))}
              </select>
            </label>
          )}
        </>
      )}

      {form.modified === true && (
        <>
          <p className="planner-note">{t("modifiedHint")}</p>
          <label className="planner-field">
            {t("manufacturerOptional")}
            <input
              value={form.otherManufacturer}
              onChange={(e) => setField("otherManufacturer", e.target.value)}
            />
          </label>
          <label className="planner-field">
            {t("modelOptional")}
            <input
              value={form.otherModel}
              onChange={(e) => setField("otherModel", e.target.value)}
            />
          </label>
          <label className="planner-field">
            {t("yearOptional")}
            <input
              inputMode="numeric"
              value={form.otherYear}
              onChange={(e) => setField("otherYear", e.target.value)}
            />
          </label>
          <label className="planner-field">
            {t("engineOptional")}
            <input
              inputMode="decimal"
              value={form.engineDisplacementL}
              onChange={(e) => setField("engineDisplacementL", e.target.value)}
              placeholder="2.5"
            />
          </label>
          <label className="planner-field">
            {t("forcedInduction")}
            <select
              value={form.forcedInduction}
              onChange={(e) => setField("forcedInduction", e.target.value)}
            >
              <option value="unknown">{t("inductionUnknown")}</option>
              <option value="none">{t("inductionNone")}</option>
              <option value="turbo">{t("inductionTurbo")}</option>
            </select>
          </label>
          <label className="planner-field">
            {t("modificationsOptional")}
            <textarea
              value={form.modifications}
              onChange={(e) => setField("modifications", e.target.value)}
              rows={2}
            />
          </label>
          <label className="planner-field">
            {t("fuelType")}
            <select value={form.fuelType} onChange={(e) => setField("fuelType", e.target.value)}>
              <option value="gasoline">{t("fuelGasoline")}</option>
              <option value="diesel">{t("fuelDiesel")}</option>
              <option value="unknown">{t("fuelUnknown")}</option>
            </select>
          </label>
        </>
      )}

      {form.modified !== null && !diesel && (
        <label className="planner-field">
          {t("fuelGrade")}
          <select
            value={form.fuelGrade}
            onChange={(e) => setField("fuelGrade", e.target.value)}
          >
            <option value="91">
              {t("grade91")}
              {prices?.grades?.["91"] ? ` — ${prices.grades["91"].pricePerLiterSar} ${t("sar")}` : ""}
            </option>
            <option value="95">
              {t("grade95")}
              {prices?.grades?.["95"] ? ` — ${prices.grades["95"].pricePerLiterSar} ${t("sar")}` : ""}
            </option>
          </select>
        </label>
      )}

      {prices?.reviewedOn && form.modified !== null && !diesel && (
        <p className="planner-note">
          {t("priceSourceNote").replace("{date}", prices.reviewedOn)}
        </p>
      )}

      {form.modified !== null && (
        <button
          type="button"
          className="planner-btn primary"
          disabled={loading || !vehicle || !(distance > 0)}
          onClick={estimate}
        >
          {loading ? t("estimatingFuel") : t("estimateFuelBtn")}
        </button>
      )}

      {error && <div className="planner-error">{error}</div>}

      {efficiency?.kmPerLiter && (
        <>
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
          {efficiency.explanation && <p className="planner-muted">{efficiency.explanation}</p>}
          {diesel && <p className="planner-note">{t("dieselCostUnavailable")}</p>}
        </>
      )}
    </section>
  );
}
