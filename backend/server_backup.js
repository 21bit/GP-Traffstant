require("dotenv").config(); // Must be first so all process.env reads below see the values.
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const Groq = require("groq-sdk");

const app = express();

// الأبواب المفتوحة بدون تعقيد
app.use(cors());
app.use(express.json());

// وهنا تكمل باقي كودك اللي تحت (الروابط وغيرها)...

const PORT = process.env.PORT || 5000;
const TOMTOM_API_KEY = process.env.TOMTOM_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = "llama-3.3-70b-versatile";

if (!TOMTOM_API_KEY) {
  console.warn("[WARN] TOMTOM_API_KEY is not set. API calls will fail.");
}
if (!GROQ_API_KEY) {
  console.warn("[WARN] GROQ_API_KEY is not set. POST /api/copilot will return 503.");
}

// ─── Multi-Agent Copilot System ───────────────────────────────────────────────
//
// Architecture: Two-phase agentic pipeline per request.
//
//  Phase 1 — Data Gatherer Agent
//    A Groq call (low temperature) with both tools enabled.
//    Runs a tool-calling loop until all relevant data is collected:
//      • search_place  → resolves place names to real GPS coordinates
//      • fetch_traffic_incidents → fetches live TomTom incident data per location
//    Outputs: a structured evidence report + any resolved destination coordinates.
//
//  Phase 2 — Traffic Analyst Agent
//    A second Groq call (no tools, higher temperature for natural Arabic).
//    Receives the original user message + conversation history + evidence report.
//    Outputs: a detailed, justified Arabic response that references real numbers.

// ── Agent 1 System Prompt: Data Gatherer ─────────────────────────────────────
// English for precise tool-sequencing reasoning; Arabic-only for search queries.
const DATA_GATHERER_SYSTEM_PROMPT = [
  "You are Agent 1 (Data Gatherer) in a Multi-Agent Traffic Expert system for Riyadh, Saudi Arabia.",
  "You are a Multi-Agent Traffic Expert. You never guess. You always collect TomTom data before answering.",
  "",
  "YOUR ONLY JOB: Collect all data needed to answer the user's request. Do NOT write a conversational response.",
  "",
  "STRICT WORKFLOW — follow every step in order:",
  "  Step 1 — PLAN: Identify every place, destination, or business the user mentioned.",
  "  Step 2 — SEARCH: Call search_place for each place.",
  "            CRITICAL: The 'query' argument MUST be written in Arabic only. No English, no Chinese.",
  "            Always include 'الرياض' at the end. Example: 'كنتاكي المهدية الرياض'.",
  "  Step 3 — FETCH INCIDENTS: After finding coordinates, IMMEDIATELY call fetch_traffic_incidents.",
  "            If the user mentions multiple branches or alternatives, repeat Steps 2–3 for each.",
  "  Step 4 — FETCH USER AREA: Call fetch_traffic_incidents once for the user's current coordinates",
  "            to capture outbound-route hazards.",
  "  Step 5 — DONE: Stop and output nothing else once all tools have been called.",
  "",
  "HARD RULES:",
  "  - NEVER fabricate coordinates. Always use search_place first.",
  "  - NEVER skip fetch_traffic_incidents after finding a place.",
  "  - search_place queries MUST be in Arabic only. Never use English or any other language in the query.",
  "  - BUDGET: maximum 2 search_place calls + 2 fetch_traffic_incidents calls total.",
  "    Pick the 2 most relevant locations if more are mentioned. Do not exceed this budget.",
  "  - Use radius_km=3 for city destinations, radius_km=5 for ring-road/highway locations.",
].join("\n");

// ── Agent 2 System Prompt: Traffic Analyst + Decision Maker ──────────────────
// Receives the evidence report and produces the final user-facing Arabic response.
const ANALYST_SYSTEM_PROMPT = [
  "أنت Traffstant، خبير مروري محلي موثوق في الرياض، المملكة العربية السعودية.",
  "لديك تقرير بيانات حقيقية من TomTom. مهمتك تحليله وترجمته إلى نصيحة عملية كما يفعل أي ريّس سيارة خبير.",
  "",
  "مفتاح تفسير البيانات (للاستخدام الداخلي — لا تذكره حرفياً):",
  "  • magnitudeOfDelay 0–1 = طريق سالك تقريباً",
  "  • magnitudeOfDelay 2    = زحمة ذروة معتادة، حركة بطيئة بعض الشيء",
  "  • magnitudeOfDelay 3    = ازدحام شديد، توقفات متقطعة عند الإشارات",
  "  • magnitudeOfDelay 4    = توقف تام — تجنّب هذا المسار",
  "  • كود 101 = توقف تام على الطريق (أسوأ حالة)",
  "  • كود 200 = إغلاق طريق كامل — مرفوض",
  "  • delay بالثواني: حوّله لدقائق، واذكر الدقائق فقط (مثل 'تأخير نحو 7 دقائق')",
  "",
  "قواعد صارمة للغة الرد:",
  "  - لا تذكر أبداً أعداد الحوادث الخام (مثل: 'رُصدت 36 حادثة' — هذا مُضلِّل للمستخدم).",
  "  - لا تذكر مصطلحات تقنية مثل 'magnitudeOfDelay' أو 'iconCategory' أو 'TomTom incidents'.",
  "  - عبّر عن الحالة المرورية بمصطلحات طبيعية مثل:",
  "      'زحمة ذروة معتادة'، 'طريق سالك'، 'توقف تام عند بعض الإشارات'،",
  "      'أعمال طرق وحفريات'، 'حركة بطيئة على المحور'، 'الطريق يتحرك بشكل معقول'.",
  "",
  "هيكل الرد الإلزامي:",
  "  1. افتح بـ: 'راجعت الوضع...' أو 'شفت البيانات الحية...' — لا تذكر أرقاماً خاماً.",
  "  2. لكل خيار: اسم المكان + وصف طبيعي لحالة الطريق + التأخير بالدقائق إن وُجد.",
  "  3. اختم بتوصية مبررة: 'أنصحك بـ... لأن الطريق إليه...'",
  "  4. إذا الكل سالك: قل ذلك بثقة مع ذكر الوقت التقريبي.",
  "",
  "قواعد عامة:",
  "  - لهجة سعودية بيضاء، مباشر وعملي، 3-5 جمل كحد أقصى.",
  "  - لا تكرر 'بناءً على بيانات الخريطة الحية' في كل رد.",
  "  - إذا المستخدم سأل عن شيء غير مروري، أجب بشكل طبيعي دون ذكر بيانات.",
  "  - أنت مخصص للرياض والمملكة العربية السعودية فقط.",
  "  - إذا سألك عن بديل أو فرع ثاني، قدّم خياراً مختلفاً عن ردودك السابقة.",
].join("\n");

// ── OpenAI/Groq-compatible tools for the Data Gatherer agent ─────────────────
const COPILOT_TOOLS = [
  {
    type: "function",
    function: {
      name: "search_place",
      description:
        "Search for a real place, business, or point of interest by name using the live map API. " +
        "Returns exact GPS coordinates, the official place name, address, and neighborhood. " +
        "MUST be called before fetch_traffic_incidents. " +
        "CRITICAL: The query MUST be written in Arabic only — never use English or any other language. " +
        "Always end the query with 'الرياض'. " +
        "If the result is outside Riyadh, re-search with the user's neighborhood appended in Arabic.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Place name in ARABIC ONLY. Must end with 'الرياض'. " +
              "Examples: 'كنتاكي المهدية الرياض'، 'مطعم البيك العليا الرياض'، 'إيكيا الرياض'، 'جامعة الملك سعود الرياض'.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_traffic_incidents",
      description:
        "Fetch real-time traffic incidents from TomTom near a specific GPS location. " +
        "Returns incidents with magnitudeOfDelay (1=minor, 2=moderate, 3=serious, 4=stationary/worst), " +
        "event codes (101=Stationary traffic, 200=Road closed), delay seconds, road names, and from/to fields. " +
        "Always call this AFTER search_place to get the traffic picture for the found location.",
      parameters: {
        type: "object",
        properties: {
          lat: {
            type: "number",
            description: "Latitude of the location to check (from search_place result or user coordinates).",
          },
          lng: {
            type: "number",
            description: "Longitude of the location to check (from search_place result or user coordinates).",
          },
          radius_km: {
            type: "number",
            description: "Search radius in kilometres (1–10, default 3). Use 5 for highway/ring-road locations.",
          },
          location_name: {
            type: "string",
            description: "Human-readable label for this location (e.g. 'KFC المهدية'). Used in the evidence report.",
          },
        },
        required: ["lat", "lng"],
      },
    },
  },
];

let _groqClient = null;
function getGroqClient() {
  if (!GROQ_API_KEY) return null;
  if (!_groqClient) {
    _groqClient = new Groq({ apiKey: GROQ_API_KEY });
  }
  return _groqClient;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const kmToDegrees = (km) => km / 111;

const computeDensity = (currentSpeed, freeFlowSpeed) => {
  if (currentSpeed < 0 || freeFlowSpeed <= 0) return "unknown";
  const ratio = currentSpeed / freeFlowSpeed;
  if (ratio < 0.4) return "high";
  if (ratio < 0.7) return "medium";
  return "low";
};

const generateRiyadhGrid = () => {
  const center = { lat: 24.7136, lng: 46.6753 };
  const radiusKm = 10;
  const stepKm = 3;
  const step = kmToDegrees(stepKm);
  const radius = kmToDegrees(radiusKm);

  const points = [];
  for (let lat = center.lat - radius; lat <= center.lat + radius; lat += step) {
    for (let lng = center.lng - radius; lng <= center.lng + radius; lng += step) {
      points.push({ lat, lng });
    }
  }
  return points;
};

const fetchFlowForPoint = async (lat, lng) => {
  try {
    const response = await axios.get(
      "https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json",
      {
        params: { key: TOMTOM_API_KEY, point: `${lat},${lng}`, unit: "kmh" },
        timeout: 5000,
      }
    );
    const data = response.data.flowSegmentData;
    return {
      lat,
      lng,
      currentSpeed: data.currentSpeed,
      freeFlowSpeed: data.freeFlowSpeed,
      density: computeDensity(data.currentSpeed, data.freeFlowSpeed),
    };
  } catch {
    return { lat, lng, density: "unknown" };
  }
};

// Haversine distance in km
const haversineDistanceKm = (lat1, lng1, lat2, lng2) => {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

// Normalize a single TomTom route object into our standard shape
const normalizeRealRoute = (routeData) => {
  const route = routeData.legs.flatMap((leg) =>
    leg.points.map((p) => [p.latitude, p.longitude])
  );
  const summary = routeData.summary;
  const distanceKm = (summary.lengthInMeters / 1000).toFixed(1);
  const travelTimeMin = Math.ceil(summary.travelTimeInSeconds / 60);
  const delayMin = Math.ceil((summary.trafficDelayInSeconds || 0) / 60);
  const delayRatio =
    (summary.trafficDelayInSeconds || 0) /
    Math.max(summary.travelTimeInSeconds, 1);

  let trafficLevel = "low";
  if (delayRatio > 0.3) trafficLevel = "high";
  else if (delayRatio > 0.1) trafficLevel = "medium";

  return {
    route,
    trafficLevel,
    distance: distanceKm,
    travelTime: travelTimeMin,
    trafficDelay: delayMin,
    lengthInMeters: summary.lengthInMeters,
    travelTimeInSeconds: summary.travelTimeInSeconds,
    source: "tomtom",
  };
};

// Lower score = better recommendation
const scoreRoute = (routeInfo) => {
  const trafficPenalty =
    routeInfo.trafficLevel === "high"
      ? 30
      : routeInfo.trafficLevel === "medium"
      ? 10
      : 0;
  return (
    routeInfo.travelTime + trafficPenalty + routeInfo.trafficDelay * 2
  );
};

// Assign human-readable labels and display colors to a list of routes
const labelAndColorRoutes = (routes) => {
  if (routes.length === 0) return [];

  const recommendedIdx = routes.reduce(
    (best, r, i) => (scoreRoute(r) < scoreRoute(routes[best]) ? i : best),
    0
  );

  const leastTrafficIdx = routes.reduce((best, r, i) => {
    const rank = (level) =>
      level === "high" ? 2 : level === "medium" ? 1 : 0;
    return rank(r.trafficLevel) < rank(routes[best].trafficLevel) ? i : best;
  }, 0);

  const shortestIdx = routes.reduce(
    (best, r, i) =>
      parseFloat(r.distance) < parseFloat(routes[best].distance) ? i : best,
    0
  );

  const assignedLabels = new Set();

  return routes.map((r, i) => {
    let label = "Alternative";
    let color = "#94a3b8"; // gray

    if (i === recommendedIdx && !assignedLabels.has("recommended")) {
      label = "Recommended";
      color = "#3b82f6"; // blue
      assignedLabels.add("recommended");
    } else if (
      i === leastTrafficIdx &&
      !assignedLabels.has("leastTraffic")
    ) {
      label = "Least Traffic";
      color = "#22c55e"; // green
      assignedLabels.add("leastTraffic");
    } else if (i === shortestIdx && !assignedLabels.has("shortest")) {
      label = "Shortest";
      color = "#94a3b8"; // gray
      assignedLabels.add("shortest");
    }

    return { ...r, label, color, isRecommended: i === recommendedIdx };
  });
};

// Build synthetic straight-ish routes as fallback when TomTom Routing is unavailable
const buildSyntheticRoutes = (fromLat, fromLng, toLat, toLng, trafficPoints) => {
  const steps = 15;
  const offsets = [-0.025, 0, 0.025];

  const scoredPaths = offsets.map((offset) => {
    const path = Array.from({ length: steps + 1 }, (_, i) => {
      const t = i / steps;
      return [
        fromLat + (toLat - fromLat) * t + offset * (1 - 2 * Math.abs(t - 0.5)),
        fromLng + (toLng - fromLng) * t,
      ];
    });

    const score = path.reduce((sum, [lat, lng]) => {
      const nearest = trafficPoints.reduce(
        (best, p) => {
          const d = Math.hypot(p.lat - lat, p.lng - lng);
          return d < best.d ? { d, density: p.density } : best;
        },
        { d: Infinity, density: "unknown" }
      );
      return (
        sum +
        (nearest.density === "high"
          ? 3
          : nearest.density === "medium"
          ? 2
          : 1)
      );
    }, 0);

    return { path, score };
  });

  const distanceKm = haversineDistanceKm(fromLat, fromLng, toLat, toLng);
  const baseTravelMin = Math.ceil((distanceKm / 50) * 60);

  return scoredPaths.map((item, i) => {
    const avgScore = item.score / (steps + 1);
    const trafficLevel =
      avgScore >= 2.5 ? "high" : avgScore >= 1.6 ? "medium" : "low";
    const multiplier =
      trafficLevel === "high" ? 1.35 : trafficLevel === "medium" ? 1.15 : 1;
    const travelTime = Math.ceil(baseTravelMin * multiplier);
    const trafficDelay = travelTime - baseTravelMin;
    // Vary distance slightly per path so each looks distinct
    const distanceVariant = distanceKm * (1 + (i - 1) * 0.05);

    return {
      route: item.path,
      trafficLevel,
      distance: distanceVariant.toFixed(1),
      travelTime,
      trafficDelay,
      source: "synthetic",
    };
  });
};

// ─── Riyadh Metro Network ─────────────────────────────────────────────────────

const METRO_LINES = [
  { id: 1, nameEn: "Blue Line",   nameAr: "الخط الأزرق",    color: "#2563EB" },
  { id: 2, nameEn: "Green Line",  nameAr: "الخط الأخضر",    color: "#22C55E" },
  { id: 3, nameEn: "Orange Line", nameAr: "الخط البرتقالي",  color: "#F97316" },
  { id: 4, nameEn: "Yellow Line", nameAr: "الخط الأصفر",    color: "#EAB308" },
  { id: 5, nameEn: "Purple Line", nameAr: "الخط البنفسجي",  color: "#8B5CF6" },
  { id: 6, nameEn: "Red Line",    nameAr: "الخط الأحمر",    color: "#EF4444" },
];

const METRO_STATIONS_FULL = [
  // Line 1 (Blue) — Olaya Road, north→south
  { id: "kafd",         nameEn: "KAFD",               nameAr: "مركز الملك عبدالله المالي", coords: [24.7615, 46.6395], lines: [1, 6], parkAndRide: true },
  { id: "olaya",        nameEn: "Olaya",              nameAr: "العليا",                   coords: [24.7217, 46.6711], lines: [1],    parkAndRide: true },
  { id: "faisaliyah",   nameEn: "Al Faisaliyah",      nameAr: "الفيصلية",                 coords: [24.6903, 46.6854], lines: [1],    parkAndRide: false },
  { id: "qasr_alhokm",  nameEn: "Qasr Al Hokm",       nameAr: "قصر الحكم",                coords: [24.6315, 46.7115], lines: [1, 3], parkAndRide: true },
  { id: "batha",        nameEn: "Al Batha",           nameAr: "البطحاء",                  coords: [24.6280, 46.7210], lines: [1],    parkAndRide: false },
  // Line 2 (Green) — King Abdullah Road
  { id: "dq",           nameEn: "Diplomatic Quarter", nameAr: "الحي الدبلوماسي",          coords: [24.7117, 46.6208], lines: [2],    parkAndRide: true },
  { id: "king_abdullah", nameEn: "King Abdullah Park", nameAr: "حديقة الملك عبدالله",      coords: [24.7345, 46.6510], lines: [2, 6], parkAndRide: true },
  { id: "sahafa",       nameEn: "Al Sahafa",          nameAr: "الصحافة",                  coords: [24.7890, 46.6580], lines: [2],    parkAndRide: true },
  // Line 3 (Orange) — East-West
  { id: "western",      nameEn: "Western Station",    nameAr: "المحطة الغربية",           coords: [24.6535, 46.5985], lines: [3],    parkAndRide: true },
  { id: "sulaimaniyah", nameEn: "Sulaimaniyah",       nameAr: "السليمانية",                coords: [24.6630, 46.6640], lines: [3, 5], parkAndRide: false },
  { id: "malaz",        nameEn: "Al Malaz",           nameAr: "الملز",                    coords: [24.6620, 46.7250], lines: [3],    parkAndRide: true },
  { id: "naseem",       nameEn: "Al Naseem",          nameAr: "النسيم",                   coords: [24.6750, 46.7680], lines: [3],    parkAndRide: true },
  // Line 4 (Yellow) — Airport
  { id: "airport",      nameEn: "King Khalid Airport", nameAr: "مطار الملك خالد",          coords: [24.9578, 46.6989], lines: [4],    parkAndRide: false },
  { id: "nakheel",      nameEn: "Al Nakheel",         nameAr: "النخيل",                   coords: [24.8230, 46.6730], lines: [4, 2], parkAndRide: true },
  // Line 5 (Purple) — King Abdulaziz Road
  { id: "murabba",      nameEn: "Al Murabba",         nameAr: "المربع",                   coords: [24.6500, 46.7100], lines: [5],    parkAndRide: false },
  { id: "rabwa",        nameEn: "Al Rabwa",           nameAr: "الربوة",                   coords: [24.6150, 46.7260], lines: [5],    parkAndRide: true },
  // Line 6 (Red) — King Fahd Road
  { id: "diriyah",      nameEn: "Diriyah",            nameAr: "الدرعية",                  coords: [24.7340, 46.5720], lines: [6],    parkAndRide: true },
  { id: "tuwaiq",       nameEn: "Tuwaiq",             nameAr: "طويق",                     coords: [24.6850, 46.6050], lines: [6],    parkAndRide: true },
  { id: "nasiriyah",    nameEn: "Al Nasiriyah",       nameAr: "الناصرية",                  coords: [24.6410, 46.6470], lines: [6, 5], parkAndRide: true },
];

const METRO_AVG_SPEED_KMH = 40;
const CITY_AVG_SPEED_KMH = 30;
const CONGESTED_CITY_SPEED_KMH = 15;
const PARKING_WALK_MINUTES = 4;
const TRANSFER_PENALTY_MINUTES = 5;
const MIN_TIME_SAVINGS_MINUTES = 3;
const MAX_STATION_DISTANCE_KM = 15;

const findSharedLine = (stationA, stationB) => {
  const sharedId = stationA.lines.find((l) => stationB.lines.includes(l));
  return sharedId != null
    ? METRO_LINES.find((line) => line.id === sharedId)
    : null;
};

const findTransferRoute = (originStation, destStation) => {
  for (const candidate of METRO_STATIONS_FULL) {
    if (candidate.id === originStation.id || candidate.id === destStation.id) continue;
    const lineFromOrigin = findSharedLine(originStation, candidate);
    const lineToDest = findSharedLine(candidate, destStation);
    if (lineFromOrigin && lineToDest) {
      return { transferStation: candidate, lineFromOrigin, lineToDest };
    }
  }
  return null;
};

const pickStation = (s) => ({
  id: s.id,
  nameEn: s.nameEn,
  nameAr: s.nameAr,
  coords: s.coords,
  parkAndRide: !!s.parkAndRide,
});

/**
 * Computes whether a multimodal metro route (drive → metro → drive) saves time
 * compared to driving the full route in current traffic conditions.
 *
 * Algorithm:
 * 1. Find nearest metro stations to origin (within MAX_STATION_DISTANCE_KM)
 * 2. Find nearest metro stations to destination (within MAX_STATION_DISTANCE_KM)
 * 3. For each (origin station, dest station) pair:
 *    a. Check if they share a direct metro line
 *    b. If not, find a transfer station that connects them
 *    c. Calculate total multimodal time:
 *       drive-to-station + parking/walk + metro ride (+ transfer) + drive-to-dest
 *    d. Use congested city speed for driving segments when traffic is high
 * 4. Compare total metro time vs driving time
 * 5. Suggest metro only if it saves at least MIN_TIME_SAVINGS_MINUTES
 * 6. Among all valid pairs, pick the one that saves the most time
 */
const computeMetroAlternative = (
  startLat, startLng, endLat, endLng, drivingTimeMin, trafficLevel
) => {
  if (trafficLevel === "low") {
    return { suggested: false, reason: "Traffic is light — driving is optimal." };
  }

  // Use slower city speed when traffic is congested for more accurate
  // drive-to-station time estimates
  const effectiveCitySpeed = trafficLevel === "high"
    ? CONGESTED_CITY_SPEED_KMH
    : CITY_AVG_SPEED_KMH;

  const withOriginDist = METRO_STATIONS_FULL
    .map((s) => ({ ...s, distFromOrigin: haversineDistanceKm(startLat, startLng, s.coords[0], s.coords[1]) }))
    .filter((s) => s.distFromOrigin <= MAX_STATION_DISTANCE_KM)
    .sort((a, b) => a.distFromOrigin - b.distFromOrigin);

  const withDestDist = METRO_STATIONS_FULL
    .map((s) => ({ ...s, distFromDest: haversineDistanceKm(endLat, endLng, s.coords[0], s.coords[1]) }))
    .filter((s) => s.distFromDest <= MAX_STATION_DISTANCE_KM)
    .sort((a, b) => a.distFromDest - b.distFromDest);

  if (withOriginDist.length === 0 || withDestDist.length === 0) {
    return { suggested: false, reason: "No metro stations near origin or destination." };
  }

  let best = null;
  // Evaluate more station pairs for better coverage
  const TOP_N = 5;

  for (const oStation of withOriginDist.slice(0, TOP_N)) {
    for (const dStation of withDestDist.slice(0, TOP_N)) {
      if (oStation.id === dStation.id) continue;

      let metroSegment = null;
      const directLine = findSharedLine(oStation, dStation);

      if (directLine) {
        const metroDistKm = haversineDistanceKm(
          oStation.coords[0], oStation.coords[1],
          dStation.coords[0], dStation.coords[1]
        );
        metroSegment = {
          metroLine: directLine,
          transferStation: null,
          transferLine: null,
          metroTravelMin: Math.ceil((metroDistKm / METRO_AVG_SPEED_KMH) * 60),
        };
      } else {
        const transfer = findTransferRoute(oStation, dStation);
        if (transfer) {
          const leg1 = haversineDistanceKm(
            oStation.coords[0], oStation.coords[1],
            transfer.transferStation.coords[0], transfer.transferStation.coords[1]
          );
          const leg2 = haversineDistanceKm(
            transfer.transferStation.coords[0], transfer.transferStation.coords[1],
            dStation.coords[0], dStation.coords[1]
          );
          metroSegment = {
            metroLine: transfer.lineFromOrigin,
            transferStation: transfer.transferStation,
            transferLine: transfer.lineToDest,
            metroTravelMin: Math.ceil(((leg1 + leg2) / METRO_AVG_SPEED_KMH) * 60) + TRANSFER_PENALTY_MINUTES,
          };
        }
      }

      if (!metroSegment) continue;

      const driveToKm = oStation.distFromOrigin;
      const driveFromKm = dStation.distFromDest;
      // Driving TO the station uses congested speed (user is currently in traffic).
      // Driving FROM the destination station uses normal city speed (shorter last-mile leg).
      const driveToMin = Math.ceil((driveToKm / effectiveCitySpeed) * 60);
      const driveFromMin = Math.ceil((driveFromKm / CITY_AVG_SPEED_KMH) * 60);
      const parkingMin = oStation.parkAndRide ? PARKING_WALK_MINUTES : PARKING_WALK_MINUTES + 2;
      const totalMin = driveToMin + parkingMin + metroSegment.metroTravelMin + driveFromMin;
      const saved = drivingTimeMin - totalMin;

      if (saved >= MIN_TIME_SAVINGS_MINUTES && (!best || saved > best.timeSavedMin)) {
        best = {
          suggested: true,
          originStation: pickStation(oStation),
          destStation: pickStation(dStation),
          metroLine: metroSegment.metroLine,
          transferStation: metroSegment.transferStation ? pickStation(metroSegment.transferStation) : null,
          transferLine: metroSegment.transferLine || null,
          driveToStationMin: driveToMin,
          driveToStationKm: Math.round(driveToKm * 10) / 10,
          metroTravelMin: metroSegment.metroTravelMin,
          driveFromStationMin: driveFromMin,
          driveFromStationKm: Math.round(driveFromKm * 10) / 10,
          totalTimeMin: totalMin,
          timeSavedMin: saved,
          drivingTimeMin,
          trafficLevel,
        };
      }
    }
  }

  return best || { suggested: false, reason: "Metro alternative is not faster for this route." };
};

// ─── Copilot geocoder ─────────────────────────────────────────────────────────
//
// Resolves a free-text place name to real coordinates using the TomTom Search
// API with aggressive Riyadh biasing:
//
//   1. Always biases toward the user's position (falls back to Riyadh center).
//   2. Appends "الرياض" to queries that don't already mention Riyadh.
//   3. Fetches 5 candidates and picks the closest within MAX_POI_DISTANCE_KM.
//   4. Hard-rejects results > 50 km away (different city entirely).
//
// Returns { coordinates, placeName, address, neighborhood } or null.

const RIYADH_DEFAULT_LAT = 24.7136;
const RIYADH_DEFAULT_LNG = 46.6753;
const MAX_POI_DISTANCE_KM = 30;

const geocodeForCopilot = async (searchQuery, userLat, userLng) => {
  if (!TOMTOM_API_KEY || !searchQuery || typeof searchQuery !== "string") return null;

  const hasUserLocation =
    typeof userLat === "number" && !Number.isNaN(userLat) &&
    typeof userLng === "number" && !Number.isNaN(userLng);

  const biasLat = hasUserLocation ? userLat : RIYADH_DEFAULT_LAT;
  const biasLng = hasUserLocation ? userLng : RIYADH_DEFAULT_LNG;

  const queryLower = searchQuery.toLowerCase();
  const mentionsRiyadh =
    queryLower.includes("riyadh") ||
    queryLower.includes("الرياض") ||
    queryLower.includes("رياض");
  const augmentedQuery = mentionsRiyadh
    ? searchQuery.trim()
    : `${searchQuery.trim()} الرياض`;

  const params = {
    key:        TOMTOM_API_KEY,
    countrySet: "SA",
    limit:      5,
    language:   "ar",
    lat:        biasLat,
    lon:        biasLng,
    radius:     10000,
  };

  try {
    const response = await axios.get(
      `https://api.tomtom.com/search/2/search/${encodeURIComponent(augmentedQuery)}.json`,
      { params, timeout: 6000 }
    );

    const candidates = response.data.results || [];
    if (candidates.length === 0) {
      console.warn(`[copilot geocode] No results for: "${augmentedQuery}"`);
      return null;
    }

    let bestResult = null;
    let bestDist   = Infinity;

    for (const candidate of candidates) {
      const { lat, lon } = candidate.position;

      if (lat < 16 || lat > 32 || lon < 36 || lon > 56) continue;

      const dist = haversineDistanceKm(biasLat, biasLng, lat, lon);
      if (dist < bestDist && dist <= MAX_POI_DISTANCE_KM) {
        bestDist   = dist;
        bestResult = candidate;
      }
    }

    if (!bestResult) {
      const nearest = candidates.find((c) => {
        const { lat, lon } = c.position;
        return lat >= 16 && lat <= 32 && lon >= 36 && lon <= 56;
      });
      if (nearest) {
        const dist = haversineDistanceKm(biasLat, biasLng, nearest.position.lat, nearest.position.lon);
        console.warn(
          `[copilot geocode] Closest "${augmentedQuery}" is ${dist.toFixed(1)} km away — outside ${MAX_POI_DISTANCE_KM} km radius`
        );
        if (dist > 50) {
          console.warn(`[copilot geocode] Rejected: ${dist.toFixed(1)} km is too far (likely wrong city)`);
          return null;
        }
        bestResult = nearest;
        bestDist   = dist;
      }
    }

    if (!bestResult) {
      console.warn(`[copilot geocode] No valid Riyadh-area results for: "${augmentedQuery}"`);
      return null;
    }

    const { lat, lon } = bestResult.position;
    console.log(
      `[copilot geocode] "${augmentedQuery}" → [${lat}, ${lon}] (${bestDist.toFixed(1)} km from bias point)`
    );

    return {
      coordinates:  [lat, lon],
      placeName:    bestResult.poi?.name || null,
      address:      bestResult.address?.freeformAddress || null,
      neighborhood: bestResult.address?.municipalitySubdivision || null,
    };
  } catch (err) {
    console.warn("[copilot geocode] TomTom lookup failed:", err.message);
    return null;
  }
};

// ─── Traffic context serialiser ──────────────────────────────────────────────
//
// Converts the structured traffic context sent by the frontend into a concise
// Arabic text block that is injected into the AI prompt.  Keeping it as plain
// text (rather than raw JSON) makes it easier for the model to reference
// specific incidents in natural language.

const INCIDENT_TYPE_AR = {
  accident:        "حادث مروري",
  "road closure":  "إغلاق طريق",
  "heavy traffic": "ازدحام شديد",
  roadworks:       "أعمال طرق",
  hazard:          "خطر على الطريق",
};
const INCIDENT_SEVERITY_AR = { high: "خطير", medium: "متوسط", low: "خفيف" };
const TRAFFIC_LEVEL_AR     = { high: "كثيف جداً", medium: "متوسط", low: "خفيف" };

const buildTrafficContextBlock = (trafficContext) => {
  if (!trafficContext) return "";

  const lines = ["--- بيانات المرور الحية على خريطة المستخدم ---"];

  if (trafficContext.prediction) {
    const level = TRAFFIC_LEVEL_AR[trafficContext.prediction.level] ?? trafficContext.prediction.level;
    lines.push(
      `• الكثافة المرورية العامة الآن: ${level}` +
      ` (درجة ${trafficContext.prediction.score}/100، ثقة ${trafficContext.prediction.confidence})`
    );
  }

  const incidents = Array.isArray(trafficContext.incidents) ? trafficContext.incidents : [];
  if (incidents.length === 0) {
    lines.push("• لا توجد حوادث مرصودة حالياً — الطريق يبدو خالياً بناءً على البيانات الحية.");
  } else {
    lines.push(`• عدد الحوادث المرصودة: ${incidents.length}`);
    incidents.forEach((inc, idx) => {
      const type     = INCIDENT_TYPE_AR[inc.type]             ?? inc.type;
      const severity = INCIDENT_SEVERITY_AR[inc.severity]     ?? inc.severity;
      lines.push(`  ${idx + 1}. ${type} (${severity}): ${inc.message}`);
    });
  }

  lines.push("---");
  lines.push(
    "هذه بيانات المدينة الشاملة. نبّه المستخدم فقط عن الحوادث القريبة من موقعه أو مساره، وتجاهل البعيدة."
  );

  return "\n" + lines.join("\n") + "\n";
};

// ─── Static fallback data ──────────────────────────────────────────────────────

const STATIC_ALERTS = [
  {
    id: 1,
    type: "accident",
    lat: 24.71,
    lng: 46.67,
    severity: "high",
    message: "Accident reported. Expect delays.",
  },
  {
    id: 2,
    type: "rain",
    lat: 24.73,
    lng: 46.7,
    severity: "low",
    message: "Rain in the area. Drive with caution.",
  },
  {
    id: 3,
    type: "heavy traffic",
    lat: 24.72,
    lng: 46.68,
    severity: "medium",
    message: "Heavy congestion. Consider alternate route.",
  },
];

// Used when TomTom Incidents API is unavailable
const STATIC_INCIDENTS = [
  {
    id: "static-1",
    type: "accident",
    lat: 24.745,
    lng: 46.69,
    severity: "high",
    message: "Accident reported. Route may be delayed.",
  },
  {
    id: "static-2",
    type: "road closure",
    lat: 24.73,
    lng: 46.71,
    severity: "high",
    message: "Road closed ahead. Use alternative route.",
  },
  {
    id: "static-3",
    type: "heavy traffic",
    lat: 24.72,
    lng: 46.66,
    severity: "medium",
    message: "Heavy congestion detected.",
  },
];

// Map TomTom iconCategory to our incident type.
// TomTom categories: 1=Accident, 6=Jam, 7=LaneClosed, 8=RoadClosed, 9=RoadWorks, 14=BrokenDownVehicle
const resolveIncidentType = (iconCategory) => {
  if (iconCategory === 1) return "accident";
  if (iconCategory === 6) return "heavy traffic";
  if (iconCategory === 7 || iconCategory === 8) return "road closure";
  if (iconCategory === 9) return "roadworks";
  return "hazard";
};

// Map TomTom magnitudeOfDelay (1–4) to severity label
const resolveSeverity = (magnitude) => {
  if (magnitude >= 4) return "high";
  if (magnitude === 3) return "medium";
  return "low";
};

const buildIncidentMessage = (type, eventDescription) => {
  if (eventDescription) return eventDescription;
  const defaults = {
    accident:       "Accident reported. Route may be delayed.",
    "road closure": "Road closed ahead. Use alternative route.",
    "heavy traffic": "Heavy congestion detected.",
    roadworks:      "Roadworks ahead. Expect delays and lane restrictions.",
    hazard:         "Road hazard reported. Drive with caution.",
  };
  return defaults[type] || "Incident reported on this road.";
};

// ─── Groq call wrapper with 429 retry ────────────────────────────────────────
//
// Groq's free tier can return 429 (rate limit) under burst load.
// This wrapper retries once after a short pause before propagating the error.
const GROQ_RATE_LIMIT_RETRY_MS = 2000;

const callGroqWithRetry = async (groqClient, options) => {
  try {
    return await groqClient.chat.completions.create(options);
  } catch (firstErr) {
    const isRateLimit =
      firstErr.status === 429 ||
      (typeof firstErr.message === "string" &&
        (firstErr.message.includes("429") || firstErr.message.includes("rate_limit")));

    if (!isRateLimit) throw firstErr;

    console.warn(
      `[groq] Rate limit (429) on model "${options.model}". ` +
      `Retrying in ${GROQ_RATE_LIMIT_RETRY_MS}ms...`
    );
    await new Promise((resolve) => setTimeout(resolve, GROQ_RATE_LIMIT_RETRY_MS));
    return await groqClient.chat.completions.create(options);
  }
};

// ─── Incident humanizer ───────────────────────────────────────────────────────
//
// Converts raw TomTom incident records into a single Arabic-style traffic-status
// string that the Analyst agent can reference directly in its response.
// Deliberately avoids exposing the raw incident count to the Analyst so it
// cannot leak that number into the user-facing reply.

const humanizeIncidentSeverity = (incidents, locationName) => {
  if (!incidents || incidents.length === 0) {
    return `${locationName}: طريق سالك — لا توجد حوادث مرصودة.`;
  }

  const maxMagnitude   = Math.max(...incidents.map((i) => i.magnitudeOfDelay || 0));
  const hasStationary  = incidents.some((i) => i.eventCode === 101);
  const hasRoadClosure = incidents.some((i) => i.eventCode === 200);
  const hasRoadworks   = incidents.some((i) => i.type === "roadworks");
  const maxDelaySec    = Math.max(...incidents.map((i) => i.delaySeconds || 0));
  const maxDelayMin    = maxDelaySec > 0 ? Math.ceil(maxDelaySec / 60) : 0;

  // Pick the most severe incident for road-name context
  const worstIncident = incidents.reduce(
    (worst, inc) => (inc.magnitudeOfDelay > (worst?.magnitudeOfDelay || -1) ? inc : worst),
    null
  );

  let statusPhrase;
  if (hasRoadClosure) {
    statusPhrase = "إغلاق طريق كامل — تجنّب هذا المسار";
  } else if (hasStationary || maxMagnitude >= 4) {
    statusPhrase = "توقف تام عند بعض النقاط";
  } else if (maxMagnitude === 3) {
    statusPhrase = "ازدحام شديد / توقفات متقطعة عند الإشارات";
  } else if (maxMagnitude === 2) {
    statusPhrase = "زحمة ذروة معتادة، حركة بطيئة بعض الشيء";
  } else {
    statusPhrase = "حركة بطيئة نسبياً، الوضع مقبول";
  }

  let details = "";
  if (maxDelayMin > 0)  details += ` — تأخير متوقع ~${maxDelayMin} دقيقة`;
  if (hasRoadworks)     details += " — أعمال طرق وحفريات في المنطقة";

  // Add road name from the worst incident if available
  if (worstIncident) {
    if (worstIncident.from && worstIncident.to) {
      details += ` — على ${worstIncident.from}`;
    } else if (worstIncident.roadNumbers?.length) {
      details += ` — على ${worstIncident.roadNumbers.join("/")}`;
    }
  }

  return `${locationName}: ${statusPhrase}${details}.`;
};

// ─── Agent Tool: fetch_traffic_incidents ─────────────────────────────────────
//
// Called by the Data Gatherer agent to retrieve live TomTom incident data for
// a specific GPS location.  Returns a rich structured object so the Analyst
// agent can reference magnitudeOfDelay, event codes, and road names verbatim.

const fetchIncidentsForAgent = async (lat, lng, radiusKm, locationName) => {
  const clampedRadius = Math.min(Math.max(radiusKm, 1), 10);
  const delta = clampedRadius / 111;
  const bbox = [
    (lng - delta).toFixed(6),
    (lat - delta).toFixed(6),
    (lng + delta).toFixed(6),
    (lat + delta).toFixed(6),
  ].join(",");

  try {
    const response = await axios.get(
      "https://api.tomtom.com/traffic/services/5/incidentDetails",
      {
        params: {
          key: TOMTOM_API_KEY,
          bbox,
          fields:
            "{incidents{type,geometry{type,coordinates},properties{id,iconCategory,magnitudeOfDelay,events{description,code,iconCategory},from,to,length,delay,roadNumbers,timeValidity}}}",
          language: "en-GB",
          timeValidityFilter: "present",
        },
        timeout: 8000,
      }
    );

    const rawIncidents = response.data.incidents || [];
    console.log(
      `[agent tool] fetch_traffic_incidents "${locationName}" → ${rawIncidents.length} incident(s)`
    );

    const incidents = rawIncidents
      .map((incident) => {
        const props = incident.properties || {};
        const geometry = incident.geometry;
        if (!geometry?.coordinates) return null;

        let incidentLat, incidentLng;
        if (geometry.type === "Point") {
          [incidentLng, incidentLat] = geometry.coordinates;
        } else if (geometry.type === "LineString" && geometry.coordinates.length > 0) {
          const mid = Math.floor(geometry.coordinates.length / 2);
          [incidentLng, incidentLat] = geometry.coordinates[mid];
        } else {
          return null;
        }

        if (typeof incidentLat !== "number" || typeof incidentLng !== "number") return null;

        const type = resolveIncidentType(props.iconCategory || 0);
        const firstEvent = props.events?.[0] || {};

        return {
          type,
          severity:         resolveSeverity(props.magnitudeOfDelay || 0),
          magnitudeOfDelay: props.magnitudeOfDelay || 0,
          eventCode:        firstEvent.code        || null,
          eventDescription: firstEvent.description || buildIncidentMessage(type, null),
          roadNumbers:      props.roadNumbers       || [],
          from:             props.from              || null,
          to:               props.to                || null,
          delaySeconds:     props.delay             || 0,
          lengthMeters:     props.length            || 0,
          coordinates:      [incidentLat, incidentLng],
        };
      })
      .filter(Boolean);

    const summary =
      incidents.length === 0
        ? `No incidents near "${locationName}" within ${clampedRadius} km — roads appear clear.`
        : `${incidents.length} incident(s) near "${locationName}": ` +
          incidents
            .map(
              (i) =>
                `${i.type} (severity ${i.magnitudeOfDelay}/4` +
                (i.eventCode ? `, code ${i.eventCode}` : "") +
                (i.delaySeconds > 0
                  ? `, delay ${Math.ceil(i.delaySeconds / 60)} min`
                  : "") +
                (i.from && i.to ? `, ${i.from} → ${i.to}` : "") +
                ")"
            )
            .join("; ");

    return {
      location:          locationName,
      radiusKm:          clampedRadius,
      incidentCount:     incidents.length,
      highSeverityCount: incidents.filter((i) => i.magnitudeOfDelay >= 3).length,
      incidents,
      summary,
    };
  } catch (err) {
    console.warn(
      `[agent tool] fetch_traffic_incidents "${locationName}" failed:`,
      err.message
    );
    return {
      location:          locationName,
      radiusKm:          clampedRadius,
      incidentCount:     0,
      highSeverityCount: 0,
      incidents:         [],
      summary:           `TomTom API unavailable for "${locationName}" — no incident data retrieved.`,
      error:             err.message,
    };
  }
};

// ─── Agent Tool Executor ──────────────────────────────────────────────────────
//
// Dispatches a single Groq tool_call to the appropriate implementation and
// returns the JSON string to send back as a "tool" role message, plus any
// GPS coordinates resolved during the call (so the response can include them).

const executeAgentToolCall = async (toolCall, userLat, userLng) => {
  const fnName = toolCall.function.name;

  let args = {};
  try {
    args = JSON.parse(toolCall.function.arguments);
  } catch (parseErr) {
    console.warn(`[agent tool] Failed to parse args for "${fnName}":`, parseErr.message);
  }

  if (fnName === "search_place") {
    const rawQuery = args.query || "";
    const queryLower = rawQuery.toLowerCase();
    const alreadyMentionsRiyadh =
      queryLower.includes("riyadh") || rawQuery.includes("الرياض");
    const searchQuery = alreadyMentionsRiyadh
      ? rawQuery.trim()
      : `${rawQuery.trim()} Riyadh, Saudi Arabia`;

    console.log(`[agent tool] search_place("${searchQuery}")`);

    let placeResult = null;
    try {
      placeResult = await geocodeForCopilot(searchQuery, userLat, userLng);
    } catch (geoErr) {
      console.error("[agent tool] geocode crashed:", geoErr.message);
    }

    const content = placeResult
      ? JSON.stringify({
          found:        true,
          coordinates:  placeResult.coordinates,
          placeName:    placeResult.placeName,
          address:      placeResult.address,
          neighborhood: placeResult.neighborhood,
        })
      : JSON.stringify({
          found:   false,
          message: "لم يتم العثور على هذا المكان في الرياض. جرب وصفاً أو اسماً مختلفاً.",
        });

    return { content, resolvedCoords: placeResult?.coordinates ?? null };
  }

  if (fnName === "fetch_traffic_incidents") {
    const lat          = Number(args.lat);
    const lng          = Number(args.lng);
    const radiusKm     = Number(args.radius_km) || 3;
    const locationName = args.location_name || `[${lat.toFixed(3)}, ${lng.toFixed(3)}]`;

    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      return {
        content:       JSON.stringify({ error: "Invalid coordinates provided to fetch_traffic_incidents." }),
        resolvedCoords: null,
      };
    }

    const incidentData = await fetchIncidentsForAgent(lat, lng, radiusKm, locationName);
    return { content: JSON.stringify(incidentData), resolvedCoords: null };
  }

  return {
    content:       JSON.stringify({ error: true, message: `Unknown tool: ${fnName}` }),
    resolvedCoords: null,
  };
};

// ─── Async route wrapper ──────────────────────────────────────────────────────
// Express 4 does not catch rejected promises from async handlers. This wrapper
// ensures any uncaught rejection is forwarded to Express's error middleware
// instead of crashing the process with an unhandled rejection.
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// ─── API Routes ───────────────────────────────────────────────────────────────

// GET /api/traffic — Real-time traffic flow grid around Riyadh
app.get("/api/traffic", async (req, res) => {
  const grid = generateRiyadhGrid();
  const results = await Promise.all(
    grid.map(({ lat, lng }) => fetchFlowForPoint(lat, lng))
  );
  res.json({
    center: { lat: 24.7136, lng: 46.6753 },
    updatedAt: new Date(),
    points: results,
  });
});

// Shared rule-based traffic level computation used by both prediction endpoints
const computeTrafficPrediction = (lat, lng, timeOfDayHint) => {
  const now = new Date();
  const hour = timeOfDayHint.includes("morning")
    ? 8
    : timeOfDayHint.includes("rush")
    ? 17
    : timeOfDayHint.includes("night")
    ? 22
    : now.getHours();

  // 0 = Sun … 6 = Sat; Saudi weekend is Fri+Sat (5, 6)
  const isWeekend = now.getDay() === 5 || now.getDay() === 6;

  let baseScore = 50;
  let confidence = 0.65;

  if (hour >= 6 && hour <= 9) {
    baseScore = 78;
    confidence = 0.85;
  } else if (hour >= 15 && hour <= 20) {
    baseScore = 84;
    confidence = 0.9;
  } else if (hour >= 22 || hour <= 5) {
    baseScore = 16;
    confidence = 0.8;
  } else {
    baseScore = 50;
    confidence = 0.7;
  }

  if (isWeekend) {
    baseScore = Math.max(baseScore - 22, 8);
    confidence = Math.min(confidence + 0.05, 0.95);
  }

  // Small location-based variance so different coordinates return slightly different values
  const locationVariance = ((Math.abs(lat) * 1000 + Math.abs(lng) * 1000) % 9) - 4;
  const predictionScore = Math.min(100, Math.max(5, Math.round(baseScore + locationVariance)));

  let predictedTrafficLevel;
  if (predictionScore >= 68) predictedTrafficLevel = "high";
  else if (predictionScore >= 36) predictedTrafficLevel = "medium";
  else predictedTrafficLevel = "low";

  return {
    predictedTrafficLevel,
    predictionScore,
    confidence: `${Math.round(confidence * 100)}%`,
    // Legacy field kept for backward compatibility
    predictedTraffic: predictedTrafficLevel,
  };
};

// GET /api/traffic-prediction — AI-style traffic prediction with score and confidence
// Query params: lat, lng, timeOfDay (optional hint)
app.get("/api/traffic-prediction", (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  const timeOfDay = (req.query.timeOfDay || "").toLowerCase();

  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    return res.status(400).json({ error: "lat and lng are required numbers" });
  }

  res.json(computeTrafficPrediction(lat, lng, timeOfDay));
});

// GET /api/predict-traffic — Legacy endpoint kept for backward compatibility
app.get("/api/predict-traffic", (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  const timeOfDay = (req.query.timeOfDay || "").toLowerCase();

  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    return res.status(400).json({ error: "lat and lng are required numbers" });
  }

  res.json(computeTrafficPrediction(lat, lng, timeOfDay));
});

// GET /api/alerts — Static legacy alerts (kept for backward compatibility)
app.get("/api/alerts", (req, res) => {
  res.json(STATIC_ALERTS);
});

// GET /api/incidents — Live traffic incidents near a given location
// Query params: lat, lng, radius (km, max 50, default 15)
app.get("/api/incidents", async (req, res) => {
  const lat = parseFloat(req.query.lat) || 24.7136;
  const lng = parseFloat(req.query.lng) || 46.6753;
  const radiusKm = Math.min(parseFloat(req.query.radius) || 15, 50);

  const delta = radiusKm / 111;
  const minLng = (lng - delta).toFixed(6);
  const minLat = (lat - delta).toFixed(6);
  const maxLng = (lng + delta).toFixed(6);
  const maxLat = (lat + delta).toFixed(6);
  const bbox = `${minLng},${minLat},${maxLng},${maxLat}`;

  try {
    const response = await axios.get(
      "https://api.tomtom.com/traffic/services/5/incidentDetails",
      {
        params: {
          key: TOMTOM_API_KEY,
          bbox,
          fields:
            "{incidents{type,geometry{type,coordinates},properties{id,iconCategory,magnitudeOfDelay,events{description,code,iconCategory},from,to,length,delay,roadNumbers,timeValidity}}}",
          language: "en-GB",
          timeValidityFilter: "present",
        },
        timeout: 8000,
      }
    );

    const rawIncidents = response.data.incidents || [];

    console.log(
      `[incidents] TomTom bbox=${bbox} | raw incident count: ${rawIncidents.length}`
    );
    if (rawIncidents.length > 0) {
      console.log(
        "[incidents] TomTom Incidents Response (first item):",
        JSON.stringify(rawIncidents[0])
      );
    } else {
      console.log(
        "[incidents] TomTom returned 0 incidents for this bbox. Check API key / region coverage."
      );
    }

    const incidents = rawIncidents
      .map((incident) => {
        const props = incident.properties || {};
        const geometry = incident.geometry;
        if (!geometry?.coordinates) return null;

        let incidentLat, incidentLng;

        if (geometry.type === "Point") {
          [incidentLng, incidentLat] = geometry.coordinates;
        } else if (
          geometry.type === "LineString" &&
          geometry.coordinates.length > 0
        ) {
          // Use the midpoint of the line segment for pin placement
          const mid = Math.floor(geometry.coordinates.length / 2);
          [incidentLng, incidentLat] = geometry.coordinates[mid];
        } else {
          return null;
        }

        if (
          typeof incidentLat !== "number" ||
          typeof incidentLng !== "number"
        ) {
          return null;
        }

        const type = resolveIncidentType(props.iconCategory || 0);
        const severity = resolveSeverity(props.magnitudeOfDelay || 0);
        const message = buildIncidentMessage(
          type,
          props.events?.[0]?.description
        );

        return {
          id:
            props.id ||
            `${type}-${incidentLat.toFixed(4)}-${incidentLng.toFixed(4)}`,
          type,
          lat: incidentLat,
          lng: incidentLng,
          severity,
          message,
        };
      })
      .filter(Boolean);

    res.json(incidents);
  } catch (err) {
    console.error(
      "[incidents] TomTom error:",
      err.response?.status,
      err.message
    );
    // Return static fallback so the UI always has data to display
    res.json(STATIC_INCIDENTS);
  }
});

// GET /api/geocode — TomTom place search proxied server-side to protect API key
// Query params: q (required), language ("ar" | "ar-SA" | "en-US" | "en-GB", default "en-GB"), limit (default 5)
app.get("/api/geocode", async (req, res) => {
  const query = req.query.q;
  if (!query || query.trim().length < 2) {
    return res
      .status(400)
      .json({ error: "q must be at least 2 characters" });
  }

  // Accept language from the client so Arabic UI gets Arabic place names.
  // TomTom Search API only accepts the base "ar" tag — "ar-SA" is not a
  // supported locale and causes a 400, so both incoming Arabic variants are
  // normalised to "ar".
  const LANGUAGE_MAP = {
    "ar":    "ar",
    "ar-SA": "ar",
    "en-US": "en-US",
    "en-GB": "en-GB",
  };
  const language = LANGUAGE_MAP[req.query.language] ?? "en-GB";

  try {
    const response = await axios.get(
      `https://api.tomtom.com/search/2/search/${encodeURIComponent(
        query.trim()
      )}.json`,
      {
        params: {
          key: TOMTOM_API_KEY,
          countrySet: "SA",
          limit: 5,
          language,
        },
        timeout: 6000,
      }
    );

    const results = (response.data.results || []).map((r) => ({
      // Prefer POI name when available; fall back to the formatted address
      name: r.poi?.name || r.address?.freeformAddress || query,
      city:
        r.address?.municipality ||
        r.address?.municipalitySubdivision ||
        r.address?.countrySubdivision ||
        "",
      lat: r.position.lat,
      lng: r.position.lon,
    }));

    res.json(results);
  } catch (err) {
    console.error(
      "[geocode] TomTom error:",
      err.response?.status,
      err.message
    );
    res
      .status(502)
      .json({ error: "Geocoding failed. Please try another search." });
  }
});

// POST /api/recommend-route — Returns up to 3 route alternatives with labels, colors, and scores
// Body: { startLat, startLng, endLat, endLng }
// Response: { routes[], recommendedIndex, ...activeRoute }
app.post("/api/recommend-route", async (req, res) => {
  const { startLat, startLng, endLat, endLng } = req.body;

  if (startLat == null || startLng == null || endLat == null || endLng == null) {
    return res.status(400).json({
      error: "startLat, startLng, endLat, endLng are required",
    });
  }

  const coords = [startLat, startLng, endLat, endLng].map(Number);

  if (coords.some(Number.isNaN)) {
    return res.status(400).json({
      error: "startLat, startLng, endLat, endLng must be valid numbers",
    });
  }

  const [fromLat, fromLng, toLat, toLng] = coords;
  console.log(`[recommend-route] ${fromLat.toFixed(4)},${fromLng.toFixed(4)} → ${toLat.toFixed(4)},${toLng.toFixed(4)}`);

  // Layer 1: Try TomTom Routing API for real traffic-aware routes
  try {
    const response = await axios.get(
      `https://api.tomtom.com/routing/1/calculateRoute/${fromLat},${fromLng}:${toLat},${toLng}/json`,
      {
        params: {
          key: TOMTOM_API_KEY,
          traffic: true,
          travelMode: "car",
          routeType: "fastest",
          maxAlternatives: 2,
          instructionsType: "text",
          language: "ar",
        },
        timeout: 15000,
      }
    );

    const rawRoutes = response.data.routes || [];
    if (rawRoutes.length === 0) throw new Error("No routes returned by TomTom");

    const normalizedRoutes = rawRoutes.map(normalizeRealRoute);
    const labeledRoutes = labelAndColorRoutes(normalizedRoutes);
    const recommendedIndex = labeledRoutes.findIndex((r) => r.isRecommended);
    const safeRecommendedIndex = recommendedIndex >= 0 ? recommendedIndex : 0;

    console.log(`[recommend-route] TomTom returned ${labeledRoutes.length} route(s)`);

    return res.json({
      routes: labeledRoutes,
      recommendedIndex: safeRecommendedIndex,
      ...labeledRoutes[safeRecommendedIndex],
    });
  } catch (tomtomErr) {
    console.warn(
      "[recommend-route] TomTom Routing failed, using synthetic fallback:",
      tomtomErr.response?.status || tomtomErr.code,
      tomtomErr.message
    );
  }

  // Layer 2: Synthetic fallback — score straight-line candidates against live traffic grid
  try {
    const grid = generateRiyadhGrid();
    const trafficPoints = await Promise.all(
      grid.map(({ lat, lng }) => fetchFlowForPoint(lat, lng))
    );
    const syntheticRoutes = buildSyntheticRoutes(fromLat, fromLng, toLat, toLng, trafficPoints);
    const labeledRoutes = labelAndColorRoutes(syntheticRoutes);
    const recommendedIndex = labeledRoutes.findIndex((r) => r.isRecommended);
    const safeRecommendedIndex = recommendedIndex >= 0 ? recommendedIndex : 0;

    console.log(`[recommend-route] Synthetic fallback returned ${labeledRoutes.length} route(s)`);

    return res.json({
      routes: labeledRoutes,
      recommendedIndex: safeRecommendedIndex,
      ...labeledRoutes[safeRecommendedIndex],
    });
  } catch (fallbackErr) {
    console.error("[recommend-route] Fallback also failed:", fallbackErr.message);
    return res.status(500).json({ error: "Route calculation failed. Please try again." });
  }
});

// Server-side sliding window: keep the last N complete turns (user + assistant pairs).
const MAX_COPILOT_HISTORY_TURNS = 6; // 12 messages — roughly 10-15 min of conversation

// The Data Gatherer may call tools multiple times (e.g. 3 branches × 2 tools each).
const MAX_GATHERER_TOOL_ROUNDS = 6;

// POST /api/copilot — Multi-Agent Traffic Expert with two-phase Groq pipeline.
//
// Phase 1 (Data Gatherer Agent):
//   A Groq call at low temperature with COPILOT_TOOLS enabled.
//   Runs a tool-calling loop: search_place → fetch_traffic_incidents for each location.
//   Accumulates a structured evidence report (text block) and any resolved GPS coords.
//
// Phase 2 (Traffic Analyst Agent):
//   A second Groq call (no tools) at higher temperature for natural Arabic output.
//   Receives: original user message + conversation history + the evidence report.
//   Produces: a detailed, justified Arabic response referencing real TomTom numbers.
//
// Body: {
//   message:         string,
//   history?:        [{ role: "user"|"assistant", text: string }],
//   trafficContext?: { incidents: [{type,severity,message}], prediction: {level,score,confidence} },
//   userLocation?:   [latitude: number, longitude: number]
// }
app.post("/api/copilot", asyncHandler(async (req, res) => {
  try {
    const userText       = req.body.message || req.body.text;
    const rawHistory     = Array.isArray(req.body.history) ? req.body.history : [];
    const trafficContext = req.body.trafficContext ?? null;

    const rawLocation = req.body.userLocation;
    const rawLat = Array.isArray(rawLocation) ? Number(rawLocation[0]) : NaN;
    const rawLng = Array.isArray(rawLocation) ? Number(rawLocation[1]) : NaN;

    // Only trust frontend coordinates inside the Riyadh metro area (~100 km box).
    const isInsideRiyadhArea =
      !Number.isNaN(rawLat) && !Number.isNaN(rawLng) &&
      rawLat >= 24.3 && rawLat <= 25.2 &&
      rawLng >= 46.2 && rawLng <= 47.2;
    const userLat = isInsideRiyadhArea ? rawLat : RIYADH_DEFAULT_LAT;
    const userLng = isInsideRiyadhArea ? rawLng : RIYADH_DEFAULT_LNG;

    if (!userText || typeof userText !== "string") {
      return res.status(400).json({ error: "لم يتم إرسال أي نص صحيح من الموقع." });
    }
    const trimmed = userText.trim();
    if (trimmed.length === 0) {
      return res.status(400).json({ error: "النص المرسل فارغ." });
    }

    const groqClient = getGroqClient();
    if (!groqClient) {
      return res.status(503).json({ error: "خدمة الذكاء الاصطناعي غير مفعلة في السيرفر." });
    }

    // ── Shared history (used only in Phase 2) ─────────────────────────────────
    const historyMessages = rawHistory
      .filter(h => h && typeof h.text === "string" && (h.role === "user" || h.role === "assistant"))
      .slice(-(MAX_COPILOT_HISTORY_TURNS * 2))
      .map(h => ({ role: h.role, content: h.text.trim() }));

    // ── Build the Data Gatherer's initial user prompt ─────────────────────────
    // Written in English so the Gatherer reasons precisely about tool sequencing.
    const trafficContextBlock = buildTrafficContextBlock(trafficContext);
    const gathererUserContent =
      `User is at [${userLat.toFixed(4)}, ${userLng.toFixed(4)}] in Riyadh.\n` +
      (trafficContextBlock ? `City-wide traffic context:\n${trafficContextBlock}\n` : "") +
      `User request: "${trimmed}"\n\n` +
      `Instructions: Follow your workflow — plan, search every relevant place, ` +
      `fetch incidents for each, and fetch incidents for the user's current location too.`;

    // ═══════════════════════════════════════════════════════════════════════════
    // PHASE 1 — DATA GATHERER AGENT
    // ═══════════════════════════════════════════════════════════════════════════

    let gathererMessages = [
      { role: "system", content: DATA_GATHERER_SYSTEM_PROMPT },
      { role: "user",   content: gathererUserContent },
    ];

    let resolvedCoords = null;
    const evidenceLines = []; // humanized report lines fed to the Analyst
    let gathererRound = 0;
    let searchCallsUsed   = 0; // budget: max 2 search_place calls
    let incidentCallsUsed = 0; // budget: max 2 fetch_traffic_incidents calls

    console.log(`[agent:gatherer] Starting data collection for: "${trimmed}"`);

    while (gathererRound < MAX_GATHERER_TOOL_ROUNDS) {
      // Stop early if both budgets are exhausted — no point calling the LLM again
      if (searchCallsUsed >= 2 && incidentCallsUsed >= 2) {
        console.log("[agent:gatherer] Tool budget exhausted (2+2). Moving to Analyst.");
        break;
      }

      let gathererCompletion;
      try {
        gathererCompletion = await callGroqWithRetry(groqClient, {
          model:       GROQ_MODEL,
          messages:    gathererMessages,
          tools:       COPILOT_TOOLS,
          tool_choice: "auto",
          temperature: 0.1, // near-deterministic for reliable tool sequencing
          max_tokens:  512,
        });
      } catch (groqErr) {
        return handleLLMError(res, groqErr, "gatherer-agent");
      }

      const gathererAssistantMsg = gathererCompletion.choices[0].message;
      gathererMessages = [...gathererMessages, gathererAssistantMsg];

      const toolCalls = gathererAssistantMsg.tool_calls;
      if (!toolCalls || toolCalls.length === 0) {
        console.log(`[agent:gatherer] Done after ${gathererRound} tool round(s).`);
        break;
      }

      console.log(
        `[agent:gatherer] Round ${gathererRound + 1}: ${toolCalls.length} tool call(s) — ` +
        toolCalls.map((tc) => tc.function.name).join(", ")
      );

      // Execute tool calls, enforcing the 2+2 budget; skip over-budget calls
      const toolResultMessages = [];
      for (const toolCall of toolCalls) {
        const fn = toolCall.function.name;
        const overBudget =
          (fn === "search_place"           && searchCallsUsed   >= 2) ||
          (fn === "fetch_traffic_incidents" && incidentCallsUsed >= 2);

        let content;
        if (overBudget) {
          console.log(`[agent:gatherer] Skipping "${fn}" — budget reached.`);
          content = JSON.stringify({
            skipped: true,
            reason: "Tool call budget limit reached. Use only the data already collected.",
          });
        } else {
          const result = await executeAgentToolCall(toolCall, userLat, userLng);
          content = result.content;
          if (result.resolvedCoords) resolvedCoords = result.resolvedCoords;

          if (fn === "search_place")           searchCallsUsed++;
          if (fn === "fetch_traffic_incidents") incidentCallsUsed++;

          // Build a humanized, count-free evidence line for the Analyst
          try {
            const parsed = JSON.parse(content);

            if (fn === "search_place") {
              evidenceLines.push(
                parsed.found
                  ? `[مكان وُجد] "${parsed.placeName || "?"}" → إحداثيات [${parsed.coordinates}]` +
                    (parsed.neighborhood ? ` — ${parsed.neighborhood}` : "") +
                    (parsed.address ? ` (${parsed.address})` : "")
                  : `[مكان غير موجود] الاستعلام: ${toolCall.function.arguments}`
              );
            } else if (fn === "fetch_traffic_incidents") {
              // Use humanized phrase instead of raw incident count
              const humanStatus = humanizeIncidentSeverity(
                parsed.incidents || [],
                parsed.location || "المنطقة"
              );
              evidenceLines.push(`[حالة المرور] ${humanStatus}`);

              // Emit at most 2 of the most severe incidents for deeper context
              const worstTwo = (parsed.incidents || [])
                .filter((i) => i.magnitudeOfDelay >= 2)
                .sort((a, b) => b.magnitudeOfDelay - a.magnitudeOfDelay)
                .slice(0, 2);

              worstTwo.forEach((inc) => {
                evidenceLines.push(
                  `  ↳ نوع: ${inc.type}` +
                  ` | شدة: ${inc.magnitudeOfDelay}/4` +
                  (inc.eventCode        ? ` | كود ${inc.eventCode}: "${inc.eventDescription}"` : "") +
                  (inc.delaySeconds > 0 ? ` | تأخير: ${Math.ceil(inc.delaySeconds / 60)} دقيقة` : "") +
                  (inc.from && inc.to   ? ` | من ${inc.from} إلى ${inc.to}`                    : "") +
                  (inc.roadNumbers?.length ? ` | الطريق: ${inc.roadNumbers.join("/")}`         : "")
                );
              });
            }
          } catch {
            evidenceLines.push(`[نتيجة أداة] ${content.slice(0, 200)}`);
          }
        }

        toolResultMessages.push({
          role:         "tool",
          tool_call_id: toolCall.id,
          content,
        });
      }

      gathererMessages = [...gathererMessages, ...toolResultMessages];
      gathererRound++;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PHASE 2 — TRAFFIC ANALYST AGENT
    // ═══════════════════════════════════════════════════════════════════════════

    const evidenceReport =
      evidenceLines.length > 0
        ? "=== تقرير وكيل البيانات (بيانات TomTom الحية) ===\n" +
          evidenceLines.join("\n") +
          "\n==================================================="
        : "[وكيل البيانات: لم يُعثر على بيانات إضافية — أجب بناءً على السياق المتاح]";

    const locationHintAr =
      `[موقع المستخدم: ${userLat.toFixed(4)}, ${userLng.toFixed(4)}]`;

    // Build the Analyst's user message: evidence + city context + original request
    const analystUserContent =
      `${evidenceReport}\n\n` +
      (trafficContextBlock ? `${trafficContextBlock}\n` : "") +
      `${locationHintAr}\n\n` +
      `طلب المستخدم الأصلي: "${trimmed}"`;

    console.log(
      `[agent:analyst] Synthesizing response. Evidence lines: ${evidenceLines.length}`
    );

    let analystCompletion;
    try {
      analystCompletion = await callGroqWithRetry(groqClient, {
        model:    GROQ_MODEL,
        messages: [
          { role: "system", content: ANALYST_SYSTEM_PROMPT },
          ...historyMessages,
          { role: "user",   content: analystUserContent },
        ],
        temperature: 0.7, // natural, varied Arabic phrasing
        max_tokens:  1024,
      });
    } catch (groqErr) {
      return handleLLMError(res, groqErr, "analyst-agent");
    }

    let replyText = analystCompletion.choices[0].message.content || "";

    if (!replyText && resolvedCoords) {
      replyText = "تم العثور على المكان! اضغط 'انطلق الآن' للتوجه.";
    } else if (!replyText) {
      replyText = "عذراً، ما قدرت أفهم طلبك. حاول مرة ثانية.";
    }

    return res.json({
      reply:   replyText,
      message: replyText,
      coords:  resolvedCoords,
    });

  } catch (error) {
    return handleLLMError(res, error, "copilot-outer");
  }
}));

// Shared error handler for Groq / copilot failures.
// Distinguishes rate-limit (429) from other errors so the frontend can
// show a meaningful message instead of a generic "Internal Server Error".
function handleLLMError(res, error, context) {
  const isRateLimit =
    error.status === 429 ||
    (typeof error.message === "string" &&
      (error.message.includes("429") ||
       error.message.includes("rate_limit") ||
       error.message.includes("quota")));

  if (isRateLimit) {
    console.warn(`[copilot:${context}] Groq rate-limited (429). Returning friendly message.`);
    return res.status(429).json({
      error:   "تم تجاوز حد الطلبات. حاول مرة أخرى بعد دقيقة.",
      reply:   "عذراً، الخدمة مشغولة حالياً. حاول مرة أخرى بعد شوي.",
      message: "عذراً، الخدمة مشغولة حالياً. حاول مرة أخرى بعد شوي.",
      coords:  null,
    });
  }

  console.error(`[copilot:${context}] Unexpected error:`, error.message || error);
  return res.status(500).json({
    error:   "حدث خطأ داخلي في الخادم.",
    reply:   "عذراً، صار خطأ غير متوقع. حاول مرة ثانية.",
    message: "عذراً، صار خطأ غير متوقع. حاول مرة ثانية.",
    coords:  null,
  });
}

// GET /health
app.get("/health", (req, res) =>
  res.json({ status: "ok", timestamp: new Date() })
);

// ─── Catch-all error middleware ───────────────────────────────────────────────
// Must be registered AFTER all routes. Catches any error forwarded by
// asyncHandler or next(err) and returns a structured JSON response.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error("[express] Unhandled route error:", err.message || err);
  if (res.headersSent) return;
  return handleLLMError(res, err, "express-fallback");
});

app.listen(PORT, () => {
  console.log(`[server] Trafstant backend running on port ${PORT}`);
});
