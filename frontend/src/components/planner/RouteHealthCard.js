import React from "react";
import { useLanguage } from "../../LanguageContext";

function trafficLabel(t, level) {
  if (level === "high") return t("high");
  if (level === "medium") return t("medium");
  if (level === "low") return t("low");
  return t(level) || level || "";
}

export default function RouteHealthCard({
  routes,
  activeRouteId,
  onSelectRoute,
}) {
  const { t } = useLanguage();
  if (!routes?.length) {
    return (
      <section className="planner-section">
        <h3>{t("routeOptions")}</h3>
        <div className="planner-empty-card compact">
          <p>{t("noRoutesAvailable")}</p>
        </div>
      </section>
    );
  }

  return (
    <section className="planner-section">
      <h3>{t("routeOptions")}</h3>
      <p className="planner-muted planner-trends-hint">{t("routeOptionsHint")}</p>
      <div className="planner-route-list">
        {routes.map((route) => {
          const active = route.id === activeRouteId;
          const recommended = Boolean(route.isRecommended);
          return (
            <button
              key={route.id}
              type="button"
              className={`planner-route-card ${active ? "active" : ""} ${
                recommended ? "recommended" : ""
              }`}
              onClick={() => onSelectRoute(route.id)}
            >
              <div className="planner-route-top">
                <span
                  className="planner-route-dot"
                  style={{ background: route.color }}
                  aria-hidden="true"
                />
                <strong>{route.label}</strong>
                {recommended && (
                  <span className="planner-route-badge">{t("recommended")}</span>
                )}
              </div>
              <div className="planner-route-meta">
                <span>
                  {route.travelTimeMinutes} {t("min")}
                </span>
                <span>
                  {route.distanceKm} {t("km")}
                </span>
                <span>{trafficLabel(t, route.trafficLevel)}</span>
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}
