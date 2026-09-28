import React from "react";
import { useLanguage } from "../../LanguageContext";

export default function FuelEstimate({ fuelEstimate }) {
  const { t } = useLanguage();
  if (!fuelEstimate) return null;

  return (
    <section className="planner-section planner-fuel">
      <h3>{t("fuelEstimate")}</h3>
      <div className="planner-fuel-row">
        <div>
          <strong>{fuelEstimate.liters}</strong>
          <span>{t("liters")}</span>
        </div>
        <div>
          <strong>{fuelEstimate.costSar}</strong>
          <span>{t("sar")}</span>
        </div>
      </div>
    </section>
  );
}
