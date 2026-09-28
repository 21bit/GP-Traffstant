import React from "react";
import { useLanguage } from "../../LanguageContext";

function healthTone(score) {
  if (score >= 75) return "good";
  if (score >= 50) return "ok";
  return "poor";
}

export default function RouteHealthCard({
  routes,
  activeRouteId,
  onSelectRoute,
}) {
  const { t } = useLanguage();
  if (!routes?.length) return null;

  return (
    <section className="planner-section">
      <h3>{t("routeOptions")}</h3>
      <div className="planner-route-list">
        {routes.map((route) => {
          const active = route.id === activeRouteId;
          const tone = healthTone(route.routeHealthScore);
          return (
            <button
              key={route.id}
              type="button"
              className={`planner-route-card ${active ? "active" : ""}`}
              onClick={() => onSelectRoute(route.id)}
            >
              <div className="planner-route-top">
                <span
                  className="planner-route-dot"
                  style={{ background: route.color }}
                />
                <strong>{route.label}</strong>
                <span className={`planner-health ${tone}`}>
                  {route.routeHealthScore}
                  <small>{t("healthScore")}</small>
                </span>
              </div>
              <div className="planner-route-meta">
                <span>
                  {route.travelTimeMinutes} {t("min")}
                </span>
                <span>
                  {route.distanceKm} {t("km")}
                </span>
                <span>{t(route.trafficLevel) || route.trafficLevel}</span>
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}
