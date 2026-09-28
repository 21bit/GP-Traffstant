// ─── Application-wide constants ───────────────────────────────────────────────

export const API_BASE =
  process.env.REACT_APP_API_BASE || "http://localhost:4000";
export const RIYADH_CENTER = [24.7136, 46.6753];

export const MAX_INCIDENT_MARKERS = 10;
export const ROUTE_INCIDENT_RADIUS_KM = 1.0;

// ─── Speed & safety thresholds ────────────────────────────────────────────────

export const CAMERA_ALERT_RADIUS_KM = 0.5; // 500 m — legacy belt/mobile camera banner
// Saher (speed / red-light) proximity radius in km.
// Drives the live SaherAlertBadge fed from frontend/src/data/saherCameras.json.
// 400 m matches Google Maps / Waze "approaching speed camera" lead-in distance.
export const SAHER_PROXIMITY_RADIUS_KM = 0.4; // 400 m
export const ROAD_SPEED_LIMIT_URBAN = 80; // km/h — city streets
export const ROAD_SPEED_LIMIT_HIGHWAY = 120; // km/h — ring roads

// GPS tracking options for live car navigation.
//
// enableHighAccuracy: true  — requests the best available fix (GNSS chip, not WiFi).
// maximumAge: 0             — always request a fresh position; cached fixes cause the
//                            arrow to lag behind the car at speed.
// timeout: 5000             — abort a stale fix after 5 s so off-route detection
//                            never has to wait > 5 s on a missing fix before the
//                            next update streams in.  Required for the tightened
//                            20 m off-route threshold to react quickly.
export const GPS_OPTIONS = {
  enableHighAccuracy: true,
  maximumAge: 0,
  timeout: 5000,
};
export const GPS_MIN_MOVE_METERS = 5; // skip state update if moved less than this

// ─── Navigation: off-route / auto-rerouting tuning ────────────────────────────
//
// These values intentionally live in mapConfig (not in the component) so
// tuning for different road networks (dense Riyadh grid vs. highway stretches)
// is a one-line change that requires no redeploy of TrafficMap.

// Perpendicular distance from the live GPS fix to the active route polyline,
// measured in metres, that classifies the driver as "off-route" and triggers
// a silent re-route request.
//
// 20 m chosen to react quickly when the driver actually misses a turn,
// rather than waiting until they're a full city-block away.  Modern phone
// GNSS in open sky has a 5–10 m 95th-percentile error, so 20 m still leaves
// headroom against ordinary GPS noise on a single-lane road while firing
// the reroute the moment the driver crosses into a parallel street.
export const OFF_ROUTE_THRESHOLD_METERS = 20;

// Physical displacement from the route's origin (route[0]) that auto-unlocks
// Drive Mode even when `coords.speed` is missing or below the speed gate.
// Acts as a final fallback so the chevron cannot remain frozen once the user
// has clearly driven away from the preview anchor.
export const REROUTE_DISPLACEMENT_M = 30;

// Hard minimum interval between two consecutive re-route API calls.
// Prevents spamming /api/recommend-route if the driver weaves along the
// route edge (GPS jitter) or briefly crosses a parallel service road.
export const REROUTE_MIN_INTERVAL_MS = 8000;

// ─── Navigation: map-matching (snap-to-route) ────────────────────────────────
//
// When navigation is active, each live GPS fix is projected onto the active
// route polyline.  If the projection is closer than this threshold the
// chevron renders at the snapped point rather than the raw GPS reading,
// eliminating the "marker floats in the shoulder / parking lot" bug caused
// by typical multi-metre GNSS noise on consumer phones.
//
// MUST stay strictly less than OFF_ROUTE_THRESHOLD_METERS so a genuine
// off-route deviation is never visually hidden (the chevron snapping back
// onto the line) before the reroute detector has a chance to fire.
//
// 15 m balances:
//   • typical GNSS noise on consumer phones (~5–10 m in open sky),
//   • leaving a 5 m guard band below OFF_ROUTE_THRESHOLD_METERS (20 m)
//     so the off-route detector remains the authoritative gate.
export const SNAP_TO_ROUTE_MAX_DISTANCE_METERS = 15;

// ─── Navigation: dynamic follow camera ───────────────────────────────────────
//
// Street-level zoom the camera auto-flies to the first time the driver
// crosses the movement threshold while tracking is locked.  Matches the
// zoom Google Maps / Waze use during active turn-by-turn.
//
// 19 is the tightest level both basemaps can render cleanly — the OSM and
// CartoDB Dark Matter tile layers both declare `maxZoom: 19`.  Requesting
// fractional zoom (e.g. 19.5) with Leaflet's default `zoomSnap = 1` would
// either snap back to 19 or serve blank tiles, so 19 is the safe upper bound
// that still gives the "locked on the chevron head" framing the driver needs.
export const NAVIGATION_FOLLOW_ZOOM = 19;

// Pixel offset applied by MapContainer.setViewOffset(): the camera centres
// ABOVE the chevron by this many device pixels so the vehicle sits in the
// lower-middle of the viewport with the route laid out ahead — the framing
// convention used by every modern turn-by-turn UX.
//
// 120 px (up from 90) pushes the chevron more firmly into the lower third
// of the viewport at NAVIGATION_FOLLOW_ZOOM so the arrow "head" dominates
// the frame and the road ahead is maximised — matches Google Maps framing.
export const NAVIGATION_FOLLOW_OFFSET_Y = 120;

// ─── Toast timing ─────────────────────────────────────────────────────────────

export const SEQUENTIAL_TOAST_DISPLAY_MS = 4500;
export const TOAST_FADE_OUT_MS = 400;
export const TOAST_MAX_WIDTH = "min(24rem, 92vw)";

// ─── Alert priority queue ─────────────────────────────────────────────────────
// Lower number = shown first in the sequential toast queue.

export const ALERT_PRIORITY = {
  "park-ride": 0,
  incident: 1,
  "speed-exceeded": 2,
  departure: 3,
  camera: 4,
  seatbelt: 5,
  "metro-alternative": 6,
};

// ─── Heatmap configuration ────────────────────────────────────────────────────

export const DENSITY_INTENSITY = { high: 1.0, medium: 0.6, low: 0.25 };

export const HEATMAP_GRADIENT = {
  0.0: "#22c55e",
  0.35: "#eab308",
  0.6: "#f97316",
  1.0: "#ef4444",
};

// ─── Traffic simulation ───────────────────────────────────────────────────────

export const SIMULATION_OFFSETS = [0, 15, 30, 45, 60];

// ─── Incident display config ──────────────────────────────────────────────────

export const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };
export const TYPE_ORDER = {
  accident: 0,
  "road closure": 1,
  roadworks: 1,
  "heavy traffic": 2,
  hazard: 3,
};

// ─── Metro line colours ───────────────────────────────────────────────────────
// Mirrors the backend METRO_LINES definition.

export const LINE_COLORS = {
  1: "#2563EB",
  2: "#22C55E",
  3: "#F97316",
  4: "#EAB308",
  5: "#8B5CF6",
  6: "#EF4444",
};

// ─── Riyadh Metro stations ─────────────────────────────────────────────────────
// Coordinates stored as [lat, lng] (Leaflet convention).

export const METRO_STATIONS = [
  // Line 1 (Blue) — Olaya Road
  { id: "kafd",         nameAr: "مركز الملك عبدالله المالي", nameEn: "KAFD",                coords: [24.7615, 46.6395], lines: [1, 6] },
  { id: "olaya",        nameAr: "العليا",                   nameEn: "Olaya",               coords: [24.7217, 46.6711], lines: [1] },
  { id: "faisaliyah",   nameAr: "الفيصلية",                 nameEn: "Al Faisaliyah",       coords: [24.6903, 46.6854], lines: [1] },
  { id: "qasr_alhokm",  nameAr: "قصر الحكم",                nameEn: "Qasr Al Hokm",        coords: [24.6315, 46.7115], lines: [1, 3] },
  { id: "batha",        nameAr: "البطحاء",                  nameEn: "Al Batha",            coords: [24.6280, 46.7210], lines: [1] },
  // Line 2 (Green) — King Abdullah Road
  { id: "dq",           nameAr: "الحي الدبلوماسي",          nameEn: "Diplomatic Quarter",  coords: [24.7117, 46.6208], lines: [2] },
  { id: "king_abdullah", nameAr: "حديقة الملك عبدالله",     nameEn: "King Abdullah Park",  coords: [24.7345, 46.6510], lines: [2, 6] },
  { id: "sahafa",       nameAr: "الصحافة",                  nameEn: "Al Sahafa",           coords: [24.7890, 46.6580], lines: [2] },
  // Line 3 (Orange) — East-West
  { id: "western",      nameAr: "المحطة الغربية",            nameEn: "Western Station",     coords: [24.6535, 46.5985], lines: [3] },
  { id: "sulaimaniyah", nameAr: "السليمانية",                nameEn: "Sulaimaniyah",        coords: [24.6630, 46.6640], lines: [3, 5] },
  { id: "malaz",        nameAr: "الملز",                    nameEn: "Al Malaz",            coords: [24.6620, 46.7250], lines: [3] },
  { id: "naseem",       nameAr: "النسيم",                   nameEn: "Al Naseem",           coords: [24.6750, 46.7680], lines: [3] },
  // Line 4 (Yellow) — Airport
  { id: "airport",      nameAr: "مطار الملك خالد",           nameEn: "King Khalid Airport", coords: [24.9578, 46.6989], lines: [4] },
  { id: "nakheel",      nameAr: "النخيل",                   nameEn: "Al Nakheel",          coords: [24.8230, 46.6730], lines: [4, 2] },
  // Line 5 (Purple) — King Abdulaziz Road
  { id: "murabba",      nameAr: "المربع",                   nameEn: "Al Murabba",          coords: [24.6500, 46.7100], lines: [5] },
  { id: "rabwa",        nameAr: "الربوة",                   nameEn: "Al Rabwa",            coords: [24.6150, 46.7260], lines: [5] },
  // Line 6 (Red) — King Fahd Road
  { id: "diriyah",      nameAr: "الدرعية",                  nameEn: "Diriyah",             coords: [24.7340, 46.5720], lines: [6] },
  { id: "tuwaiq",       nameAr: "طويق",                     nameEn: "Tuwaiq",              coords: [24.6850, 46.6050], lines: [6] },
  { id: "nasiriyah",    nameAr: "الناصرية",                  nameEn: "Al Nasiriyah",        coords: [24.6410, 46.6470], lines: [6, 5] },
];

// ─── Speed (Saher) camera positions ──────────────────────────────────────────
// Used for route geofencing — alerts fire once when a route passes near a camera.

export const SPEED_CAMERAS = [
  { id: "saher_olaya",   coords: [24.7230, 46.6790] },
  { id: "saher_tahlia",  coords: [24.6920, 46.7090] },
  { id: "saher_uruba",   coords: [24.7480, 46.6340] },
  { id: "saher_sitteen", coords: [24.6550, 46.7380] },
  { id: "saher_makkah",  coords: [24.6710, 46.6580] },
];

// ─── Seatbelt / mobile-phone camera positions ──────────────────────────────────

export const SAFETY_CAMERAS = [
  { id: "safe_king_fahd",  coords: [24.7350, 46.6510] },
  { id: "safe_north_ring", coords: [24.7680, 46.7050] },
  { id: "safe_east_ring",  coords: [24.6840, 46.7650] },
  { id: "safe_andalus",    coords: [24.6490, 46.6950] },
];

// ─── Auto-theme: tile layer URLs, route colours, and theme resolver ───────────
//
// Day   (06:00–17:59 local): Standard OpenStreetMap — full-colour basemap with
//   green parks, coloured roads, water, and urban detail baked into every tile.
// Night (18:00–05:59 local): CartoDB Dark Matter — single-layer dark basemap
//   with labels baked in (no separate labels pane needed).
//
// Theme is resolved PURELY by wall-clock time; OS dark-mode preference is
// intentionally ignored so the map reliably shows light tiles during the day
// regardless of the user's system theme setting.

const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const CARTO_DARK_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors ' +
  '&copy; <a href="https://carto.com/attributions">CARTO</a>';

export const MAP_TILE_LAYERS = {
  day: {
    // Standard OSM renders parks in green, roads in colour, water in blue —
    // replacing CartoDB Voyager which stripped those visual cues.
    base: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    labels: null,
    attribution: OSM_ATTRIBUTION,
    subdomains: "abc",
    maxZoom: 19,
  },
  night: {
    base: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    labels: null, // dark_all bakes labels into the tile — no overlay needed
    attribution: CARTO_DARK_ATTRIBUTION,
    subdomains: "abcd",
    maxZoom: 19,
  },
};

// Route polyline core colour per theme.
// Blue (#2563EB) reads cleanly on Voyager's warm-grey tiles.
// Electric Cyan (#00f2ff) pops on CartoDB dark tiles.
export const ROUTE_COLORS_BY_THEME = {
  day:   "#2563EB",
  night: "#00f2ff",
};

/**
 * Returns 'day' or 'night' based solely on local wall-clock time.
 *
 *   Day   → 06:00–17:59  (hour >= 6 && hour < 18)
 *   Night → 18:00–05:59  (hour < 6  || hour >= 18)
 *
 * OS-level dark mode is intentionally NOT consulted here — doing so caused
 * the map to permanently display night tiles for users whose system theme is
 * set to dark, regardless of the actual time of day.
 */
export const getMapTheme = () => {
  const hour = new Date().getHours();
  return hour >= 6 && hour < 18 ? "day" : "night";
};

// ─── Real-time GPS proximity cameras (legacy 500 m engine) ───────────────────
// Checked on every GPS tick during navigation; alerts show when within
// CAMERA_ALERT_RADIUS_KM of any entry.
//
// IMPORTANT: speed (Saher) cameras have moved to frontend/src/data/saherCameras.json
// and are handled by the new 400 m SaherAlertBadge engine in TrafficMap.js.
// This list now ONLY contains belt / mobile-phone enforcement cameras so the
// two engines never double-fire on the same point.
//
// type        — "belt"   → seatbelt enforcement camera
//               "mobile" → portable / handheld enforcement unit
// speedLimit  — null (these cameras don't enforce a speed threshold).

export const SAHER_PROXIMITY_CAMERAS = [
  { id: "safe_king_fahd",    coords: [24.7350, 46.6510], type: "belt",   speedLimit: null },
  { id: "safe_north_ring",   coords: [24.7680, 46.7050], type: "belt",   speedLimit: null },
  { id: "safe_east_ring_s",  coords: [24.6840, 46.7650], type: "mobile", speedLimit: null },
  { id: "safe_andalus",      coords: [24.6490, 46.6950], type: "mobile", speedLimit: null },
  { id: "safe_olaya_south",  coords: [24.6780, 46.6830], type: "belt",   speedLimit: null },
];
