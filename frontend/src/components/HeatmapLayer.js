import { useEffect, useRef, useState } from "react";
import { useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import "leaflet.heat";

// Intensity values per traffic density category
const DENSITY_INTENSITY = {
  high: 1.0,
  medium: 0.6,
  low: 0.25,
};

// Smooth gradient: green → yellow → orange → red
const HEATMAP_GRADIENT = {
  0.0:  "#22c55e",  // green  — free flow
  0.35: "#eab308",  // yellow — mild slowdown
  0.60: "#f97316",  // orange — moderate congestion
  1.0:  "#ef4444",  // red    — heavy congestion
};

/**
 * Returns heatmap options tuned to the current zoom level.
 * At lower zoom, wider radius/blur cover more area.
 * At higher zoom, tighter radius reveals street-level detail.
 * Opacity also increases with zoom so heatmap is more prominent when zoomed in.
 */
const buildHeatmapOptions = (zoom) => {
  const zoomFactor = Math.max(0, zoom - 10); // 0 at zoom 10, grows from there
  const radius = Math.max(18, 50 - zoomFactor * 3);
  const blur   = Math.max(14, 38 - zoomFactor * 2);
  const minOpacity = Math.min(0.65, 0.25 + zoomFactor * 0.06);

  return {
    radius,
    blur,
    maxZoom: zoom + 2,
    max: 1.0,
    minOpacity,
    gradient: HEATMAP_GRADIENT,
  };
};

/**
 * Renders a Leaflet heatmap layer from traffic density points.
 * Automatically adapts radius, blur, and opacity as the user zooms.
 * Must be rendered inside a <MapContainer>.
 */
const HeatmapLayer = ({ trafficPoints }) => {
  const map = useMap();
  const heatLayerRef = useRef(null);
  const [currentZoom, setCurrentZoom] = useState(() => map?.getZoom() ?? 12);

  // Track zoom changes inside the map
  useMapEvents({
    zoomend: (e) => setCurrentZoom(e.target.getZoom()),
  });

  useEffect(() => {
    if (!map || typeof L.heatLayer !== "function") return;

    const heatData = trafficPoints
      .filter((p) => p.density && p.density !== "unknown")
      .map((p) => [p.lat, p.lng, DENSITY_INTENSITY[p.density] ?? 0.3]);

    // Remove the existing layer before adding a fresh one
    if (heatLayerRef.current) {
      map.removeLayer(heatLayerRef.current);
      heatLayerRef.current = null;
    }

    if (heatData.length > 0) {
      const options = buildHeatmapOptions(currentZoom);
      heatLayerRef.current = L.heatLayer(heatData, options).addTo(map);
    }

    return () => {
      if (heatLayerRef.current) {
        map.removeLayer(heatLayerRef.current);
        heatLayerRef.current = null;
      }
    };
    // Re-build whenever points change OR zoom changes
  }, [map, trafficPoints, currentZoom]);

  return null;
};

export default HeatmapLayer;
