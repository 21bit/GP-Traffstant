import React, { useEffect, useState } from "react";
import { useLanguage } from "../../LanguageContext";

const STATUS_KEYS = ["loadingRoutesStatus", "loadingDepartureStatus"];

export default function DecisionLoading() {
  const { t } = useLanguage();
  const [statusIndex, setStatusIndex] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setStatusIndex((i) => (i + 1) % STATUS_KEYS.length);
    }, 2200);
    return () => clearInterval(timer);
  }, []);

  return (
    <section className="planner-section planner-loading" aria-busy="true" aria-live="polite">
      <p className="planner-loading-status">{t(STATUS_KEYS[statusIndex])}</p>

      <div className="planner-skeleton planner-skeleton-advice">
        <div className="planner-skeleton-line w-40" />
        <div className="planner-skeleton-line w-90" />
        <div className="planner-skeleton-line w-70" />
      </div>

      <div className="planner-route-list">
        {[0, 1, 2].map((i) => (
          <div key={i} className="planner-skeleton planner-skeleton-route">
            <div className="planner-skeleton-line w-55" />
            <div className="planner-skeleton-line w-80" />
          </div>
        ))}
      </div>
    </section>
  );
}
