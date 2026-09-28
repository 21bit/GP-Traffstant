import React from "react";
import { useLanguage } from "../../LanguageContext";

export default function DepartureAdvice({ recommendation, prediction }) {
  const { t } = useLanguage();
  if (!recommendation) return null;

  const isWait = recommendation.action === "wait";

  return (
    <section className={`planner-advice ${isWait ? "wait" : "go"}`}>
      <div className="planner-advice-title">
        {isWait ? t("adviceWait") : t("adviceLeaveNow")}
      </div>
      <p>{recommendation.reason}</p>
      {isWait && recommendation.waitMinutes > 0 && (
        <div className="planner-advice-meta">
          {t("waitFor").replace("{min}", String(recommendation.waitMinutes))}
          {recommendation.estimatedTimeSavedMinutes > 0 && (
            <span>
              {" · "}
              {t("timeSaved").replace(
                "{min}",
                String(recommendation.estimatedTimeSavedMinutes)
              )}
            </span>
          )}
        </div>
      )}
      {prediction?.source === "mock" && (
        <div className="planner-mock-badge" title={prediction.disclaimer || ""}>
          {t("mockPrediction")}
        </div>
      )}
    </section>
  );
}
