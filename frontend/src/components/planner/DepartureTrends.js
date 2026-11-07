import React from "react";
import { useLanguage } from "../../LanguageContext";

function formatClock(iso) {
  try {
    return new Intl.DateTimeFormat("ar-SA", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(new Date(iso));
  } catch (_err) {
    return "";
  }
}

function trafficLabel(t, level) {
  if (level === "high") return t("high");
  if (level === "medium") return t("medium");
  if (level === "low") return t("low");
  return "";
}

/**
 * Simple departure-time comparison cards — no technical chart.
 */
export default function DepartureTrends({ trends = [], departureComparison = [] }) {
  const { t } = useLanguage();

  const series =
    departureComparison.length > 0
      ? departureComparison
      : trends.map((s) => ({
          offsetMinutes: s.offsetMinutes,
          etaMinutes: s.etaMinutes,
          level: s.level,
          departAt: null,
          isBestDeparture: s.isBestDeparture,
        }));

  if (!series.length) return null;

  const etaValues = series
    .map((s) => s.etaMinutes)
    .filter((n) => typeof n === "number" && Number.isFinite(n));
  const minEta = etaValues.length ? Math.min(...etaValues) : null;
  const bestOffset =
    series.find((s) => s.isBestDeparture)?.offsetMinutes ??
    series.find((s) => s.etaMinutes === minEta)?.offsetMinutes ??
    0;

  return (
    <section className="planner-section planner-departure-options">
      <h3>{t("departureOptionsTitle")}</h3>
      <p className="planner-muted planner-trends-hint">{t("departureOptionsHint")}</p>

      <div className="planner-depart-cards" role="list">
        {series.map((slot) => {
          const isBest = slot.offsetMinutes === bestOffset;
          const label =
            slot.offsetMinutes === 0
              ? t("leaveNowShort")
              : t("leaveIn").replace("{min}", String(slot.offsetMinutes));
          const clock = slot.departAt ? formatClock(slot.departAt) : null;
          const saved =
            minEta != null && slot.etaMinutes != null
              ? Math.max(0, slot.etaMinutes - minEta)
              : 0;

          return (
            <div
              key={slot.offsetMinutes}
              role="listitem"
              className={`planner-depart-card ${isBest ? "best" : ""}`}
            >
              <div className="planner-depart-card-top">
                <strong>{label}</strong>
                {isBest && <span className="planner-depart-best">{t("bestSlot")}</span>}
              </div>
              {clock && <div className="planner-depart-clock">{clock}</div>}
              <div className="planner-depart-eta">
                {slot.etaMinutes != null
                  ? `${slot.etaMinutes} ${t("min")}`
                  : "—"}
              </div>
              <div className="planner-depart-meta">
                {trafficLabel(t, slot.level || slot.trafficLevel)}
                {saved > 0 ? ` · +${saved} ${t("minShort")}` : ""}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
