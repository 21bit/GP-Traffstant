/**
 * MapContainer — Leaflet map host component.
 *
 * Responsibilities:
 *   • Renders the react-leaflet map with auto-switching day/night tile layer.
 *   • Renders the traffic heatmap (real data or simulation frames).
 *   • Renders incident markers via MarkerClusterLayer.
 *   • Renders route polylines with multi-route support and active highlight.
 *   • Renders start, end, and user-location markers.
 *   • Renders metro route overlay and station markers.
 *   • Exposes imperative map actions (fitBounds, flyTo, panTo) via onMapReady.
 *   • Forwards map events (click, zoom, drag) to parent callbacks.
 */

import React, { useEffect, useRef, useState, useMemo } from "react";
import {
  MapContainer as LeafletMap,
  TileLayer,
  Polyline,
  Marker,
  Popup,
  useMap,
  useMapEvents,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
// leaflet-rotate is a side-effect import: it monkey-patches L.Map with a
// `rotate` constructor option and `setBearing()` / `getBearing()` methods.
// Required for the heading-up navigation camera (rotates the entire basemap
// so the road ahead points to the top of the screen, like Google Maps in
// driving mode).  Loading it here exactly once keeps the patch global.
import "leaflet-rotate";
import HeatmapLayer from "../HeatmapLayer";
import MarkerClusterLayer from "../MarkerClusterLayer";
import { RIYADH_CENTER, MAP_TILE_LAYERS, getMapTheme } from "./mapConfig";

// ─── Smooth marker animation tuning ───────────────────────────────────────────
//
// Duration the AnimatedNavigationMarker takes to tween between two GPS fixes.
// Most consumer-grade GPS receivers emit fixes at 1 Hz, so a duration slightly
// shorter than 1 s keeps the chevron continuously moving without queueing
// noticeable lag behind the live fix.  At 800 ms a brief stall (next fix
// arrives a beat late) only shows a ~200 ms pause rather than a teleport.
const NAV_MARKER_TWEEN_DURATION_MS = 800;

// Degrees of camera tilt applied to the Leaflet container during active
// navigation.  45° matches the "low horizon" perspective used by Google Maps
// and Waze in driving mode: the road ahead recedes toward the horizon while
// the driver's chevron stays large and prominent at the bottom of the viewport.
const NAVIGATION_PITCH_DEG = 45;

// jsDelivr mirrors the OSMBuildings GitHub repository directly.
// This avoids the broken npm publish (0.2.0b, no files) while still loading
// the correct Leaflet adapter build from the authoritative source.
const OSMBUILDINGS_CDN_URL =
  "https://cdn.jsdelivr.net/gh/kekscom/osmbuildings@master/OSMBuildings-Leaflet.debug.js";

// ─── Route colour palette ─────────────────────────────────────────────────────
// Mirrors the MapLegend colours in TrafficMap: recommended / least-traffic / shortest.

const ROUTE_PALETTE = ["#3B82F6", "#22C55E", "#94A3B8"];

// Night-mode active route uses Electric Cyan to pop against dark CartoDB tiles.
const NIGHT_ACTIVE_ROUTE_COLOR = "#00f2ff";

const getRouteColor = (route, routeIndex, isActive, theme) => {
  if (route?.color) return route.color;
  if (isActive && theme === "night") return NIGHT_ACTIVE_ROUTE_COLOR;
  return ROUTE_PALETTE[routeIndex] ?? "#3B82F6";
};

// ─── Leaflet DivIcon factories ────────────────────────────────────────────────

// Navigation arrowhead chevron icon.
//
// Design: aerodynamic silhouette in a 48×48 viewBox, pointing UP (12 o'clock)
// so `transform: rotate(Xdeg)` aligns with the driver's bearing (0 = north).
//
// Gradient-free: SVG linearGradients require globally-unique IDs.  Because
// Leaflet rebuilds the DivIcon HTML on every bearing change, there is a brief
// window where old and new elements coexist in the DOM, creating duplicate
// gradient IDs.  Browsers resolve duplicates unpredictably — the fill can
// fall back to transparent.  Solid fills avoid this entirely.
//
// CSS animation lives on .__rot (inner), NOT on the outer Leaflet-controlled
// div whose `transform` Leaflet uses for lat/lng positioning.  Animating
// `transform` on the outer element overrides Leaflet's positioning and makes
// the marker invisible.  See App.css → .nav-stealth-marker comment.
//
// `headingUp` mode: when the map ITSELF is being rotated by leaflet-rotate
// (heading-up driving camera), the chevron must NOT also rotate internally
// or it would double-rotate.  Passing headingUp=true forces the icon's
// inner SVG to render at 0° so the arrow visually points to the top of the
// screen (which is "the road ahead" on the rotated map).
const createNavigationChevronIcon = (bearingDeg = 0, headingUp = false) => {
  const rawBearing = Number.isFinite(bearingDeg) ? bearingDeg : 0;
  const safeBearing = headingUp ? 0 : rawBearing;
  return L.divIcon({
    // Empty className: Leaflet must own the outer div's transform exclusively.
    // The glow animation is applied via CSS class on the inner .__rot element.
    className: "nav-stealth-marker",
    html: `
      <div
        class="nav-stealth-marker__rot"
        style="
          width: 46px;
          height: 46px;
          display: flex;
          align-items: center;
          justify-content: center;
          transform: rotate(${safeBearing}deg);
          transform-origin: 50% 50%;
          overflow: visible;
        "
      >
        <svg
          width="46"
          height="46"
          viewBox="0 0 48 48"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
          style="overflow: visible; display: block;"
        >
          <!-- Arrowhead body — solid blue, always visible -->
          <path
            d="M24 3 L41 40 L24 33 L7 40 Z"
            fill="#3B82F6"
            stroke="rgba(255,255,255,0.90)"
            stroke-width="1.5"
            stroke-linejoin="round"
          />
          <!-- Specular highlight on the leading face -->
          <path
            d="M24 6 L37 36 L24 30 Z"
            fill="rgba(255,255,255,0.28)"
          />
          <!-- Centre spine for depth perception -->
          <path
            d="M24 8 L24 32"
            stroke="rgba(255,255,255,0.45)"
            stroke-width="1"
            stroke-linecap="round"
          />
        </svg>
      </div>`,
    iconSize: [46, 46],
    iconAnchor: [23, 23],
  });
};

const createUserLocationIcon = () =>
  L.divIcon({
    // Empty className keeps Leaflet from overriding any of our inline styles.
    className: "",
    html: `
      <div style="
        width: 22px;
        height: 22px;
        background: #3B82F6;
        border: 3px solid #ffffff;
        border-radius: 50%;
        box-shadow: 0 0 0 3px rgba(59,130,246,0.35), 0 2px 8px rgba(0,0,0,0.35);
        box-sizing: border-box;
        display: block;
        flex-shrink: 0;
      "></div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });

const createStartIcon = () =>
  L.divIcon({
    className: "",
    html: `<div style="
        width:20px;height:20px;background:#22C55E;border:2.5px solid white;
        border-radius:50%;
        box-shadow:0 0 0 3px rgba(34,197,94,0.3),0 2px 8px rgba(0,0,0,0.3);">
      </div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });

const createEndIcon = () =>
  L.divIcon({
    className: "",
    html: `<div style="
        width:20px;height:20px;background:#EF4444;border:2.5px solid white;
        border-radius:50%;
        box-shadow:0 0 0 3px rgba(239,68,68,0.3),0 2px 8px rgba(0,0,0,0.3);">
      </div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });

  const createMetroStationIcon = (lineColor) =>
    L.divIcon({
      className: "metro-station-icon",
      html: `<div style="
          width:30px;height:30px;
          background:${lineColor}; 
          border:2px solid white;
          border-radius:50%;
          box-shadow:0 0 10px rgba(0,0,0,0.3), inset 0 0 5px rgba(255,255,255,0.2);
          display:flex;align-items:center;justify-content:center;
          font-size:16px;
          color: white;">
        🚇
      </div>`,
      iconSize: [30, 30],
      iconAnchor: [15, 15],
      popupAnchor: [0, -15],
    });

// Colored dot icon for each participant's chosen location in the Meeting Point
// feature.  Color matches the leading dot in the Sidebar input field so the
// user can associate "Participant 1 (blue)" with its pin on the map.
const createParticipantIcon = (color) =>
  L.divIcon({
    className: "",
    html: `<div style="
        width:20px;height:20px;
        background:${color};
        border:2.5px solid white;
        border-radius:50%;
        box-shadow:0 0 0 3px ${color}55,0 2px 8px rgba(0,0,0,0.35);">
      </div>`,
    iconSize:   [20, 20],
    iconAnchor: [10, 10],
    popupAnchor: [0, -12],
  });

// Unique purple icon for meeting-point venue markers.
// The drop-shadow glow distinguishes them from incident and metro markers.
const createMeetingPlaceIcon = () =>
  L.divIcon({
    className: "",
    html: `<div style="
        width:34px;height:34px;
        background:linear-gradient(135deg,#7C3AED,#8B5CF6);
        border:2.5px solid white;
        border-radius:50%;
        box-shadow:0 0 0 3px rgba(139,92,246,0.35),0 2px 10px rgba(0,0,0,0.4);
        display:flex;align-items:center;justify-content:center;
        font-size:16px;">
      ☕
    </div>`,
    iconSize:    [34, 34],
    iconAnchor:  [17, 17],
    popupAnchor: [0, -18],
  });
// ─── ThemeTileLayer ───────────────────────────────────────────────────────────
//
// The `key` prop forces a full remount when the theme changes, which is the
// cleanest way to swap tile sources in react-leaflet v4.

const ThemeTileLayer = ({ theme }) => {
  const tileConfig = MAP_TILE_LAYERS[theme] ?? MAP_TILE_LAYERS.day;
  return (
    <TileLayer
      key={theme}
      url={tileConfig.base}
      attribution={tileConfig.attribution}
      subdomains={tileConfig.subdomains}
      maxZoom={tileConfig.maxZoom}
    />
  );
};


// ─── MapEvents ────────────────────────────────────────────────────────────────
//
// Must be a child of LeafletMap so it can call useMap() and useMapEvents().
// Handles three concerns:
//   1. Expose imperative map actions to the parent via onMapReady.
//   2. Fly to sidebar focus targets when they change.
//   3. Forward click / zoom / drag events to parent callbacks.

const MapEvents = ({
  onMapClick,
  onZoomChange,
  onDragStart,
  onMapReady,
  mapFocusTarget,
  onCenterChange,
}) => {
  const map = useMap();

  // Ref ensures the callback passed to onMapReady always holds the latest
  // function reference without requiring map actions to be re-registered.
  const onMapReadyRef = useRef(onMapReady);
  useEffect(() => {
    onMapReadyRef.current = onMapReady;
  }, [onMapReady]);

  useEffect(() => {
    if (!map) return;
    onMapReadyRef.current?.({
      fitBounds: (bounds, opts) => map.fitBounds(bounds, opts),
      flyTo: (center, zoom, opts) => map.flyTo(center, zoom, opts),
      panTo: (center, opts) => map.panTo(center, opts),
      /**
       * setViewOffset — re-centres the map on `center` at `zoom` but shifts
       * the anchor DOWNWARD by `offsetY` device pixels, so the blue chevron
       * sits in the lower-middle of the viewport with the route extending
       * above it (the framing convention used by Google Maps / Waze during
       * active turn-by-turn navigation).
       *
       * Implementation uses Leaflet's `project`/`unproject` at the target
       * zoom level so the offset is exact regardless of map dimensions or
       * current zoom.  `animate` and `duration` are forwarded so callers
       * can pick either an instant lock or a smooth camera follow.
       */
      setViewOffset: (center, zoom, offsetY = 0, opts = {}) => {
        const targetZoom = zoom ?? map.getZoom();
        const anchorPoint = map.project(center, targetZoom);
        const shiftedPoint = anchorPoint.subtract(L.point(0, offsetY));
        const shiftedCenter = map.unproject(shiftedPoint, targetZoom);
        const animate = opts.animate !== false;
        if (animate) {
          map.flyTo(shiftedCenter, targetZoom, {
            animate: true,
            duration: opts.duration ?? 0.6,
            noMoveStart: true,
          });
        } else {
          map.setView(shiftedCenter, targetZoom, { animate: false });
        }
      },
      getZoom: () => map.getZoom(),
      getSize: () => map.getSize(),
    });
  }, [map]);

  // Fly to map focus targets set by the Sidebar (e.g., search result selection).
  useEffect(() => {
    if (!mapFocusTarget || !map) return;
    map.flyTo(mapFocusTarget.coords, mapFocusTarget.zoom ?? 14, {
      animate: true,
      duration: 0.7,
    });
  }, [map, mapFocusTarget]);

  useMapEvents({
    click: (e) => onMapClick?.(e.latlng),
    zoomend: (e) => onZoomChange?.(e.target.getZoom()),
    dragstart: () => onDragStart?.(),
    moveend: (e) => {
      const center = e.target.getCenter();
      onCenterChange?.([center.lat, center.lng]);
    },
  });

  return null;
};

// ─── MapBearingDriver ─────────────────────────────────────────────────────────
//
// Drives the leaflet-rotate camera bearing.  Lives inside <LeafletMap> so it
// can grab the Leaflet map instance via useMap() — the same pattern as
// MapEvents.  Rotates the basemap so the driver's heading direction always
// points to the TOP of the screen (Google-Maps-style heading-up framing).
//
// Activation rules:
//   • `enabled` AND `setBearing` exists on the map (proves leaflet-rotate
//     is actually loaded — no-op gracefully if the plugin failed to apply).
//   • Otherwise the map snaps back to bearing 0 (north-up) so disabling the
//     toggle visibly "unwinds" the rotation rather than freezing it.
//
// Why we negate the bearing: a compass heading of 90° means the driver is
// travelling EAST.  To put the road-ahead direction at the top of the
// screen we need to rotate the WORLD by -90° (so east is now at 12
// o'clock).  leaflet-rotate's setBearing rotates the map clockwise by its
// argument, so we pass `-bearing`.

const MapBearingDriver = ({ bearing, enabled }) => {
  const map = useMap();

  useEffect(() => {
    if (!map || typeof map.setBearing !== "function") return;
    if (enabled && Number.isFinite(bearing)) {
      map.setBearing(-bearing);
    } else {
      // Snap back to north-up so the driver visibly sees the rotation reset.
      map.setBearing(0);
    }
  }, [map, bearing, enabled]);

  return null;
};

// ─── MapPitchDriver ───────────────────────────────────────────────────────────
//
// Simulates camera pitch by applying a CSS 3D perspective transform to the
// Leaflet map container element.  Leaflet does not expose a native pitch API
// (that is a Mapbox GL JS concept), so this approach uses the CSS function
// `perspective(Npx) rotateX(Ddeg)` which is GPU-accelerated and renders
// smoothly on mobile hardware.
//
// Transform origin `50% 100%` anchors the pivot at the bottom-centre of the
// container: the driver's area (bottom) stays at full scale while the road
// ahead (top) recedes toward the horizon — the same framing convention used
// by Google Maps and Waze in driving mode.
//
// No conflict with MapBearingDriver: leaflet-rotate applies its rotation to
// `.leaflet-map-pane` (a child element), NOT to the Leaflet container itself,
// so both transforms operate on independent DOM nodes.
//
// Limitation: Leaflet's click/touch hit-testing relies on
// `getBoundingClientRect`, which returns the perspective-projected bounding
// box.  Non-affine 3D perspective transforms cause slight lat/lng
// misregistration when tapping the tilted map.  This is acceptable during
// active turn-by-turn navigation because the map is in auto-follow mode and
// the driver does not manually tap map points while driving.

const MapPitchDriver = ({ pitch, enabled }) => {
  const map = useMap();

  useEffect(() => {
    const container = map?.getContainer?.();
    if (!container) return;

    // Set transition first so every subsequent transform change animates.
    container.style.transition      = "transform 0.6s ease-out";
    container.style.transformOrigin = "50% 100%";
    container.style.willChange      = enabled ? "transform" : "";
    container.style.transform       = enabled
      ? `perspective(1200px) rotateX(${pitch}deg)`
      : "perspective(1200px) rotateX(0deg)";

    // After the CSS perspective transition finishes (0.6s ease-out), force
    // Leaflet to re-measure its container and reload tiles for the correct
    // viewport.  Without this, Leaflet's internal canvas remains sized
    // against the pre-tilt bounding box and the map renders visually cropped
    // at the top or bottom once the 45° pitch is applied.
    // The 700ms delay is deliberately longer than the 0.6s transition so
    // invalidateSize() runs against the fully-settled layout, not mid-tween.
    const resizeAfterTransition = setTimeout(() => {
      map?.invalidateSize?.({ animate: false });
    }, 700);

    return () => {
      clearTimeout(resizeAfterTransition);
      // Smoothly reset to flat when navigation ends or component unmounts.
      const el = map?.getContainer?.();
      if (el) {
        el.style.transform = "perspective(1200px) rotateX(0deg)";
      }
    };
  }, [map, pitch, enabled]);

  return null;
};

// ─── BuildingsLayer ───────────────────────────────────────────────────────────
//
// Adds a 3D building extrusion overlay using OSMBuildings
// (https://osmbuildings.org).  OSMBuildings reads the `height` and
// `min_height` tags from OpenStreetMap data and renders each building footprint
// as an extruded 3D shape on an HTML5 canvas layer — the closest equivalent to
// Mapbox GL JS's `fill-extrusion` paint type that is available in a Leaflet
// map stack.
//
// Loading strategy: the OSMBuildings npm package (0.2.0b) was published
// without any distributable files, so the library is instead loaded lazily
// via a <script> tag from jsDelivr's GitHub CDN mirror.  The script is
// injected once (id="osmbuildings-cdn") and reused on subsequent renders.
// If the CDN is unreachable the onerror handler fires and the layer is
// silently disabled — the rest of the map is completely unaffected.
//
// Activation gate: zoom ≥ 15 where individual buildings are legible and
// per-building height data is meaningful.  The layer is torn down on
// zoom-out to avoid unnecessary canvas work on mobile.
//
// All initialisation is wrapped in try/catch so that any runtime
// incompatibility between osmbuildings 0.2.x and Leaflet 1.9.x is caught
// silently — the map continues to function without the 3D layer.

const OSMBUILDINGS_SCRIPT_ID = "osmbuildings-cdn";

const BuildingsLayer = ({ enabled }) => {
  const map     = useMap();
  const osmbRef = useRef(null);

  useEffect(() => {
    if (!map) return;

    if (!enabled) {
      try { osmbRef.current?.remove?.(); } catch { /* ignore */ }
      osmbRef.current = null;
      return;
    }

    const initLayer = () => {
      if (osmbRef.current) return; // Layer already active.

      try {
        const Ctor = window.OSMBuildings;
        if (typeof Ctor !== "function") return;

        const osmb = new Ctor(map, {
          minZoom: 15,
          attribution:
            '© <a href="https://osmbuildings.org" target="_blank" rel="noopener noreferrer">OSM Buildings</a>',
        });

        // Pass the current time so OSMBuildings can compute sun angle / shadows.
        osmb.date(new Date());

        // Load building footprints from the OSM Buildings data API.
        // The default endpoint serves OSM-tagged height + base_height data.
        osmb.load();

        osmbRef.current = osmb;
      } catch {
        // osmbuildings could not initialise — 3D buildings silently disabled.
      }
    };

    // If the library is already present (e.g. a previous zoom-in loaded it),
    // initialise immediately without a second script injection.
    if (window.OSMBuildings) {
      initLayer();
      return () => {
        try { osmbRef.current?.remove?.(); } catch { /* ignore */ }
        osmbRef.current = null;
      };
    }

    // Inject the CDN <script> only once per page load.
    let script = document.getElementById(OSMBUILDINGS_SCRIPT_ID);
    if (!script) {
      script = document.createElement("script");
      script.id  = OSMBUILDINGS_SCRIPT_ID;
      script.src = OSMBUILDINGS_CDN_URL;
      script.async = true;
      script.onerror = () => {
        // CDN unreachable — 3D buildings silently disabled.
      };
      document.head.appendChild(script);
    }
    script.addEventListener("load", initLayer);

    return () => {
      script.removeEventListener("load", initLayer);
      try { osmbRef.current?.remove?.(); } catch { /* ignore */ }
      osmbRef.current = null;
    };
  }, [map, enabled]);

  return null;
};

// ─── AnimatedNavigationMarker ─────────────────────────────────────────────────
//
// Smoothly tweens the navigation chevron between successive GPS fixes
// instead of teleporting it on each update.  Eliminates the "jumpy" feel
// reported during field testing — phones emit fixes at ~1 Hz, so without
// interpolation the chevron snaps from one position to the next every
// second.  With this component active, the chevron flows continuously and
// matches the visual smoothness of native turn-by-turn apps.
//
// Implementation notes:
//   • Uses requestAnimationFrame so the tween runs at the display's refresh
//     rate (60–120 Hz) and yields cleanly when the tab is backgrounded.
//   • Mutates the Leaflet marker via marker.setLatLng() rather than React
//     state — this means the parent component does NOT re-render on every
//     animation frame, so the speedometer / ETA / banner overlays stay
//     completely untouched.
//   • CRITICAL: the <Marker> is given a STABLE `initialPosition` prop that
//     is captured once when the first valid fix arrives, and then NEVER
//     updated.  This is essential: react-leaflet's Marker.js calls
//     `marker.setLatLng(props.position)` whenever the position prop changes
//     (see node_modules/react-leaflet/lib/Marker.js line 10), which would
//     teleport the marker mid-tween and undo our animation.  By keeping the
//     prop stable after first mount, all post-mount position changes flow
//     exclusively through the rAF tween below.
//   • Only animates while `isNavigating`.  In preview mode the marker
//     snaps directly to the new position (no need for tweening on a static
//     pin).
//   • Cubic ease-in-out feels organic; linear interpolation feels robotic.
//   • Cancels any in-flight animation when a new target arrives so a fast
//     burst of fixes doesn't queue stale frames.

const isValidPosition = (pos) =>
  Array.isArray(pos) &&
  pos.length >= 2 &&
  Number.isFinite(pos[0]) &&
  Number.isFinite(pos[1]);

const AnimatedNavigationMarker = ({
  position,
  icon,
  isNavigating,
  durationMs = NAV_MARKER_TWEEN_DURATION_MS,
}) => {
  const markerRef = useRef(null);
  const animationFrameRef = useRef(null);

  // Captured once when the first valid position arrives, then frozen for
  // the remainder of the marker's lifetime.  See "CRITICAL" note above.
  const [initialPosition, setInitialPosition] = useState(() =>
    isValidPosition(position) ? position : null
  );
  useEffect(() => {
    if (initialPosition === null && isValidPosition(position)) {
      setInitialPosition(position);
    }
  }, [initialPosition, position]);

  useEffect(() => {
    const marker = markerRef.current;
    if (!marker || !isValidPosition(position)) return;

    // Snap immediately when not navigating — the static blue dot doesn't
    // need tweening and animating it would mask the user moving the map.
    if (!isNavigating) {
      marker.setLatLng(position);
      return;
    }

    const startLatLng = marker.getLatLng();
    const startLat = startLatLng.lat;
    const startLng = startLatLng.lng;
    const targetLat = position[0];
    const targetLng = position[1];
    const startTime = performance.now();

    const animate = (now) => {
      const t = Math.min(1, (now - startTime) / durationMs);
      // Cubic ease-in-out: gentle start, brisk middle, gentle finish.
      const eased = t < 0.5
        ? 2 * t * t
        : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const lat = startLat + (targetLat - startLat) * eased;
      const lng = startLng + (targetLng - startLng) * eased;
      marker.setLatLng([lat, lng]);
      if (t < 1) {
        animationFrameRef.current = requestAnimationFrame(animate);
      }
    };

    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
    }
    animationFrameRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [position, isNavigating, durationMs]);

  if (initialPosition === null) return null;

  return (
    <Marker
      ref={markerRef}
      position={initialPosition}
      icon={icon}
      zIndexOffset={500}
    />
  );
};

// ─── Incident type allowlist ──────────────────────────────────────────────────
//
// Generic speed/flow data points that may arrive in the incidents array are
// excluded here so the cluster layer only renders true incident markers.
// const KNOWN_INCIDENT_TYPES = new Set([
//   "accident",      // حادث
//   "road closure",  // إغلاق طريق ⛔
//   "roadworks",     // حفريات 🚧
//   "construction",  // أعمال إنشاء/صبات 🏗️
//   "hazard",        // خطر عام
//   "heavy traffic"  // زحمة غير طبيعية
// ]);




// const normalizeIncidentType = (incidentType) =>
//   typeof incidentType === "string" ? incidentType.trim().toLowerCase() : "";

// Rejects NaN, Infinity, strings, and coordinates outside Leaflet's accepted bounds.
const isValidLatLng = (lat, lng) => {
  const numLat = Number(lat);
  const numLng = Number(lng);
  return (
    Number.isFinite(numLat) && numLat >= -90  && numLat <= 90  &&
    Number.isFinite(numLng) && numLng >= -180 && numLng <= 180
  );
};

// ─── قائمة محطات المترو الثابتة (تظهر دائماً على الخريطة) ──────────────────────
// ─── قائمة محطات المترو الثابتة (موسعة لتغطية مسارات الرياض) ──────────────────────
const RIYADH_METRO_STATIONS = [
  // 🔵 المسار الأزرق (محور العليا - البطحاء)
  { nameAr: "مركز الملك عبدالله المالي", nameEn: "KAFD Station", color: "#3B82F6", coords: [24.7607, 46.6318] },
  { nameAr: "محطة العليا", nameEn: "Olaya Station", color: "#3B82F6", coords: [24.7003, 46.6806] },
  { nameAr: "محطة البطحاء", nameEn: "Al Batha Station", color: "#3B82F6", coords: [24.6300, 46.7150] },
  
  // 🔴 المسار الأحمر (محور طريق الملك عبدالله)
  { nameAr: "جامعة الملك سعود", nameEn: "KSU Station", color: "#EF4444", coords: [24.7170, 46.6150] },
  { nameAr: "واحة الملك سلمان", nameEn: "King Salman Oasis", color: "#EF4444", coords: [24.7350, 46.6700] },
  { nameAr: "مركز المعارض", nameEn: "Exhibition Center", color: "#EF4444", coords: [24.7450, 46.7200] },

  // 🟠 المسار البرتقالي (محور طريق المدينة المنورة)
  { nameAr: "قصر الحكم", nameEn: "Qasr Al Hokm", color: "#F59E0B", coords: [24.6312, 46.7135] },
  { nameAr: "المحطة الغربية", nameEn: "Western Station", color: "#F59E0B", coords: [24.6050, 46.6400] },

  // 🟡 المسار الأصفر (محور مطار الملك خالد)
  { nameAr: "مطار الملك خالد", nameEn: "KKIA Station", color: "#EAB308", coords: [24.9576, 46.7002] },
  { nameAr: "جامعة الأميرة نورة", nameEn: "PNU Station", color: "#EAB308", coords: [24.8450, 46.7250] },

  // 🟢 المسار الأخضر (محور طريق الملك عبدالعزيز)
  { nameAr: "وزارة التعليم", nameEn: "Ministry of Education", color: "#10B981", coords: [24.7100, 46.6900] },
  { nameAr: "مدينة الملك عبدالعزيز الطبية", nameEn: "KAMC", color: "#10B981", coords: [24.7500, 46.6850] },

  // 🟣 المسار البنفسجي (محور طريق عبدالرحمن بن عوف)
  { nameAr: "جامعة الإمام محمد بن سعود", nameEn: "Imam University", color: "#8B5CF6", coords: [24.8100, 46.7050] }
]; 
// ─── MapContainer ─────────────────────────────────────────────────────────────

const MapContainer = ({
  trafficPoints,
  currentZoom,
  allRoutes,
  activeRouteIndex,
  displayStart,
  endCoords,
  startCoords,
  incidents,
  isNavigating,
  // True once Drive Mode unlocks (the driver has physically started moving).
  // Drives two visual changes: alternate routes are hidden, and the heading-up
  // camera engages.  Both behaviours match Google Maps' driving framing.
  isLiveTracking,
  userLocation,
  navBearing,
  // Heading-up driving camera flag.  When true AND isLiveTracking, the entire
  // basemap rotates so navBearing direction points to the top of the screen.
  // Defaulted to false for non-navigation callers / older parents that
  // haven't been updated to pass it through.
  headingUp = false,
  navigationOrigin,
  metroAlternative,
  metroRouteVisible,
  mapFocusTarget,
  simulationActive,
  simulationFrame,
  simulatedFramesRef,
  // Meeting Point feature
  meetingPlaces,
  meetingMidpoint,
  meetingParticipants,
  onMapClick,
  onRouteSelect,
  onMetroMarkerClick,
  onZoomChange,
  onMapReady,
  onDragStart,
  onThemeChange,
  onCenterChange,
  t,
}) => {
  const [mapTheme] = useState(() => getMapTheme());
  const [showTrafficFlow, setShowTrafficFlow] = useState(true);

  // Epoch changes every 90 seconds to force a tile cache-bust so the traffic
  // overlay shows the freshest congestion data available from TomTom.
  const [trafficTileEpoch, setTrafficTileEpoch] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const id = setInterval(
      () => setTrafficTileEpoch(Math.floor(Date.now() / 1000)),
      90_000
    );
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    onThemeChange?.(mapTheme);
  }, [mapTheme, onThemeChange]);

  const filteredIncidents = useMemo(() => {
    if (!incidents?.length) return [];

    const hasValidCoords = (incident) => {
      const lat = incident.lat ?? incident.coords?.lat;
      const lng = incident.lng ?? incident.coords?.lng;
      return isValidLatLng(lat, lng);
    };

    const incidentText = (incident) =>
      `${incident.type ?? ""} ${incident.message ?? ""} ${incident.description ?? ""}`.toLowerCase();

    // Closures: only high-impact events warrant a hard-blocked road marker.
    const closures = incidents
      .filter((incident) => {
        const text = incidentText(incident);
        return text.includes("closure") || text.includes("closed");
      })
      .filter((incident) => {
        const severity = (incident.severity || "").toLowerCase();
        return severity === "high" || severity === "severe";
      })
      .filter(hasValidCoords)
      .slice(0, 10);

    // Roadworks: APIs commonly mark these "low/minor/moderate" because the road
    // isn't fully blocked, so we accept a wider severity range for this category.
    const ROADWORK_SEVERITIES = new Set(["low", "minor", "moderate", "medium", "high", "severe"]);
    const roadworks = incidents
      .filter((incident) => {
        const text = incidentText(incident);
        return text.includes("work") || text.includes("construction");
      })
      .filter((incident) => {
        const severity = (incident.severity || "").toLowerCase();
        return ROADWORK_SEVERITIES.has(severity);
      })
      .filter(hasValidCoords)
      .slice(0, 10);

    return [...closures, ...roadworks];
  }, [incidents]);


  // When simulation is active, swap live traffic points for the current frame.
  const activeTrafficPoints = useMemo(() => {
    if (
      simulationActive &&
      simulatedFramesRef?.current?.[simulationFrame]
    ) {
      return simulatedFramesRef.current[simulationFrame];
    }
    return trafficPoints ?? [];
  }, [simulationActive, simulationFrame, simulatedFramesRef, trafficPoints]);

  // The map's bearing only follows the driver once Drive Mode unlocks AND
  // the heading-up toggle is on.  In preview / pre-movement mode we keep
  // the map north-up so the route preview reads naturally.
  const isMapBearingActive = isNavigating && isLiveTracking && headingUp;

  // Memoised icons — avoid re-creating Leaflet DivIcon objects every render.
  //
  // The navigation chevron re-creates whenever `navBearing` changes so the
  // inline SVG rotation tracks the driver's heading.  When the map ITSELF
  // is rotating (heading-up mode) the chevron is created with rotation = 0
  // so it doesn't double-rotate against the basemap.  Outside of navigation
  // we fall back to the static blue dot.
  const userLocationIcon = useMemo(
    () =>
      isNavigating
        ? createNavigationChevronIcon(navBearing, isMapBearingActive)
        : createUserLocationIcon(),
    [isNavigating, navBearing, isMapBearingActive]
  );

  const startIcon = useMemo(() => createStartIcon(), []);
  const endIcon   = useMemo(() => createEndIcon(),   []);

  const metroStationIcon = useMemo(() => {
    const lineColor = metroAlternative?.metroLine?.color ?? "#6366F1";
    return createMetroStationIcon(lineColor);
  }, [metroAlternative?.metroLine?.color]);

  // Stable icon — recreated only when the meeting-point feature is first used.
  const meetingPlaceIcon = useMemo(() => createMeetingPlaceIcon(), []);

  // ─── Heading-Up rotation ────────────────────────────────────────────────
  //
  // Heading-up (the road ahead points to the top of the screen) is now
  // implemented via the `leaflet-rotate` plugin which extends L.Map with a
  // proper `setBearing()` method that rotates the basemap WITHOUT breaking
  // Leaflet's pixel-based hit-test math.  Clicks, pinch, and pan still
  // resolve to correct lat/lng even when the map is rotated.
  //
  // The previous implementation kept the map north-up and only rotated the
  // chevron icon — that mode is preserved as the fallback when the
  // headingUp toggle is OFF.  When ON, two coordinated changes happen:
  //   1. <MapBearingDriver> drives map.setBearing(-navBearing) so the
  //      heading direction physically rotates to 12 o'clock on screen.
  //   2. createNavigationChevronIcon receives headingUp=true so its inner
  //      SVG rotation is 0 — without this the arrow would double-rotate.
  //
  // The toggle only takes effect once Drive Mode is unlocked
  // (`isLiveTracking` is true) so the route preview UI stays north-up.

  return (
    <div style={{ position: "relative", height: "100%", width: "100%" }}>
      {/* ── TomTom Traffic Flow toggle button ─────────────────────────────── */}
      <button
        onClick={() => setShowTrafficFlow((prev) => !prev)}
        title={showTrafficFlow ? "إخفاء حركة المرور المباشرة" : "إظهار حركة المرور المباشرة"}
        style={{
          position:     "absolute",
          bottom:       80,
          right:        12,
          zIndex:       1000,
          display:      "flex",
          alignItems:   "center",
          gap:          6,
          padding:      "6px 10px",
          background:   showTrafficFlow
            ? "rgba(16, 185, 129, 0.90)"
            : "rgba(15, 23, 42, 0.82)",
          border:       showTrafficFlow
            ? "1px solid rgba(16,185,129,0.55)"
            : "1px solid rgba(100,116,139,0.40)",
          borderRadius: 8,
          color:        showTrafficFlow ? "#fff" : "#94A3B8",
          fontSize:     11,
          fontWeight:   700,
          cursor:       "pointer",
          backdropFilter: "blur(6px)",
          boxShadow:    "0 2px 8px rgba(0,0,0,0.35)",
          transition:   "background 0.2s, color 0.2s, border 0.2s",
          letterSpacing: "0.3px",
          whiteSpace:   "nowrap",
          direction:    "rtl",
        }}
      >
        <span style={{ fontSize: 14 }}>🚦</span>
        {showTrafficFlow ? "المرور مباشر" : "المرور مُخفى"}
      </button>

    {/* ── Map (rotation-enabled via leaflet-rotate; bearing driven by    ──── */}
    {/*    <MapBearingDriver> below, gated on Drive Mode + headingUp toggle).  */}
    <LeafletMap
      center={RIYADH_CENTER}
      zoom={11}
      // direction: ltr is required by Leaflet regardless of the app's RTL setting.
      style={{ height: "100%", width: "100%", direction: "ltr" }}
      zoomControl={false}
      // leaflet-rotate plugin opts.  `rotate` enables the bearing API on the
      // map instance.  `rotateControl=false` hides the plugin's default
      // bearing reset button — we expose a styled compass FAB in TrafficMap
      // instead.  `bearing=0` is the initial state so first paint is
      // north-up; MapBearingDriver takes over once navigation starts.
      rotate={true}
      rotateControl={false}
      bearing={0}
    >
      {/* ── Day / night tile layer ─────────────────────────────────────────── */}
      <ThemeTileLayer theme={mapTheme} />

      {/* ── Map event wiring and imperative action exposure ────────────────── */}
      <MapEvents
        onMapClick={onMapClick}
        onZoomChange={onZoomChange}
        onDragStart={onDragStart}
        onMapReady={onMapReady}
        mapFocusTarget={mapFocusTarget}
        onCenterChange={onCenterChange}
      />

      {/* ── Heading-Up camera driver (leaflet-rotate) ──────────────────────── */}
      {/* Rotates the basemap so the driver's heading direction always points  */}
      {/* to the top of the screen.  No-op when isMapBearingActive is false.   */}
      <MapBearingDriver
        bearing={navBearing}
        enabled={isMapBearingActive}
      />

      {/* ── Navigation pitch driver ──────────────────────────────────────────  */}
      {/* Applies a CSS perspective(1200px) rotateX(45°) tilt to the Leaflet  */}
      {/* container during active navigation, giving the "driving through the  */}
      {/* scene" 3D perspective effect.  Only engages when the driver is       */}
      {/* physically moving (isLiveTracking) so the route-preview UI stays     */}
      {/* flat and easy to read before the journey begins.                     */}
      <MapPitchDriver
        pitch={NAVIGATION_PITCH_DEG}
        enabled={isNavigating && isLiveTracking}
      />

      {/* ── 3D Buildings layer (OSMBuildings, zoom ≥ 15) ──────────────────── */}
      {/* Reads OSM `height` and `min_height` tags and renders each building  */}
      {/* as an extruded 3D shape on a canvas overlay — equivalent to         */}
      {/* Mapbox GL's fill-extrusion layer within the Leaflet rendering stack. */}
      {/* Activates only at zoom ≥ 15 where individual buildings are legible. */}
      <BuildingsLayer enabled={currentZoom >= 15} />

      {/* ── Traffic heatmap (real data or simulation frame) ────────────────── */}
      {activeTrafficPoints.length > 0 && (
        <HeatmapLayer trafficPoints={activeTrafficPoints} />
      )}

      {/* ── Incident markers (premium icons, incident-only data) ───────────── */}
      {filteredIncidents.length > 0 && (
        <MarkerClusterLayer incidents={filteredIncidents} />
      )}

      {/* ── Route polylines ────────────────────────────────────────────────── */}
      {(allRoutes ?? []).map((routeObj, index) => {
        if (!routeObj?.route?.length) return null;
        const isActive = index === activeRouteIndex;
        // Hide alternate (non-active) routes once Drive Mode unlocks — they
        // would otherwise visually overlap with the active route's already-
        // driven slice and produce the "tangled lines at U-turn" complaint.
        // Mirrors Google Maps' driving framing where alternates disappear
        // the moment the driver actually starts moving.
        if (!isActive && isLiveTracking) return null;
        const color = getRouteColor(routeObj, index, isActive, mapTheme);
        return (
          <Polyline
            key={index}
            positions={routeObj.route}
            pathOptions={{
              color,
              weight: isActive ? 7 : 4,
              opacity: isActive ? 0.95 : 0.45,
              lineCap: "round",
              lineJoin: "round",
            }}
            eventHandlers={{
              click: () => {
                if (!isActive) onRouteSelect?.(index);
              },
            }}
          />
        );
      })}

      {/* ── Metro route overlay (dashed line + station markers) ───────────── */}
      {metroAlternative?.suggested && metroRouteVisible && (
        <>
          <Polyline
            positions={[
              metroAlternative.originStation.coords,
              metroAlternative.destStation.coords,
            ]}
            pathOptions={{
              color: metroAlternative.metroLine.color,
              weight: 5,
              opacity: 0.85,
              dashArray: "10, 6",
              lineCap: "round",
            }}
          />
          <Marker
            position={metroAlternative.originStation.coords}
            icon={metroStationIcon}
            zIndexOffset={2000}
            eventHandlers={{
              click: () =>
                onMetroMarkerClick?.(metroAlternative.originStation),
            }}
          >
            <Popup>
              <strong>{metroAlternative.originStation.nameAr}</strong>
              <br />
              {metroAlternative.originStation.nameEn}
            </Popup>
          </Marker>
          <Marker
            position={metroAlternative.destStation.coords}
            icon={metroStationIcon}
            zIndexOffset={2000}
            eventHandlers={{
              click: () =>
                onMetroMarkerClick?.(metroAlternative.destStation),
            }}
          >
            <Popup>
              <strong>{metroAlternative.destStation.nameAr}</strong>
              <br />
              {metroAlternative.destStation.nameEn}
            </Popup>
          </Marker>
        </>
      )}

      {/* ── Start marker ───────────────────────────────────────────────────── */}
      {displayStart && (
        <Marker position={displayStart} icon={startIcon}>
          <Popup>{t?.("startPoint") ?? "Start"}</Popup>
        </Marker>
      )}

      {/* ── End / destination marker ────────────────────────────────────────── */}
      {endCoords && (
        <Marker position={endCoords} icon={endIcon}>
          <Popup>{t?.("destination") ?? "Destination"}</Popup>
        </Marker>
      )}

      {/* ── User location / navigation chevron ─────────────────────────────── */}
      {/* During navigation the chevron is wrapped by AnimatedNavigationMarker  */}
      {/* which tweens between successive GPS fixes (~800 ms cubic ease) so the */}
      {/* marker glides instead of teleporting on each fix.                     */}
      {userLocation && (
        <AnimatedNavigationMarker
          position={userLocation}
          icon={userLocationIcon}
          isNavigating={isNavigating}
        />
      )}
    {/* ── محطات المترو الثابتة (تظهر كجزء من الخريطة دائماً) ──────────────── */}
    {RIYADH_METRO_STATIONS.map((station, index) => {
        const stationIcon = createMetroStationIcon(station.color);
        return (
          <Marker
            key={`static-metro-${index}`}
            position={station.coords}
            icon={stationIcon}
            zIndexOffset={1000}
          >
            <Popup>
              <strong>{station.nameAr}</strong>
              <br />
              {station.nameEn}
            </Popup>
          </Marker>
        );
      })}

      {/* ── Meeting Point — participant origin markers ─────────────────────── */}
      {(meetingParticipants ?? []).map((p, idx) =>
        Number.isFinite(p.lat) && Number.isFinite(p.lon) ? (
          <Marker
            key={`participant-${idx}`}
            position={[p.lat, p.lon]}
            icon={createParticipantIcon(p.color)}
            zIndexOffset={2000}
          >
            <Popup>
              <span style={{ fontWeight: 600, color: p.color }}>
                {`Participant ${idx + 1}`}
              </span>
            </Popup>
          </Marker>
        ) : null
      )}

      {/* ── Meeting Point — centroid marker (prominent 🎯 target) ─────────── */}
      {meetingMidpoint && (
        <Marker
          position={[meetingMidpoint.lat, meetingMidpoint.lon]}
          icon={L.divIcon({
            className: "",
            html: `<div style="
                width:44px;height:44px;
                display:flex;align-items:center;justify-content:center;
                font-size:32px;
                filter:
                  drop-shadow(0 0 10px rgba(139,92,246,0.90))
                  drop-shadow(0 2px 6px rgba(0,0,0,0.60));
                animation:meetingPulse 2s ease-in-out infinite;">
              🎯
            </div>`,
            iconSize:    [44, 44],
            iconAnchor:  [22, 22],
            popupAnchor: [0, -24],
          })}
          zIndexOffset={3000}
        >
          <Popup>
            <strong>نقطة التجمع المقترحة</strong>
            <br />
            <span style={{ fontSize: 11, color: "#555" }}>
              {meetingMidpoint.lat.toFixed(4)}, {meetingMidpoint.lon.toFixed(4)}
            </span>
          </Popup>
        </Marker>
      )}

      {/* ── Meeting Point — suggested venue markers ────────────────────────── */}
      {(meetingPlaces ?? []).map((place, idx) =>
        isValidLatLng(place.lat, place.lng) ? (
          <Marker
            key={`meeting-place-${idx}`}
            position={[place.lat, place.lng]}
            icon={meetingPlaceIcon}
            zIndexOffset={2500}
          >
            <Popup>
              <strong>{place.name}</strong>
              {place.category && (
                <>
                  <br />
                  <span style={{ fontSize: 11, color: "#7C3AED" }}>{place.category}</span>
                </>
              )}
              {place.address && (
                <>
                  <br />
                  <span style={{ fontSize: 11, color: "#555" }}>{place.address}</span>
                </>
              )}
              {place.distance != null && (
                <>
                  <br />
                  <span style={{ fontSize: 11, color: "#888" }}>
                    {place.distance < 1000
                      ? `${place.distance} م من نقطة المنتصف`
                      : `${(place.distance / 1000).toFixed(1)} كم من نقطة المنتصف`}
                  </span>
                </>
              )}
            </Popup>
          </Marker>
        ) : null
      )}
    
    </LeafletMap>
    </div>
  );
};

export default MapContainer;
