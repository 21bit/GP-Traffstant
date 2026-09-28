import React, { useEffect } from "react";
import { Marker, Popup } from "react-leaflet";
import L from "leaflet";

// ─── Pulse animation injection ────────────────────────────────────────────────
//
// Animations are scoped to a unique class prefix ("incident-") to prevent
// collision with any other Leaflet icons that also inject global styles.
// The animation is placed on the INNER div inside the html string — NOT on
// the L.divIcon className — because Leaflet's outer wrapper has no explicit
// dimensions and would stretch unboundedly if a transform/filter is applied.

const STYLE_ID = "incident-marker-styles";

const injectStyles = () => {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    @keyframes incidentPulseRed {
      0%, 100% { box-shadow: 0 0 0 0   rgba(239,68,68,0.6), 0 4px 10px rgba(0,0,0,0.3); }
      50%       { box-shadow: 0 0 0 7px rgba(239,68,68,0),   0 4px 10px rgba(0,0,0,0.3); }
    }
    @keyframes incidentPulseOrange {
      0%, 100% { box-shadow: 0 0 0 0   rgba(245,158,11,0.6), 0 4px 10px rgba(0,0,0,0.3); }
      50%       { box-shadow: 0 0 0 7px rgba(245,158,11,0),   0 4px 10px rgba(0,0,0,0.3); }
    }
    .incident-pulse-red    { animation: incidentPulseRed    1.5s ease-in-out infinite; }
    .incident-pulse-orange { animation: incidentPulseOrange 2s   ease-in-out infinite; }
  `;
  document.head.appendChild(style);
};

// ─── Icon resolution ──────────────────────────────────────────────────────────
//
// Searches the combined text of type + message + description so the correct
// icon is returned even when the API places the category in a non-type field.

const ICON_SIZE   = 32;
const ICON_ANCHOR = ICON_SIZE / 2; // centres the circle on the coordinate

// Returns null for any incident that doesn't belong to the two tracked
// categories (roadworks / closure). The render loop treats null as "skip".
const resolveIncidentConfig = (incident) => {
  const text = `${incident.type ?? ""} ${incident.message ?? ""} ${incident.description ?? ""}`.toLowerCase();

  if (text.includes("work") || text.includes("construction")) {
    return { color: "#F59E0B", emoji: "🚧", pulseClass: "incident-pulse-orange" };
  }
  if (text.includes("closure") || text.includes("closed")) {
    return { color: "#EF4444", emoji: "⛔", pulseClass: "incident-pulse-red" };
  }
  return null;
};

// ─── divIcon factory ──────────────────────────────────────────────────────────
//
// className: "" — clears Leaflet's default "leaflet-div-icon" class which adds
// a white background and grey border. An empty string is essential; leaving it
// as the animation class name causes the unconstrained outer wrapper to receive
// transform/filter rules, creating the "giant beam" artifact.

const buildIncidentIcon = (incident) => {
  const config = resolveIncidentConfig(incident);
  if (!config) return null;

  return L.divIcon({
    className: "",
    html: `<div
        class="${config.pulseClass}"
        style="
          width: ${ICON_SIZE}px;
          height: ${ICON_SIZE}px;
          background: ${config.color};
          border: 2.5px solid white;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 16px;
          box-sizing: border-box;
          overflow: hidden;
          pointer-events: none;
        "
      >${config.emoji}</div>`,
    iconSize:     [ICON_SIZE, ICON_SIZE],
    iconAnchor:   [ICON_ANCHOR, ICON_ANCHOR],
    popupAnchor:  [0, -(ICON_ANCHOR + 4)],
  });
};

// ─── Coordinate guard ─────────────────────────────────────────────────────────
//
// Number("NaN") === NaN, Number(undefined) === NaN, Number("string") === NaN —
// all rejected by isFinite. String "0" coerces to 0 correctly.

const isValidLatLng = (lat, lng) => {
  const numLat = Number(lat);
  const numLng = Number(lng);
  return (
    Number.isFinite(numLat) && numLat >= -90  && numLat <= 90  &&
    Number.isFinite(numLng) && numLng >= -180 && numLng <= 180
  );
};

// ─── Component ────────────────────────────────────────────────────────────────

const MarkerClusterLayer = ({ incidents }) => {
  useEffect(() => {
    injectStyles();
  }, []);

  if (!incidents?.length) return null;

  return (
    <>
      {incidents.map((incident, index) => {
        // ?? preserves a legitimate 0 coordinate; || would discard it.
        const lat = incident.lat ?? incident.coords?.lat;
        const lng = incident.lng ?? incident.coords?.lng;

        if (!isValidLatLng(lat, lng)) return null;

        const icon = buildIncidentIcon(incident);
        if (!icon) return null;
        const displayText   = incident.message || incident.description || incident.type || "حادث";

        return (
          <Marker
            key={incident.id ?? index}
            position={[Number(lat), Number(lng)]}
            icon={icon}
          >
            <Popup>
              <div style={{ fontFamily: "inherit", textAlign: "center", minWidth: "130px" }}>
                <strong style={{ color: "#333", fontSize: "14px", display: "block", marginBottom: "4px" }}>
                  {displayText}
                </strong>
                <span style={{ fontSize: "12px", color: "#666" }}>
                  مستوى التأثير: {incident.severity || "غير محدد"}
                </span>
              </div>
            </Popup>
          </Marker>
        );
      })}
    </>
  );
};

export default MarkerClusterLayer; 
