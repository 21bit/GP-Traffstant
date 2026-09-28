import React, { useEffect, useState } from "react";
import { useAuth } from "../../AuthContext";
import { useLanguage } from "../../LanguageContext";

export default function TripHistory({ onReuse, refreshKey }) {
  const { user, authFetch } = useAuth();
  const { t } = useLanguage();
  const [trips, setTrips] = useState([]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!user) {
      setTrips([]);
      return;
    }
    let cancelled = false;
    authFetch("/api/trips")
      .then((data) => {
        if (!cancelled) setTrips(data.trips || []);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [user, authFetch, refreshKey]);

  const removeTrip = async (id) => {
    try {
      await authFetch(`/api/trips/${id}`, { method: "DELETE" });
      setTrips((prev) => prev.filter((trip) => trip.id !== id));
    } catch (err) {
      setError(err.message);
    }
  };

  if (!user) {
    return (
      <section className="planner-section">
        <h3>{t("tripHistory")}</h3>
        <p className="planner-muted">{t("loginForHistory")}</p>
      </section>
    );
  }

  return (
    <section className="planner-section">
      <h3>{t("tripHistory")}</h3>
      {error && <div className="planner-error">{error}</div>}
      {trips.length === 0 ? (
        <p className="planner-muted">{t("noTripsYet")}</p>
      ) : (
        <ul className="planner-history-list">
          {trips.map((trip) => (
            <li key={trip.id}>
              <button
                type="button"
                className="planner-history-main"
                onClick={() => onReuse?.(trip)}
              >
                <strong>
                  {trip.originName || t("startPoint")} →{" "}
                  {trip.destName || t("destinationPoint")}
                </strong>
                <span>
                  {trip.travelTimeMinutes != null &&
                    `${trip.travelTimeMinutes} ${t("min")}`}
                  {trip.routeHealthScore != null &&
                    ` · ${t("healthScore")} ${trip.routeHealthScore}`}
                </span>
              </button>
              <button
                type="button"
                className="planner-icon-btn"
                onClick={() => removeTrip(trip.id)}
                aria-label={t("delete")}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
