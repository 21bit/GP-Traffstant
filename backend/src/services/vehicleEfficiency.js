const { GoogleGenerativeAI } = require("@google/generative-ai");

const DEFAULT_TIMEOUT_MS = 15000;
const MIN_KM_PER_L = 3;
const MAX_KM_PER_L = 35;
const efficiencyCache = new Map();
const CACHE_LIMIT = 100;

function cleanText(value, max) {
  if (value === undefined || value === null) return "";
  return String(value).replace(/\s+/g, " ").trim().slice(0, max);
}

function normalizeVehicle(input) {
  if (!input || typeof input !== "object") {
    const err = new Error("Vehicle details are required.");
    err.status = 400;
    err.code = "INVALID_VEHICLE";
    throw err;
  }

  const modified = Boolean(input.modified);
  const manufacturer = cleanText(input.manufacturer, 80);
  const model = cleanText(input.model, 80);
  const modifications = cleanText(input.modifications, 500);

  let year = null;
  if (input.year !== undefined && input.year !== null && input.year !== "") {
    year = Number(input.year);
    const maxYear = new Date().getFullYear() + 1;
    if (!Number.isInteger(year) || year < 1980 || year > maxYear) {
      const err = new Error("Model year must be between 1980 and next year.");
      err.status = 400;
      err.code = "INVALID_VEHICLE";
      throw err;
    }
  }

  let engineDisplacementL = null;
  if (
    input.engineDisplacementL !== undefined &&
    input.engineDisplacementL !== null &&
    input.engineDisplacementL !== ""
  ) {
    engineDisplacementL = Number(input.engineDisplacementL);
    if (
      !Number.isFinite(engineDisplacementL) ||
      engineDisplacementL <= 0 ||
      engineDisplacementL > 12
    ) {
      const err = new Error(
        "Engine displacement must be a positive number of liters, up to 12."
      );
      err.status = 400;
      err.code = "INVALID_VEHICLE";
      throw err;
    }
  }

  const fuelType = ["gasoline", "diesel", "unknown"].includes(input.fuelType)
    ? input.fuelType
    : "unknown";

  let forcedInduction = "unknown";
  if (input.forcedInduction === true || input.forcedInduction === "turbo") {
    forcedInduction = "turbo";
  } else if (input.forcedInduction === "none" || input.forcedInduction === false) {
    forcedInduction = "none";
  } else if (input.forcedInduction === "supercharged") {
    forcedInduction = "supercharged";
  }

  const hasIdentity = Boolean(manufacturer && model);
  const hasEngine = engineDisplacementL !== null;
  const hasNotes = modifications.length >= 3;
  if (!modified && !hasIdentity) {
    const err = new Error("Manufacturer and model are required for a standard vehicle.");
    err.status = 400;
    err.code = "INVALID_VEHICLE";
    throw err;
  }
  if (modified && manufacturer && !model) {
    const err = new Error("Add the model, or leave both manufacturer and model empty.");
    err.status = 400;
    err.code = "INVALID_VEHICLE";
    throw err;
  }
  if (modified && model && !manufacturer) {
    const err = new Error("Add the manufacturer, or leave both manufacturer and model empty.");
    err.status = 400;
    err.code = "INVALID_VEHICLE";
    throw err;
  }
  if (modified && !hasIdentity && !hasEngine && !hasNotes) {
    const err = new Error(
      "Add the manufacturer and model, the engine size, or a short description of the modifications."
    );
    err.status = 400;
    err.code = "INVALID_VEHICLE";
    throw err;
  }

  return {
    modified,
    manufacturer,
    model,
    year,
    engineDisplacementL,
    fuelType,
    forcedInduction,
    modifications,
  };
}

function vehicleCacheKey(vehicle) {
  return JSON.stringify(vehicle);
}

function buildEfficiencyPrompt(vehicle) {
  const lines = [
    "Estimate typical combined fuel efficiency for one vehicle.",
    "Return JSON only, with this shape:",
    '{"kmPerLiter": number|null, "basis": "published_specification"|"approximation"|"unavailable", "explanation": string, "confidence": "high"|"medium"|"low"|null}',
    "Rules:",
    "- kmPerLiter is kilometers per liter for mixed driving, not a trip fuel total.",
    "- Prefer a published combined manufacturer figure when you actually know one.",
    "- Use basis published_specification only for that case.",
    "- Use approximation when you are inferring from similar vehicles or incomplete data.",
    "- If the description is too incomplete for a reasonable estimate, set kmPerLiter to null and basis to unavailable.",
    "- Do not invent specifications, citations, or a precise number you cannot support.",
    "- confidence may be high or medium only for a published figure you know. Use low or null for approximations. Use null when unavailable.",
    "- Do not calculate liters, trip cost, or a distance-based result.",
    "- explanation must be one or two short sentences in Arabic.",
    "",
    `Modified: ${vehicle.modified ? "yes" : "no, factory configuration"}`,
    `Manufacturer: ${vehicle.manufacturer || "unknown"}`,
    `Model: ${vehicle.model || "unknown"}`,
    `Year: ${vehicle.year || "unknown"}`,
    `Fuel type: ${vehicle.fuelType}`,
    `Engine displacement (L): ${
      vehicle.engineDisplacementL === null ? "unknown" : vehicle.engineDisplacementL
    }`,
    `Forced induction: ${vehicle.forcedInduction}`,
    `Modifications: ${vehicle.modifications || "none stated"}`,
  ];
  return lines.join("\n");
}

function extractJson(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_err) {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
      try {
        return JSON.parse(fenced[1]);
      } catch (_inner) {
        return null;
      }
    }
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch (_inner) {
        return null;
      }
    }
    return null;
  }
}

function interpretEfficiencyPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return {
      status: "malformed",
      kmPerLiter: null,
      basis: "unavailable",
      explanation: "تعذر قراءة تقدير الكفاءة من خدمة الذكاء الاصطناعي.",
      confidence: null,
    };
  }

  const basis = ["published_specification", "approximation", "unavailable"].includes(
    payload.basis
  )
    ? payload.basis
    : null;
  const explanation = cleanText(payload.explanation, 400);
  let confidence = ["high", "medium", "low"].includes(payload.confidence)
    ? payload.confidence
    : null;

  if (payload.kmPerLiter === null || payload.kmPerLiter === undefined || payload.kmPerLiter === "") {
    return {
      status: "unavailable",
      kmPerLiter: null,
      basis: "unavailable",
      explanation: explanation || "لا تتوفر بيانات كافية لتقدير كفاءة هذه المركبة.",
      confidence: null,
    };
  }

  const kmPerLiter = Number(payload.kmPerLiter);
  if (!Number.isFinite(kmPerLiter) || kmPerLiter <= 0) {
    return {
      status: "malformed",
      kmPerLiter: null,
      basis: "unavailable",
      explanation: "القيمة التي أرجعتها الخدمة ليست كفاءة صالحة بالكيلومتر لكل لتر.",
      confidence: null,
    };
  }

  if (kmPerLiter < MIN_KM_PER_L || kmPerLiter > MAX_KM_PER_L) {
    return {
      status: "uncertain",
      kmPerLiter: null,
      basis: "unavailable",
      explanation:
        "الخدمة أرجعت قيمة خارج المدى المعقول لكفاءة سيارة ركاب، لذلك لم تُستخدم.",
      confidence: null,
    };
  }

  const resolvedBasis = basis && basis !== "unavailable" ? basis : "approximation";
  if (resolvedBasis !== "published_specification") {
    confidence = confidence === "low" ? "low" : null;
  }

  return {
    status: "ok",
    kmPerLiter: Math.round(kmPerLiter * 100) / 100,
    basis: resolvedBasis,
    explanation: explanation || "تقدير تقريبي لكفاءة الوقود بناءً على وصف المركبة.",
    confidence,
  };
}

function classifyProviderError(err) {
  const status = err?.status || err?.statusCode;
  const message = String(err?.message || err || "");
  if (status === 429 || /429|rate limit|resource exhausted|quota/i.test(message)) {
    return "rate_limited";
  }
  if (err?.code === "TIMEOUT" || /timeout|timed out/i.test(message)) {
    return "timeout";
  }
  return "provider_error";
}

function failureResult(status) {
  const explanations = {
    unavailable:
      "مفتاح GEMINI_API_KEY غير موجود في ملف backend/.env. أضفه ثم أعد تشغيل الخادم.",
    timeout: "انتهت مهلة خدمة تقدير الكفاءة. حاول مرة أخرى بعد قليل.",
    rate_limited: "خدمة تقدير الكفاءة مشغولة حالياً. حاول مرة أخرى بعد قليل.",
    provider_error: "تعذر الوصول إلى خدمة تقدير الكفاءة. لم يُحسب استهلاك الرحلة.",
    malformed: "تعذر قراءة تقدير الكفاءة من خدمة الذكاء الاصطناعي.",
  };
  return {
    status,
    kmPerLiter: null,
    basis: "unavailable",
    explanation: explanations[status] || explanations.provider_error,
    confidence: null,
  };
}

function remember(key, value) {
  if (efficiencyCache.size >= CACHE_LIMIT) {
    const oldest = efficiencyCache.keys().next().value;
    efficiencyCache.delete(oldest);
  }
  efficiencyCache.set(key, value);
}

function createGeminiGenerator() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || "gemini-3.8-flash",
    generationConfig: {
      temperature: 0.2,
      responseMimeType: "application/json",
    },
  });
  return async function generate(prompt) {
    const result = await model.generateContent(prompt);
    return result.response.text();
  };
}

function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const err = new Error("Vehicle efficiency request timed out.");
      err.code = "TIMEOUT";
      reject(err);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Estimate km/L for a vehicle. Trip distance is intentionally not an input.
 * @param {object} input vehicle description
 * @param {{ generate?: Function, timeoutMs?: number, bypassCache?: boolean }} [options]
 */
async function estimateVehicleEfficiency(input, options = {}) {
  const vehicle = normalizeVehicle(input);
  const key = vehicleCacheKey(vehicle);
  if (!options.bypassCache && efficiencyCache.has(key)) {
    return { ...efficiencyCache.get(key), cached: true, vehicle };
  }

  const generate = options.generate || createGeminiGenerator();
  if (!generate) {
    return { ...failureResult("unavailable"), cached: false, vehicle };
  }

  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  try {
    const text = await withTimeout(
      Promise.resolve(generate(buildEfficiencyPrompt(vehicle))),
      timeoutMs
    );
    const parsed = interpretEfficiencyPayload(extractJson(text));
    const result = { ...parsed, cached: false, vehicle };
    if (result.status === "ok") remember(key, result);
    return result;
  } catch (err) {
    const status = classifyProviderError(err);
    console.error(
      "[fuel-efficiency]",
      status,
      String(err?.message || err).slice(0, 300)
    );
    return {
      ...failureResult(status),
      cached: false,
      vehicle,
    };
  }
}

function clearEfficiencyCache() {
  efficiencyCache.clear();
}

module.exports = {
  estimateVehicleEfficiency,
  normalizeVehicle,
  buildEfficiencyPrompt,
  interpretEfficiencyPayload,
  extractJson,
  clearEfficiencyCache,
  MIN_KM_PER_L,
  MAX_KM_PER_L,
};
