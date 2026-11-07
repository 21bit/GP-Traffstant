import React, { useState } from "react";
import { useLanguage } from "../../LanguageContext";
import { vehicleDisplayName } from "../../utils/vehicleStorage";
import VehicleForm from "./VehicleForm";

export default function VehicleManager({
  vehicles,
  selectedId,
  onSelect,
  onSave,
  onDelete,
  onMakeDefault,
  loading,
  error,
  canPersist,
  onRequestAuth,
}) {
  const { t } = useLanguage();
  const [mode, setMode] = useState("list");
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState("");

  if (!canPersist) {
    return (
      <section className="planner-section planner-vehicles">
        <h3>{t("myVehicles")}</h3>
        <div className="planner-empty-card">
          <p>{t("signInToSaveVehicles")}</p>
          {onRequestAuth && (
            <button type="button" className="planner-btn primary" onClick={onRequestAuth}>
              {t("login")}
            </button>
          )}
        </div>
      </section>
    );
  }

  const startAdd = () => {
    setEditing(null);
    setMode("add");
    setLocalError("");
  };

  const startEdit = (vehicle) => {
    setEditing(vehicle);
    setMode("edit");
    setLocalError("");
  };

  const cancel = () => {
    setMode("list");
    setEditing(null);
    setLocalError("");
  };

  const handleSave = async (payload) => {
    setBusy(true);
    setLocalError("");
    try {
      await onSave(payload, editing?.id || null);
      setMode("list");
      setEditing(null);
    } catch (err) {
      if (err.code === "SIGN_IN_REQUIRED" || err.message === "SIGN_IN_REQUIRED") {
        onRequestAuth?.();
        setLocalError(t("signInToSaveVehicles"));
      } else {
        setLocalError(err.message || t("vehicleSaveFailed"));
      }
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (vehicle) => {
    if (!window.confirm(t("confirmDeleteVehicle"))) return;
    setBusy(true);
    setLocalError("");
    try {
      await onDelete(vehicle.id);
    } catch (err) {
      setLocalError(err.message || t("vehicleDeleteFailed"));
    } finally {
      setBusy(false);
    }
  };

  if (mode === "add" || mode === "edit") {
    return (
      <section className="planner-section planner-vehicles">
        <h3>{mode === "edit" ? t("editVehicle") : t("addVehicle")}</h3>
        <VehicleForm
          variant="manage"
          initialVehicle={editing}
          onSubmit={handleSave}
          onCancel={cancel}
          busy={busy}
        />
        {(localError || error) && (
          <div className="planner-error">{localError || error}</div>
        )}
      </section>
    );
  }

  return (
    <section className="planner-section planner-vehicles">
      <div className="planner-section-head">
        <h3>{t("myVehicles")}</h3>
        <button type="button" className="planner-btn ghost compact" onClick={startAdd}>
          {t("addVehicle")}
        </button>
      </div>

      {loading && vehicles.length === 0 && (
        <p className="planner-muted">{t("loadingVehicles")}</p>
      )}

      {!loading && vehicles.length === 0 && (
        <div className="planner-empty-card">
          <p>{t("noVehiclesYet")}</p>
          <button type="button" className="planner-btn primary" onClick={startAdd}>
            {t("addVehicle")}
          </button>
        </div>
      )}

      {vehicles.length > 0 && (
        <ul className="planner-vehicle-list" role="listbox" aria-label={t("myVehicles")}>
          {vehicles.map((vehicle) => {
            const selected = String(vehicle.id) === String(selectedId);
            return (
              <li key={vehicle.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={`planner-vehicle-card ${selected ? "active" : ""}`}
                  onClick={() => onSelect(vehicle.id)}
                >
                  <div className="planner-vehicle-card-main">
                    <strong>{vehicleDisplayName(vehicle)}</strong>
                    <span>
                      {vehicle.modified ? t("vehicleModifiedBadge") : t("vehicleStockBadge")}
                      {vehicle.fuelType === "gasoline"
                        ? ` · ${t("fuelGasoline")}`
                        : vehicle.fuelType === "diesel"
                          ? ` · ${t("fuelDiesel")}`
                          : vehicle.fuelType
                            ? ` · ${t("fuelUnknown")}`
                            : ""}
                    </span>
                  </div>
                  {vehicle.isDefault && (
                    <span className="planner-vehicle-default">{t("defaultVehicle")}</span>
                  )}
                </button>
                <div className="planner-vehicle-actions">
                  {!vehicle.isDefault && (
                    <button
                      type="button"
                      className="planner-link"
                      onClick={() => onMakeDefault(vehicle.id)}
                      disabled={busy}
                    >
                      {t("setDefault")}
                    </button>
                  )}
                  <button
                    type="button"
                    className="planner-link"
                    onClick={() => startEdit(vehicle)}
                    disabled={busy}
                  >
                    {t("edit")}
                  </button>
                  <button
                    type="button"
                    className="planner-link danger"
                    onClick={() => handleDelete(vehicle)}
                    disabled={busy}
                  >
                    {t("delete")}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {(localError || error) && (
        <div className="planner-error">{localError || error}</div>
      )}
    </section>
  );
}
