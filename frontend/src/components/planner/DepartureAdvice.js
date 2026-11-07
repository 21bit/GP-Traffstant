import React, { useMemo } from "react";
import { useLanguage } from "../../LanguageContext";

function formatClock(date) {
  try {
    return new Intl.DateTimeFormat("ar-SA", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(date);
  } catch (_err) {
    return date.toLocaleTimeString();
  }
}

function trafficLabel(t, level) {
  if (level === "high") return t("high");
  if (level === "medium") return t("medium");
  if (level === "low") return t("low");
  return t("medium");
}

/**
 * Hero departure recommendation — answers leave now / when / how long.
 */
export default function DepartureAdvice({
  recommendation,
  prediction,
  activeRoute,
  departureComparison = [],
}) {
  const { t } = useLanguage();

  const isWait = recommendation?.action === "wait";
  const waitMinutes = Number(recommendation?.waitMinutes) || 0;
  const travelMinutes = activeRoute?.travelTimeMinutes ?? null;
  const trafficLevel = activeRoute?.trafficLevel || prediction?.level || "medium";

  const recommendedSlot = useMemo(() => {
    if (!departureComparison.length) return null;
    if (isWait && waitMinutes > 0) {
      return (
        departureComparison.find((s) => s.offsetMinutes === waitMinutes) ||
        departureComparison.reduce((best, slot) =>
          slot.etaMinutes < best.etaMinutes ? slot : best
        )
      );
    }
    return departureComparison.find((s) => s.offsetMinutes === 0) || departureComparison[0];
  }, [departureComparison, isWait, waitMinutes]);

  const departAt = useMemo(() => {
    if (recommendedSlot?.departAt) return new Date(recommendedSlot.departAt);
    if (isWait && waitMinutes > 0) {
      return new Date(Date.now() + waitMinutes * 60_000);
    }
    return new Date();
  }, [recommendedSlot, isWait, waitMinutes]);

  const arrivalAt = useMemo(() => {
    const duration = recommendedSlot?.etaMinutes ?? travelMinutes ?? null;
    if (duration == null) return null;
    return new Date(departAt.getTime() + duration * 60_000);
  }, [departAt, recommendedSlot, travelMinutes]);

  if (!recommendation) return null;

  const journeyMinutes = recommendedSlot?.etaMinutes ?? travelMinutes;
  const headline = isWait
    ? t("recommendWaitUntil").replace("{time}", formatClock(departAt))
    : t("recommendLeaveNow");

  return (
    <section
      className={`planner-advice planner-departure-hero ${isWait ? "wait" : "go"}`}
      aria-live="polite"
    >
      <p className="planner-departure-kicker">{t("recommendedDeparture")}</p>
      <h2 className="planner-advice-title">{headline}</h2>

      <div className="planner-departure-facts">
        <div className="planner-departure-fact">
          <span>{t("departAtLabel")}</span>
          <strong>{isWait ? formatClock(departAt) : t("now")}</strong>
        </div>
        <div className="planner-departure-fact">
          <span>{t("journeyDuration")}</span>
          <strong>
            {journeyMinutes != null ? `${journeyMinutes} ${t("min")}` : "—"}
          </strong>
        </div>
        <div className="planner-departure-fact">
          <span>{t("arriveByLabel")}</span>
          <strong>{arrivalAt ? formatClock(arrivalAt) : "—"}</strong>
        </div>
        <div className="planner-departure-fact">
          <span>{t("trafficCondition")}</span>
          <strong>{trafficLabel(t, trafficLevel)}</strong>
        </div>
      </div>

      {isWait && recommendation.estimatedTimeSavedMinutes > 0 && (
        <p className="planner-departure-save">
          {t("timeSaved").replace(
            "{min}",
            String(recommendation.estimatedTimeSavedMinutes)
          )}
        </p>
      )}

      {!isWait && (
        <p className="planner-departure-save muted">{t("leaveNowSupport")}</p>
      )}

      {prediction?.source === "mock" && (
        <div className="planner-mock-badge" title={prediction.disclaimer || ""}>
          {t("mockPrediction")}
        </div>
      )}
    </section>
  );
}
