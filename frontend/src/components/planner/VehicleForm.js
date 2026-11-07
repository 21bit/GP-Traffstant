import React, { useEffect, useMemo, useState } from "react";
import { OTHER_VEHICLE, VEHICLE_CATALOG, modelYears } from "../../data/vehicles";
import { useLanguage } from "../../LanguageContext";

const EMPTY_FORM = {
  modified: false,
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
  isDefault: false,
};

function RequiredMark({ t, titleKey = "requiredForFuel" }) {
  return (
    <span className="planner-required" title={t(titleKey)} aria-label={t(titleKey)}>
      {t("requiredMark")}
    </span>
  );
}

function toForm(vehicle) {
  if (!vehicle) return { ...EMPTY_FORM };
  const inCatalog = VEHICLE_CATALOG.some(
    (item) =>
      item.manufacturer === vehicle.manufacturer &&
      item.models.includes(vehicle.model)
  );
  if (vehicle.modified) {
    return {
      ...EMPTY_FORM,
      modified: true,
      otherManufacturer: vehicle.manufacturer || "",
      otherModel: vehicle.model || "",
      otherYear: vehicle.year ? String(vehicle.year) : "",
      engineDisplacementL:
        vehicle.engineDisplacementL != null ? String(vehicle.engineDisplacementL) : "",
      forcedInduction: vehicle.forcedInduction || "unknown",
      modifications: vehicle.modifications || "",
      fuelType: vehicle.fuelType || "gasoline",
      isDefault: Boolean(vehicle.isDefault),
    };
  }
  if (!inCatalog && (vehicle.manufacturer || vehicle.model)) {
    return {
      ...EMPTY_FORM,
      modified: false,
      manufacturer: OTHER_VEHICLE,
      otherManufacturer: vehicle.manufacturer || "",
      otherModel: vehicle.model || "",
      otherYear: vehicle.year ? String(vehicle.year) : "",
      fuelType: vehicle.fuelType || "gasoline",
      isDefault: Boolean(vehicle.isDefault),
    };
  }
  return {
    ...EMPTY_FORM,
    modified: false,
    manufacturer: vehicle.manufacturer || "",
    model: vehicle.model || "",
    year: vehicle.year ? String(vehicle.year) : "",
    fuelType: vehicle.fuelType || "gasoline",
    isDefault: Boolean(vehicle.isDefault),
  };
}

export function buildVehiclePayload(form) {
  const usingOther = form.modified === true || form.manufacturer === OTHER_VEHICLE;
  const manufacturer = usingOther
    ? form.otherManufacturer.trim()
    : form.manufacturer;
  const model = usingOther ? form.otherModel.trim() : form.model;
  const yearRaw = usingOther ? form.otherYear : form.year;
  const year = yearRaw ? Number(yearRaw) : null;

  return {
    modified: Boolean(form.modified),
    manufacturer,
    model,
    year: Number.isFinite(year) ? year : null,
    engineDisplacementL:
      form.modified && form.engineDisplacementL
        ? Number(form.engineDisplacementL)
        : null,
    fuelType: form.fuelType || "gasoline",
    transmission: "",
    forcedInduction: form.modified ? form.forcedInduction : "none",
    modifications: form.modified ? form.modifications.trim() : "",
    isDefault: Boolean(form.isDefault),
  };
}

export function isVehicleFormValid(form) {
  const payload = buildVehiclePayload(form);
  if (!form.modified) {
    return Boolean(payload.manufacturer && payload.model);
  }
  const hasIdentity = Boolean(payload.manufacturer && payload.model);
  const hasEngine =
    payload.engineDisplacementL != null && !Number.isNaN(payload.engineDisplacementL);
  const hasNotes = payload.modifications.length >= 3;
  if ((payload.manufacturer && !payload.model) || (!payload.manufacturer && payload.model)) {
    return false;
  }
  return hasIdentity || hasEngine || hasNotes;
}

/**
 * @param {"manage"|"estimate"} variant
 * manage = save to account; estimate = one-off fuel calc (guests / quick use)
 */
export default function VehicleForm({
  initialVehicle = null,
  onSubmit,
  onCancel,
  onChange,
  busy = false,
  variant = "manage",
  submitLabel,
}) {
  const { t } = useLanguage();
  const [form, setForm] = useState(() => toForm(initialVehicle));
  const years = useMemo(() => modelYears(), []);
  const models =
    VEHICLE_CATALOG.find((item) => item.manufacturer === form.manufacturer)?.models ||
    [];

  useEffect(() => {
    setForm(toForm(initialVehicle));
  }, [initialVehicle]);

  useEffect(() => {
    if (!onChange) return;
    onChange(isVehicleFormValid(form) ? buildVehiclePayload(form) : null);
  }, [form, onChange]);

  const setField = (key, value) => {
    setForm((prev) => {
      const next = { ...prev, [key]: value };
      if (key === "manufacturer") next.model = "";
      if (key === "modified") {
        return {
          ...EMPTY_FORM,
          modified: value,
          isDefault: prev.isDefault,
          fuelType: prev.fuelType,
        };
      }
      return next;
    });
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!isVehicleFormValid(form)) return;
    onSubmit(buildVehiclePayload(form));
  };

  const showActions = typeof onSubmit === "function";

  return (
    <form className="planner-vehicle-form" onSubmit={handleSubmit}>
      <p className="planner-field-label">{t("vehicleQuestion")}</p>
      <div className="planner-choice-row" role="group" aria-label={t("vehicleQuestion")}>
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

      {!form.modified && (
        <>
          <label className="planner-field">
            {t("manufacturer")}
            <RequiredMark t={t} />
            <select
              value={form.manufacturer}
              onChange={(e) => setField("manufacturer", e.target.value)}
              required
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
              <RequiredMark t={t} />
              <select
                value={form.model}
                onChange={(e) => setField("model", e.target.value)}
                required
              >
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
                <RequiredMark t={t} />
                <input
                  value={form.otherManufacturer}
                  onChange={(e) => setField("otherManufacturer", e.target.value)}
                  required
                />
              </label>
              <label className="planner-field">
                {t("model")}
                <RequiredMark t={t} />
                <input
                  value={form.otherModel}
                  onChange={(e) => setField("otherModel", e.target.value)}
                  required
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
          <label className="planner-field">
            {t("fuelType")}
            <select value={form.fuelType} onChange={(e) => setField("fuelType", e.target.value)}>
              <option value="gasoline">{t("fuelGasoline")}</option>
              <option value="diesel">{t("fuelDiesel")}</option>
            </select>
          </label>
        </>
      )}

      {form.modified && (
        <>
          <p className="planner-note">{t("modifiedHint")}</p>
          <label className="planner-field">
            {t("manufacturerOptional")}
            <RequiredMark t={t} titleKey="requiredOneOf" />
            <input
              value={form.otherManufacturer}
              onChange={(e) => setField("otherManufacturer", e.target.value)}
            />
          </label>
          <label className="planner-field">
            {t("modelOptional")}
            <RequiredMark t={t} titleKey="requiredOneOf" />
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
            <RequiredMark t={t} titleKey="requiredOneOf" />
            <input
              inputMode="decimal"
              value={form.engineDisplacementL}
              onChange={(e) => setField("engineDisplacementL", e.target.value)}
              placeholder="2.5"
            />
          </label>
          <label className="planner-field">
            {t("engineType")}
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
            <RequiredMark t={t} titleKey="requiredOneOf" />
            <textarea
              value={form.modifications}
              onChange={(e) => setField("modifications", e.target.value)}
              rows={2}
            />
            <span className="planner-required-hint">{t("requiredOneOf")}</span>
          </label>
          <label className="planner-field">
            {t("fuelType")}
            <RequiredMark t={t} />
            <select value={form.fuelType} onChange={(e) => setField("fuelType", e.target.value)}>
              <option value="gasoline">{t("fuelGasoline")}</option>
              <option value="diesel">{t("fuelDiesel")}</option>
              <option value="unknown">{t("fuelUnknown")}</option>
            </select>
          </label>
        </>
      )}

      {variant === "manage" && (
        <label className="planner-check">
          <input
            type="checkbox"
            checked={form.isDefault}
            onChange={(e) => setField("isDefault", e.target.checked)}
          />
          <span>{t("setDefaultVehicle")}</span>
        </label>
      )}

      {showActions && (
        <div className="planner-actions">
          <button
            type="submit"
            className="planner-btn primary"
            disabled={busy || !isVehicleFormValid(form)}
          >
            {busy ? t("pleaseWait") : submitLabel || t("saveVehicle")}
          </button>
          {onCancel && (
            <button type="button" className="planner-btn ghost" onClick={onCancel} disabled={busy}>
              {t("cancel")}
            </button>
          )}
        </div>
      )}
    </form>
  );
}
