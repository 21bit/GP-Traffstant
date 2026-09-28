import React from "react";
import { useLanguage } from "../../LanguageContext";

function barColor(level) {
  if (level === "high") return "linear-gradient(180deg, #F97316, #C2410C)";
  if (level === "medium") return "linear-gradient(180deg, #FBBF24, #D97706)";
  return "linear-gradient(180deg, #5EEAD4, #0D9488)";
}

/**
 * Peak-hour trends: absolute congestion (0–100%) from TomTom slot ETAs,
 * with ETA labels so the chart is readable and comparable across slots.
 */
export default function DepartureTrends({ trends = [], departureComparison = [] }) {
  const { t } = useLanguage();

  const series =
    trends.length > 0
      ? trends
      : departureComparison.map((d) => ({
          offsetMinutes: d.offsetMinutes,
          congestionScore: d.congestionScore ?? 0.5,
          etaMinutes: d.etaMinutes,
          level: d.level,
          isBestDeparture: false,
        }));

  if (!series.length) return null;

  const etaValues = series
    .map((s) => s.etaMinutes)
    .filter((n) => typeof n === "number" && Number.isFinite(n));
  const minEta = etaValues.length ? Math.min(...etaValues) : null;
  const bestOffset =
    series.find((s) => s.isBestDeparture)?.offsetMinutes ??
    series.find((s) => s.etaMinutes === minEta)?.offsetMinutes;

  return (
    <section className="planner-section">
      <h3>{t("peakTrends")}</h3>
      <p className="planner-muted planner-trends-hint">{t("peakTrendsHint")}</p>
      <div className="planner-trends" role="img" aria-label={t("peakTrends")}>
        {series.map((slot) => {
          const score = Math.min(1, Math.max(0, Number(slot.congestionScore) || 0));
          // Absolute scale so flat mock hours don't all render as full-height bars
          const heightPct = Math.round(score * 100);
          const isBest = slot.offsetMinutes === bestOffset;
          const level =
            slot.level ||
            (score >= 0.68 ? "high" : score >= 0.36 ? "medium" : "low");

          return (
            <div
              key={slot.offsetMinutes}
              className={`planner-trend-col ${isBest ? "best" : ""}`}
              title={`${Math.round(score * 100)}% · ${slot.etaMinutes ?? "—"} ${t("min")}`}
            >
              <div className="planner-trend-eta">
                {slot.etaMinutes != null
                  ? `${slot.etaMinutes}${t("minShort")}`
                  : "—"}
              </div>
              <div className="planner-trend-bar-wrap">
                <div
                  className="planner-trend-bar"
                  style={{
                    height: `${Math.max(6, heightPct)}%`,
                    background: barColor(level),
                  }}
                />
              </div>
              <span className="planner-trend-label">
                {slot.offsetMinutes === 0
                  ? t("now")
                  : `+${slot.offsetMinutes}`}
              </span>
              <span className="planner-trend-pct">{Math.round(score * 100)}%</span>
              {isBest && (
                <span className="planner-trend-best">{t("bestSlot")}</span>
              )}
            </div>
          );
        })}
      </div>
      {departureComparison.length > 0 && (
        <ul className="planner-departure-list">
          {departureComparison.map((slot) => (
            <li key={slot.offsetMinutes}>
              <span>
                {slot.offsetMinutes === 0
                  ? t("leaveNowShort")
                  : t("leaveIn").replace("{min}", String(slot.offsetMinutes))}
              </span>
              <span>
                {slot.etaMinutes} {t("min")}
                {slot.trafficDelayMinutes > 0
                  ? ` · +${slot.trafficDelayMinutes} ${t("delay")}`
                  : ""}
                {" · "}
                {t("healthScore")} {slot.routeHealthScore}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
