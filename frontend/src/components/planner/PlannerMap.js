import React, { useEffect } from "react";
import {
  MapContainer,
  TileLayer,
  Marker,
  Polyline,
  useMap,
} from "react-leaflet";
import L from "leaflet";
import {
  RIYADH_CENTER,
  MAP_TILE_LAYERS,
  getMapTheme,
} from "../map/mapConfig";
import HeatmapLayer from "../HeatmapLayer";

// Fix default marker icons in CRA/webpack
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl:
    "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png",
  iconUrl:
    "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png",
  shadowUrl:
    "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png",
});

const originIcon = new L.DivIcon({
  className: "",
  html: `<div style="width:14px;height:14px;border-radius:50%;background:#0D9488;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35)"></div>`,
  iconSize: [14, 14],
  iconAnchor: [7, 7],
});

const destIcon = new L.DivIcon({
  className: "",
  html: `<div style="width:16px;height:16px;border-radius:50%;background:#C2410C;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35)"></div>`,
  iconSize: [16, 16],
  iconAnchor: [8, 8],
});

function FitBounds({ origin, destination, routeCoords }) {
  const map = useMap();

  useEffect(() => {
    const points = [];
    if (origin) points.push(origin);
    if (destination) points.push(destination);
    if (Array.isArray(routeCoords)) {
      routeCoords.forEach((c) => {
        if (Array.isArray(c) && c.length >= 2) points.push(c);
      });
    }
    if (points.length >= 2) {
      map.fitBounds(points, { padding: [48, 48], maxZoom: 13 });
    } else if (points.length === 1) {
      map.setView(points[0], 13);
    }
  }, [map, origin, destination, routeCoords]);

  return null;
}

/**
 * Preview-only map: heatmap + selected route + markers. No navigation HUD.
 */
export default function PlannerMap({
  origin,
  destination,
  routes = [],
  activeRouteId,
  trafficPoints = [],
}) {
  const theme = getMapTheme();
  const tiles = MAP_TILE_LAYERS[theme] || MAP_TILE_LAYERS.day;
  const activeRoute =
    routes.find((r) => r.id === activeRouteId) || routes[0] || null;
  const routeCoords = activeRoute?.coordinates || [];

  return (
    <MapContainer
      center={RIYADH_CENTER}
      zoom={11}
      style={{ height: "100%", width: "100%" }}
      zoomControl={false}
      attributionControl={false}
    >
      <TileLayer
        url={tiles.base}
        attribution={tiles.attribution}
        subdomains={tiles.subdomains}
        maxZoom={tiles.maxZoom}
      />
      {trafficPoints.length > 0 && (
        <HeatmapLayer trafficPoints={trafficPoints} />
      )}
      {routes.map((route) => {
        const isActive = !activeRoute || route.id === activeRoute.id;
        const coords = route.coordinates || [];
        if (coords.length < 2) return null;
        return (
          <Polyline
            key={route.id}
            positions={coords}
            pathOptions={{
              color: route.color || "#0D9488",
              weight: isActive ? 6 : 3,
              opacity: isActive ? 0.95 : 0.35,
            }}
          />
        );
      })}
      {origin && <Marker position={origin} icon={originIcon} />}
      {destination && <Marker position={destination} icon={destIcon} />}
      <FitBounds
        origin={origin}
        destination={destination}
        routeCoords={routeCoords}
      />
    </MapContainer>
  );
}
