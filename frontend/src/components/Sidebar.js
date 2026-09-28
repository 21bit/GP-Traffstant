import React, { useState, useRef, useEffect, useLayoutEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { useLanguage } from "../LanguageContext";
import traffstantLogo from "../images/traffstant_logo_dark.svg.svg";

// Base URL for all backend API calls (search, meeting-point, calculate-routes).
const BACKEND_BASE =
  process.env.REACT_APP_API_BASE || "http://localhost:4000";

// ─── Search (proxied through backend) ────────────────────────────────────────

/**
 * User-facing message shown whenever the Render backend returns a 5xx error
 * or the request fails / times out (geocode AND route fetch).
 * Defined at module scope so the component's useEffect can compare against
 * the same string that RouteEngine.js writes into the routeError prop.
 */
const SERVER_PRESSURE_MESSAGE =
  "السيرفر عليه ضغط حالياً، يرجى المحاولة مرة أخرى بعد قليل";

/**
 * @param {string}      query         - Search term typed by the user.
 * @param {AbortSignal} signal        - Cancel token; stale requests are silently dropped.
 * @param {number|null} biasLat       - Latitude for proximity biasing.
 * @param {number|null} biasLon       - Longitude for proximity biasing.
 * @param {Function}    onServerError - Called when the backend returns 5xx/429 or
 *                                     the request fails/times out (not on abort).
 * @returns {Promise<Array>} Place objects: { name, lat, lng, distance, neighborhood, source }
 */
const searchPlaces = async (
  query,
  signal,
  biasLat = null,
  biasLon = null,
  onServerError = null,
) => {
  const trimmed = query?.trim() ?? "";
  if (trimmed.length <= 2) return [];

  try {
    let url = `${BACKEND_BASE}/api/geocode?q=${encodeURIComponent(trimmed)}`;

    // Bias results toward the map center so the nearest branch surfaces first.
    const hasValidBias =
      typeof biasLat === "number" && Number.isFinite(biasLat) &&
      typeof biasLon === "number" && Number.isFinite(biasLon);
    if (hasValidBias) {
      url += `&lat=${biasLat}&lon=${biasLon}`;
    }

    const res = await fetch(url, { signal });

    if (!res.ok) {
      console.error(`[search-places] Backend HTTP ${res.status} for query "${trimmed}"`);
      // Surface server-side errors (5xx) and rate-limit (429) as a user toast.
      if (res.status >= 500 || res.status === 429) {
        onServerError?.();
      }
      return [];
    }

    const data = await res.json();
    const results = Array.isArray(data) ? data : [];

    // /api/geocode returns { name, city, lat, lng, dist? }
    // `dist` is metres from the bias point — only present when lat/lon were sent.
    // Map `city` → `neighborhood` to match the internal place shape.
    return results.slice(0, 15).map((item) => ({
      name:         item.name,
      lat:          item.lat,
      lng:          item.lng,
      distance:     item.dist ?? null,
      neighborhood: item.city || null,
      source:       "tomtom",
    }));
  } catch (err) {
    if (err.name === "AbortError") return [];
    // Network failures and timeouts are user-visible; abort silently drops.
    console.error(`[search-places] Error for query "${trimmed}":`, err.message);
    onServerError?.();
    return [];
  }
};

// ─── Utilities ────────────────────────────────────────────────────────────────

const formatCoords = (coords) =>
  `${coords[0].toFixed(4)}, ${coords[1].toFixed(4)}`;

/**
 * How long (ms) to wait after the last keystroke before firing a TomTom Search
 * API request.  A single named constant avoids three independent magic numbers
 * and makes tuning easy when TomTom quota changes.
 *
 * 600 ms is the minimum recommended interval under TomTom's free-tier QPS
 * budget for interactive autocomplete. Raise it if 429s persist.
 */
const SEARCH_DEBOUNCE_MS = 600;

// ─── Meeting Point constants ───────────────────────────────────────────────────
// Defined at module scope so they are available to the useEffect that syncs
// participant pins to the map without creating a forward-reference inside the
// component body.

const PARTICIPANT_DOT_COLORS = ["#0EA5E9", "#EF4444", "#22C55E", "#F59E0B"];

// ─── Config maps ──────────────────────────────────────────────────────────────

const TRAFFIC_COLOR = {
  low:    { color: "#22C55E", bg: "#052E16" },
  medium: { color: "#F59E0B", bg: "#451A03" },
  high:   { color: "#EF4444", bg: "#450A0A" },
};

const INCIDENT_CONFIG = {
  accident:        { icon: "⚠️",  borderColor: "#EF4444" },
  rain:            { icon: "🌧️", borderColor: "#0EA5E9" },
  "heavy traffic": { icon: "🚦",  borderColor: "#F97316" },
  "road closure":  { icon: "🚧",  borderColor: "#A855F7" },
  hazard:          { icon: "⚡",  borderColor: "#F59E0B" },
};

// ─── GPS icon SVG ─────────────────────────────────────────────────────────────

const GpsIcon = ({ size = 15 }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="3" />
    <line x1="12" y1="2" x2="12" y2="7" />
    <line x1="12" y1="17" x2="12" y2="22" />
    <line x1="2"  y1="12" x2="7"  y2="12" />
    <line x1="17" y1="12" x2="22" y2="12" />
  </svg>
);

// ─── Portal-based suggestion dropdown ────────────────────────────────────────
//
// Renders via React Portal into document.body with position:fixed so it is
// never clipped by the sidebar's overflow:auto scroll container.

const SearchDropdownPortal = ({
  suggestions,
  onSelect,
  isRTL,
  anchorRef,
  show,
  showUseLocation = false,
  onUseLocation,
}) => {
  const [dropRect, setDropRect] = useState(null);

  const isVisible = show || showUseLocation;

  // Recalculate fixed position whenever the dropdown becomes visible.
  // On mobile the input lives inside a bottom sheet, so there is often very
  // little space below the input but a lot of space above it.  When space
  // below is less than 160 px we flip the dropdown upward so it doesn't
  // disappear under the viewport edge (or behind the software keyboard).
  useLayoutEffect(() => {
    if (isVisible && anchorRef.current) {
      const r = anchorRef.current.getBoundingClientRect();
      const viewportHeight = window.innerHeight;
      const spaceBelow = viewportHeight - r.bottom - 8;
      const spaceAbove = r.top - 8;
      const shouldFlipUp = spaceBelow < 160 && spaceAbove > spaceBelow;

      if (shouldFlipUp) {
        // Anchor the BOTTOM of the dropdown to just above the input.
        // CSS `bottom` for a fixed element = distance from viewport bottom.
        setDropRect({
          top: undefined,
          bottom: viewportHeight - r.top + 6,
          left: r.left,
          width: r.width,
          maxHeight: Math.min(spaceAbove - 8, 320),
        });
      } else {
        setDropRect({
          top: r.bottom + 6,
          bottom: undefined,
          left: r.left,
          width: r.width,
          maxHeight: undefined,
        });
      }
    } else {
      setDropRect(null);
    }
  }, [isVisible, anchorRef]);

  const hasContent = (show && suggestions.length > 0) || showUseLocation;
  if (!hasContent || !dropRect) return null;

  return createPortal(
    <div
      className="search-dropdown-portal"
      style={{
        position: "fixed",
        top: dropRect.top !== undefined ? dropRect.top : "auto",
        bottom: dropRect.bottom !== undefined ? dropRect.bottom : "auto",
        left: dropRect.left,
        width: dropRect.width,
        background: "linear-gradient(160deg, rgba(4, 10, 26, 0.98) 0%, rgba(6, 14, 32, 0.98) 100%)",
        backdropFilter: "blur(26px)",
        WebkitBackdropFilter: "blur(26px)",
        border: "1px solid rgba(0, 190, 255, 0.14)",
        borderRadius: 16,
        zIndex: 99999,
        boxShadow:
          "0 20px 60px rgba(0, 0, 0, 0.75), 0 0 0 1px rgba(255,255,255,0.05), inset 0 1px 0 rgba(0,200,255,0.06)",
        maxHeight: dropRect.maxHeight ? `${dropRect.maxHeight}px` : "min(420px, 60vh)",
        overflowY: "auto",
      }}
    >
      {/* "Use My Current Location" quick shortcut — rendered at the top */}
      {showUseLocation && (
        <div
          // onMouseDown with preventDefault keeps desktop input focused so blur
          // doesn't fire before the selection is registered.
          onMouseDown={(e) => { e.preventDefault(); onUseLocation?.(); }}
          // onTouchEnd handles mobile tap directly — bypasses the 300 ms
          // synthetic-click delay on iOS so the selection fires before the
          // input's 160 ms onBlur timer hides the dropdown.
          onTouchEnd={(e) => { e.preventDefault(); onUseLocation?.(); }}
          style={{
            padding: "11px 14px",
            cursor: "pointer",
            touchAction: "manipulation",
            borderBottom:
              suggestions.length > 0
                ? "1px solid rgba(0,190,255,0.12)"
                : "none",
            display: "flex",
            alignItems: "center",
            gap: 10,
            transition: "all 0.2s ease",
            direction: "rtl",
            background: "rgba(0,190,255,0.06)",
            borderRadius: "16px 16px 0 0",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "rgba(0,200,255,0.14)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "rgba(0,190,255,0.06)";
          }}
        >
          <span
            style={{
              fontSize: 16,
              flexShrink: 0,
              filter: "drop-shadow(0 0 5px rgba(0,210,255,0.60))",
            }}
          >
            📍
          </span>
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontSize: 13,
                fontWeight: 700,
                color: "#00d4ff",
                lineHeight: 1.3,
              }}
            >
              استخدام موقعي الحالي
            </div>
            <div style={{ fontSize: 10, color: "#475569", marginTop: 1 }}>
              Use My Current Location
            </div>
          </div>
        </div>
      )}

      {suggestions.map((s, i) => {
        // TomTom results are address / neighbourhood hits; Foursquare results are POIs.
        // A missing `source` field is treated as a Foursquare POI for backward compat.
        const isTomTom    = s.source === "tomtom";
        const itemIcon    = isTomTom ? "🗺" : "📍";
        const iconColor   = isTomTom ? "#94A3B8" : "#60A5FA";
        const subtitle    = s.neighborhood || s.city || "";

        return (
          <div
            key={i}
            // onMouseDown with preventDefault keeps desktop input focused so blur
            // doesn't fire before the selection is registered.
            onMouseDown={(e) => { e.preventDefault(); onSelect(s); }}
            // onTouchEnd handles mobile tap directly — bypasses the 300 ms
            // synthetic-click delay on iOS so the selection fires before the
            // input's 160 ms onBlur timer hides the dropdown.
            onTouchEnd={(e) => { e.preventDefault(); onSelect(s); }}
            style={{
              padding: "10px 14px",
              cursor: "pointer",
              touchAction: "manipulation",
              borderBottom:
                i < suggestions.length - 1
                  ? "1px solid rgba(255, 255, 255, 0.06)"
                  : "none",
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
              transition: "background 0.15s",
              direction: isRTL ? "rtl" : "ltr",
            }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.background = "rgba(0, 190, 255, 0.12)")
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.background = "transparent")
            }
          >
            <span style={{ fontSize: 14, flexShrink: 0, marginTop: 2, color: iconColor }}>
              {itemIcon}
            </span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: "#E2E8F0",
                    lineHeight: 1.3,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    flex: 1,
                    minWidth: 0,
                  }}
                >
                  {s.name}
                </div>
                {/* Distance from user — shown only when bias coordinates were sent */}
                {s.distance != null && (
                  <span style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: "#38BDF8",
                    flexShrink: 0,
                    letterSpacing: "0.1px",
                    fontVariantNumeric: "tabular-nums",
                  }}>
                    {s.distance < 1000
                      ? `(${s.distance} م)`
                      : `(${(s.distance / 1000).toFixed(1)} كم)`}
                  </span>
                )}
              </div>
              {subtitle && (
                <div style={{ fontSize: 11, color: "#64748B", marginTop: 2 }}>
                  {subtitle}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>,
    document.body
  );
};

// ─── Shared sub-components ────────────────────────────────────────────────────

const TrafficBadge = ({ level }) => {
  const cfg = TRAFFIC_COLOR[level] || TRAFFIC_COLOR.low;
  const { t } = useLanguage();
  const labels = { low: t("low"), medium: t("medium"), high: t("high") };
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "3px 9px",
        borderRadius: 12,
        background: cfg.bg,
        color: cfg.color,
        border: `1px solid ${cfg.color}`,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: "0.5px",
        textTransform: "uppercase",
        whiteSpace: "nowrap",
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: cfg.color,
          flexShrink: 0,
        }}
      />
      {labels[level] || level}
    </span>
  );
};

/**
 * Parses API `confidence` (string "85%", 0–1 fraction, or 1–100 percent) and
 * returns a display value clamped to [85, 98] for "دقة التوقع".
 */
const normalizePredictionAccuracyPercent = (confidence) => {
  if (confidence == null) return null;
  let n =
    typeof confidence === "string"
      ? parseFloat(String(confidence).replace(/%/g, "").trim())
      : Number(confidence);
  if (!Number.isFinite(n)) return null;
  if (n >= 0 && n <= 1) n = Math.round(n * 100);
  else if (n > 1 && n <= 100) n = Math.round(n);
  else {
    while (n > 100) n = Math.round(n / 100);
    n = Math.min(100, Math.max(0, n));
  }
  return Math.min(98, Math.max(85, n));
};

/** Confidence/score progress bar. Accepts "78%" string, 0–1 float, or 1–100 percent. */
const ProgressBar = ({ value, label, color }) => {
  const pct = (() => {
    if (typeof value === "string") {
      return parseInt(String(value).replace(/%/g, "").trim(), 10) || 0;
    }
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    if (n > 1 && n <= 100) return Math.round(n);
    return Math.round(n * 100);
  })();
  const barColor =
    color || (pct >= 75 ? "#22C55E" : pct >= 50 ? "#F59E0B" : "#EF4444");

  return (
    <div>
      {label && (
        <div
          style={{
            fontSize: 11,
            color: "#94A3B8",
            marginBottom: 8,
            lineHeight: 1.35,
          }}
        >
          {label}
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            height: 6,
            background: "rgba(30, 41, 59, 0.9)",
            borderRadius: 4,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${pct}%`,
              background: barColor,
              borderRadius: 4,
              transition: "width 0.5s ease",
              boxShadow: `0 0 10px ${barColor}55`,
            }}
          />
        </div>
        <span
          dir="ltr"
          style={{
            fontSize: 12,
            fontWeight: 800,
            color: barColor,
            flexShrink: 0,
            fontVariantNumeric: "tabular-nums",
            unicodeBidi: "isolate",
            minWidth: "2.5em",
            textAlign: "end",
          }}
        >
          {pct}%
        </span>
      </div>
    </div>
  );
};

/** Circular SVG gauge for the prediction score (0–100). */
const PredictionScoreGauge = ({ score }) => {
  const { t } = useLanguage();
  const pct = Math.min(100, Math.max(0, score ?? 0));
  const color = pct >= 68 ? "#EF4444" : pct >= 36 ? "#F59E0B" : "#22C55E";
  const radius = 26;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (pct / 100) * circumference;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 4,
      }}
    >
      <svg width="68" height="68" viewBox="0 0 68 68">
        <circle
          cx="34"
          cy="34"
          r={radius}
          fill="none"
          stroke="#1E293B"
          strokeWidth="6"
        />
        <circle
          cx="34"
          cy="34"
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth="6"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          transform="rotate(-90 34 34)"
          style={{
            transition: "stroke-dashoffset 0.6s ease, stroke 0.4s",
          }}
        />
        <text
          x="34"
          y="34"
          textAnchor="middle"
          dominantBaseline="central"
          fill={color}
          fontSize="14"
          fontWeight="800"
          fontFamily="'Segoe UI', system-ui, sans-serif"
        >
          {pct}
        </text>
      </svg>
      <span
        style={{
          fontSize: 9,
          color: "#475569",
          textTransform: "uppercase",
          letterSpacing: "0.8px",
          fontWeight: 700,
        }}
      >
        {t("scoreLabel")}
      </span>
    </div>
  );
};

const SectionHeader = ({ titleKey, icon }) => {
  const { t } = useLanguage();
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        marginBottom: 14,
        paddingBottom: 10,
        borderBottom: "1px solid rgba(255, 255, 255, 0.07)",
      }}
    >
      <span style={{ fontSize: 15 }}>{icon}</span>
      <span
        style={{
          fontSize: 10,
          fontWeight: 800,
          color: "#475569",
          letterSpacing: "1.4px",
          textTransform: "uppercase",
        }}
      >
        {t(titleKey)}
      </span>
    </div>
  );
};

const StatCard = ({ value, unitKey }) => {
  const { t } = useLanguage();
  return (
    <div
      style={{
        padding: "12px 14px",
        background: "rgba(2, 8, 23, 0.65)",
        borderRadius: 12,
        textAlign: "center",
        border: "1px solid rgba(255, 255, 255, 0.06)",
      }}
    >
      <div
        style={{
          fontSize: 24,
          fontWeight: 800,
          color: "#F1F5F9",
          lineHeight: 1,
        }}
      >
        {value}
      </div>
      <div
        style={{
          fontSize: 10,
          color: "#64748B",
          marginTop: 5,
          textTransform: "uppercase",
          letterSpacing: "0.6px",
          fontWeight: 600,
        }}
      >
        {t(unitKey)}
      </div>
    </div>
  );
};

/**
 * Compact departure advice row shown inside the sidebar prediction card.
 * Always visible when a prediction exists — works without a destination.
 */
const DepartureSuggestion = ({ level, t }) => {
  const isHigh   = level === "high";
  const isLow    = level === "low";
  const color    = isLow ? "#22C55E" : isHigh ? "#F97316" : "#F59E0B";
  const bg       = isLow ? "rgba(5, 46, 22, 0.55)" : isHigh ? "rgba(69, 26, 3, 0.55)" : "rgba(54, 40, 3, 0.55)";
  const border   = isLow ? "rgba(34, 197, 94, 0.35)" : isHigh ? "rgba(249, 115, 22, 0.35)" : "rgba(245, 158, 11, 0.35)";
  const icon     = isLow ? "✅" : isHigh ? "🚦" : "🕐";

  const titleKey = isLow ? "departureLowTitle" : isHigh ? "departureHighTitle" : "departureMediumTitle";
  const adviceText = isLow
    ? t("departureLowMsg")
    : isHigh
    ? t("departureHighMsg").replace("{min}", "20–30").replace("{max}", "40")
    : t("departureMediumMsg").replace("{min}", "10").replace("{max}", "20");

  return (
    <div
      style={{
        padding: "10px 12px",
        background: bg,
        border: `1px solid ${border}`,
        borderLeft: `3px solid ${color}`,
        borderRadius: 10,
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
      }}
    >
      <span style={{ fontSize: 16, flexShrink: 0, lineHeight: 1.4 }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color, marginBottom: 3 }}>
          {t(titleKey)}
        </div>
        <div style={{ fontSize: 11, color: "#94A3B8", lineHeight: 1.5 }}>
          {adviceText}
        </div>
      </div>
    </div>
  );
};

/** Expanded smart-departure breakdown — lives in the sidebar (no map overlay). */
const SmartDepartureDetailPanel = ({ recommendation, onDismiss, t }) => {
  const isHigh = recommendation.level === "high";
  const isLow = recommendation.level === "low";
  const borderColor = isLow ? "#22C55E" : isHigh ? "#F97316" : "#F59E0B";
  const accentColor = isLow ? "#BBF7D0" : isHigh ? "#FED7AA" : "#FEF3C7";
  const levelLabel = isLow ? t("low") : isHigh ? t("high") : t("medium");
  const waitMsg = isLow
    ? t("leaveNow")
    : t("leaveAfterMinutes").replace("{min}", recommendation.minWait);

  return (
    <div
      style={{
        marginTop: 12,
        padding: "14px 14px",
        background: "rgba(8, 15, 26, 0.78)",
        backdropFilter: "blur(14px)",
        WebkitBackdropFilter: "blur(14px)",
        borderRadius: 14,
        border: `1px solid ${borderColor}40`,
        borderInlineStart: `3px solid ${borderColor}`,
        boxShadow: `0 8px 28px rgba(0,0,0,0.35), 0 0 24px ${borderColor}18`,
        color: accentColor,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          marginBottom: 12,
        }}
      >
        <div
          style={{
            fontSize: 9,
            fontWeight: 800,
            color: borderColor,
            textTransform: "uppercase",
            letterSpacing: "1px",
          }}
        >
          🕐 {t("smartDeparturePanelTitle")}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t("departureDismiss")}
          style={{
            background: "transparent",
            border: "none",
            color: "#475569",
            cursor: "pointer",
            fontSize: 20,
            padding: 0,
            lineHeight: 1,
            flexShrink: 0,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = accentColor;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "#475569";
          }}
        >
          ×
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "10px 12px",
            background: "rgba(0,0,0,0.22)",
            borderRadius: 10,
            border: `1px solid ${borderColor}22`,
            gap: 10,
          }}
        >
          <span style={{ fontSize: 12, color: "#94A3B8" }}>{t("congestionLevel")}</span>
          <span
            style={{
              fontSize: 12,
              fontWeight: 800,
              color: borderColor,
              display: "flex",
              alignItems: "center",
              gap: 6,
              flexShrink: 0,
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: borderColor,
                boxShadow: `0 0 8px ${borderColor}`,
              }}
            />
            {levelLabel}
          </span>
        </div>

        <div
          style={{
            padding: "10px 12px",
            background: "rgba(0,0,0,0.22)",
            borderRadius: 10,
            border: `1px solid ${borderColor}22`,
          }}
        >
          <div
            style={{
              fontSize: 10,
              color: "#64748B",
              marginBottom: 5,
              textTransform: "uppercase",
              letterSpacing: "0.7px",
            }}
          >
            {t("departureRecommendationLabel")}
          </div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#FFFFFF", lineHeight: 1.5 }}>
            {waitMsg}
          </div>
        </div>

        <div
          style={{
            padding: "10px 12px",
            background: "rgba(0,0,0,0.22)",
            borderRadius: 10,
            border: `1px solid ${borderColor}22`,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: "50%",
                border: `3px solid ${borderColor}`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
                boxShadow: `0 0 14px ${borderColor}44`,
              }}
            >
              <span
                dir="ltr"
                style={{
                  fontSize: 14,
                  fontWeight: 900,
                  color: borderColor,
                  fontVariantNumeric: "tabular-nums",
                  unicodeBidi: "isolate",
                  lineHeight: 1,
                }}
              >
                {recommendation.confidence}%
              </span>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, color: "#94A3B8", lineHeight: 1.5, wordBreak: "break-word" }}>
                {t("predictionConfidence")}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// Maps backend route labels (English) to translation keys and display icons.
const ROUTE_LABEL_MAP = {
  "Recommended": { key: "routeLabelRecommended", icon: "🚀" },
  "Least Traffic": { key: "routeLabelLeastTraffic", icon: "🌿" },
  "Shortest": { key: "routeLabelShortest", icon: "📏" },
  "Alternative": { key: "routeLabelAlternative", icon: "🔀" },
};

/** Whole-trip average and range from TomTom summary.lengthInMeters & travelTimeInSeconds (traffic-aware). */
const computeTripSpeedRange = (lengthMeters, travelTimeSeconds) => {
  if (
    typeof lengthMeters !== "number" ||
    typeof travelTimeSeconds !== "number" ||
    lengthMeters <= 0 ||
    travelTimeSeconds <= 0
  ) {
    return null;
  }
  const avgKmh = (lengthMeters / 1000) / (travelTimeSeconds / 3600);
  const minSpeed = Math.max(10, Math.round(avgKmh - 10));
  const maxSpeed = Math.round(avgKmh + 15);
  return { avgKmh, minSpeed, maxSpeed };
};

const tripSpeedVisualForAvg = (avgKmh) => {
  if (avgKmh < 40) return { color: "#EF4444", icon: "🔴" };
  if (avgKmh <= 80) return { color: "#F97316", icon: "🟠" };
  return { color: "#22C55E", icon: "🟢" };
};

const RouteOptionRow = ({ route, isActive, onSelect, closureAvoided = false }) => {
  const { t, isRTL } = useLanguage();

  const labelMeta = ROUTE_LABEL_MAP[route.label] || {
    key: "routeLabelAlternative",
    icon: "🛣",
  };
  const displayLabel = t(labelMeta.key);

  const activeBgColor =
    route.color === "#3B82F6"
      ? "rgba(37, 99, 235, 0.15)"
      : route.color === "#22C55E"
      ? "rgba(34, 197, 94, 0.15)"
      : "rgba(100, 116, 139, 0.15)";

  // Estimate ETA based on travel time
  const etaDate = new Date(Date.now() + (route.travelTime || 0) * 60 * 1000);
  const etaStr = etaDate.toLocaleTimeString(isRTL ? "ar-SA" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });

  const tripSpeed =
    route.source === "tomtom"
      ? computeTripSpeedRange(route.lengthInMeters, route.travelTimeInSeconds)
      : null;
  const speedStyle = tripSpeed ? tripSpeedVisualForAvg(tripSpeed.avgKmh) : null;

  return (
    <div
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && onSelect()}
      className="route-option-row"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "11px 13px",
        background: isActive ? activeBgColor : "rgba(2, 8, 23, 0.55)",
        borderRadius: 12,
        border: isActive
          ? `1px solid ${route.color}55`
          : "1px solid rgba(255, 255, 255, 0.06)",
        cursor: "pointer",
        marginBottom: 6,
        outline: "none",
      }}
      onMouseEnter={(e) => {
        if (!isActive) {
          e.currentTarget.style.background = "rgba(37, 99, 235, 0.10)";
          e.currentTarget.style.borderColor = `${route.color}44`;
        }
      }}
      onMouseLeave={(e) => {
        if (!isActive) {
          e.currentTarget.style.background = "rgba(2, 8, 23, 0.55)";
          e.currentTarget.style.borderColor = "rgba(255, 255, 255, 0.06)";
        }
      }}
    >
      {/* Color indicator dot with route icon */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, flexShrink: 0 }}>
        <span style={{ fontSize: 14, lineHeight: 1 }}>{labelMeta.icon}</span>
        <div
          style={{
            width: 3,
            height: 24,
            background: route.color,
            borderRadius: 2,
            boxShadow: `0 0 6px ${route.color}88`,
          }}
        />
      </div>

      {/* Label + stats */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: "#E2E8F0" }}>
            {displayLabel}
          </span>
          {route.isRecommended && (
            <span
              style={{
                fontSize: 9,
                background: "#1D4ED8",
                color: "#BFDBFE",
                padding: "2px 6px",
                borderRadius: 4,
                fontWeight: 700,
                letterSpacing: "0.5px",
                textTransform: "uppercase",
              }}
            >
              {t("best")}
            </span>
          )}
        </div>

        <div style={{ display: "flex", gap: 8, fontSize: 11, color: "#64748B", flexWrap: "wrap" }}>
          <span>🕒 {route.travelTime} {t("min")}</span>
          <span>📍 {route.distance} {t("km")}</span>
          {route.trafficDelay > 0 && (
            <span style={{ color: "#F97316" }}>
              +{route.trafficDelay}{t("min")} {t("delay")}
            </span>
          )}
        </div>

        {tripSpeed && speedStyle && (
          <div
            title={t("expectedSpeedTooltip")}
            style={{
              marginTop: 5,
              fontSize: 11,
              fontWeight: 600,
              color: speedStyle.color,
              display: "flex",
              alignItems: "center",
              gap: 6,
              lineHeight: 1.35,
              cursor: "help",
              direction: isRTL ? "rtl" : "ltr",
            }}
          >
            <span style={{ fontSize: 13, lineHeight: 1, flexShrink: 0 }} aria-hidden>
              {speedStyle.icon}
            </span>
            <span>
              {t("expectedSpeedRangeLine")
                .replace("{min}", String(tripSpeed.minSpeed))
                .replace("{max}", String(tripSpeed.maxSpeed))}
            </span>
          </div>
        )}

        {/* ETA row */}
        <div style={{ fontSize: 10, color: "#475569", marginTop: 2 }}>
          {t("routeETA")}: {etaStr}
        </div>

        {/* Road closure avoidance badge */}
        {closureAvoided && (
          <div
            style={{
              marginTop: 6,
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              fontSize: 10,
              fontWeight: 700,
              color: "#86EFAC",
              background: "rgba(21, 128, 61, 0.18)",
              border: "1px solid rgba(34, 197, 94, 0.28)",
              borderRadius: 6,
              padding: "2px 7px",
              letterSpacing: "0.15px",
              lineHeight: 1.6,
            }}
          >
            🚧 تم تجنب إغلاق مروري في المسار
          </div>
        )}
      </div>

      <TrafficBadge level={route.trafficLevel} />
    </div>
  );
};

// ─── Metro Suggestion Card ────────────────────────────────────────────────────

const MetroSuggestionCard = ({
  metro,
  routeVisible,
  onToggleRoute,
  onDismiss,
  isRTL,
  t,
}) => {
  const originName = isRTL ? metro.originStation.nameAr : metro.originStation.nameEn;
  const destName = isRTL ? metro.destStation.nameAr : metro.destStation.nameEn;
  const lineName = isRTL ? metro.metroLine.nameAr : metro.metroLine.nameEn;
  const transferName = metro.transferStation
    ? isRTL ? metro.transferStation.nameAr : metro.transferStation.nameEn
    : null;
  const lineColor = metro.metroLine.color;

  const steps = [
    {
      icon: "🚗",
      label: t("metroDriveToStation").replace("{station}", originName),
      detail: t("metroDriveMin").replace("{min}", metro.driveToStationMin),
      color: "#0EA5E9",
    },
    ...(metro.originStation.parkAndRide
      ? [{ icon: "🅿️", label: t("metroParkAndRide"), detail: "", color: "#64748B" }]
      : []),
    {
      icon: "🚇",
      label: t("metroRide").replace("{line}", lineName).replace("{station}", destName),
      detail: t("metroRideMin").replace("{min}", metro.metroTravelMin),
      color: lineColor,
    },
    ...(transferName
      ? [{
          icon: "🔄",
          label: t("metroTransferAt").replace("{station}", transferName),
          detail: "",
          color: "#F59E0B",
        }]
      : []),
    {
      icon: "🚗",
      label: t("metroDriveToDestination"),
      detail: t("metroDriveMin").replace("{min}", metro.driveFromStationMin),
      color: "#0EA5E9",
    },
  ];

  return (
    <div
      style={{
        background: "rgba(30, 41, 59, 0.50)",
        borderRadius: 14,
        padding: 14,
        border: `1px solid ${lineColor}33`,
        borderTop: `3px solid ${lineColor}`,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 12,
          paddingBottom: 10,
          borderBottom: "1px solid rgba(255, 255, 255, 0.07)",
        }}
      >
        <span style={{ fontSize: 18 }}>🚇</span>
        <div style={{ flex: 1 }}>
          <div
            style={{
              fontSize: 10,
              fontWeight: 800,
              color: lineColor,
              letterSpacing: "1.2px",
              textTransform: "uppercase",
            }}
          >
            {t("metroSuggestionTitle")}
          </div>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#E2E8F0", marginTop: 2 }}>
            {t("metroFasterOption")}
          </div>
        </div>
        <button
          onClick={onDismiss}
          aria-label={t("metroDismiss")}
          style={{
            background: "transparent",
            border: "none",
            color: "#475569",
            cursor: "pointer",
            fontSize: 18,
            padding: 0,
            lineHeight: 1,
            flexShrink: 0,
            transition: "color 0.2s",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "#CBD5E1")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "#475569")}
        >
          ×
        </button>
      </div>

      {/* Traffic warning */}
      <div
        style={{
          padding: "8px 10px",
          background: "rgba(69, 26, 3, 0.50)",
          border: "1px solid rgba(249, 115, 22, 0.30)",
          borderRadius: 8,
          fontSize: 11,
          color: "#FED7AA",
          marginBottom: 12,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <span style={{ fontSize: 13 }}>⚠️</span>
        {t("metroTrafficHeavy")}
      </div>

      {/* Step-by-step journey */}
      <div style={{ display: "flex", flexDirection: "column", gap: 0, marginBottom: 12 }}>
        {steps.map((step, idx) => (
          <div key={idx} style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
            {/* Vertical line connector */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                width: 20,
                flexShrink: 0,
              }}
            >
              <div
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: "50%",
                  background: `${step.color}20`,
                  border: `2px solid ${step.color}`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 11,
                  flexShrink: 0,
                }}
              >
                {step.icon}
              </div>
              {idx < steps.length - 1 && (
                <div
                  style={{
                    width: 2,
                    height: 16,
                    background: "rgba(255, 255, 255, 0.10)",
                    margin: "2px 0",
                  }}
                />
              )}
            </div>
            {/* Step text */}
            <div style={{ paddingTop: 2, paddingBottom: idx < steps.length - 1 ? 6 : 0 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "#CBD5E1", lineHeight: 1.3 }}>
                {step.label}
              </div>
              {step.detail && (
                <div style={{ fontSize: 10, color: "#64748B", marginTop: 1 }}>
                  {step.detail}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Time comparison */}
      <div
        style={{
          display: "flex",
          gap: 8,
          marginBottom: 12,
        }}
      >
        <div
          style={{
            flex: 1,
            padding: "10px 10px",
            background: "rgba(5, 46, 22, 0.55)",
            border: "1px solid rgba(34, 197, 94, 0.30)",
            borderRadius: 10,
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: 20, fontWeight: 800, color: "#22C55E", lineHeight: 1 }}>
            {metro.totalTimeMin}
          </div>
          <div style={{ fontSize: 9, color: "#4ADE80", marginTop: 4, textTransform: "uppercase", letterSpacing: "0.5px" }}>
            {t("min")} (Metro)
          </div>
        </div>
        <div
          style={{
            flex: 1,
            padding: "10px 10px",
            background: "rgba(69, 10, 10, 0.40)",
            border: "1px solid rgba(239, 68, 68, 0.25)",
            borderRadius: 10,
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: 20, fontWeight: 800, color: "#EF4444", lineHeight: 1, textDecoration: "line-through", textDecorationThickness: 2 }}>
            {metro.drivingTimeMin}
          </div>
          <div style={{ fontSize: 9, color: "#FCA5A5", marginTop: 4, textTransform: "uppercase", letterSpacing: "0.5px" }}>
            {t("min")} ({t("delay")})
          </div>
        </div>
      </div>

      {/* Time saved badge */}
      <div
        style={{
          padding: "8px 12px",
          background: "rgba(5, 46, 22, 0.70)",
          border: "1px solid rgba(34, 197, 94, 0.40)",
          borderRadius: 10,
          textAlign: "center",
          marginBottom: 10,
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 800, color: "#22C55E" }}>
          ⏱ {t("metroTimeSaved").replace("{min}", metro.timeSavedMin)}
        </span>
      </div>

      {/* Show on map toggle */}
      <button
        onClick={onToggleRoute}
        style={{
          width: "100%",
          padding: "11px 14px",
          background: routeVisible
            ? `linear-gradient(135deg, ${lineColor}25, ${lineColor}15)`
            : "linear-gradient(135deg, rgba(17, 24, 39, 0.85), rgba(30, 41, 59, 0.85))",
          border: routeVisible
            ? `1px solid ${lineColor}66`
            : `1px solid ${lineColor}30`,
          borderRadius: 12,
          color: routeVisible ? lineColor : "#94A3B8",
          cursor: "pointer",
          fontWeight: 700,
          fontSize: 12,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 7,
          transition: "all 0.2s ease",
          fontFamily: "inherit",
        }}
        onMouseEnter={(e) => {
          if (!routeVisible) {
            e.currentTarget.style.borderColor = `${lineColor}55`;
            e.currentTarget.style.color = lineColor;
          }
        }}
        onMouseLeave={(e) => {
          if (!routeVisible) {
            e.currentTarget.style.borderColor = `${lineColor}30`;
            e.currentTarget.style.color = "#94A3B8";
          }
        }}
      >
        <span style={{ fontSize: 15 }}>🗺</span>
        {routeVisible ? t("metroHideRoute") : t("metroShowRoute")}
      </button>
    </div>
  );
};

// ─── Smart Analytics constants ────────────────────────────────────────────────

const FUEL_PRICE_SAR = 2.33;
const FUEL_LITERS_PER_100KM = 8;
const METRO_TICKET_SAR = 4;

// Destinations where parking intelligence is relevant (POI / venues — not generic streets).
const PARKING_DESTINATION_KEYWORDS_AR = [
  "مول",
  "مجمع",
  "بارك",
  "ملعب",
  "ستاد",
  "بوليفارد",
  "جامعة",
  "مستشفى",
  "سوق",
];
const PARKING_DESTINATION_KEYWORDS_EN = [
  "mall",
  "stadium",
  "park",
  "hospital",
  "university",
  "arena",
  "center",
  "centre",
];

const destinationShowsParkingAvailabilityUi = (destinationText) => {
  const text = (destinationText || "").trim();
  if (!text) return false;
  if (PARKING_DESTINATION_KEYWORDS_AR.some((kw) => text.includes(kw))) return true;
  const lower = text.toLowerCase();
  return PARKING_DESTINATION_KEYWORDS_EN.some((kw) => lower.includes(kw));
};

/** Returns estimated fuel cost in SAR, including a traffic-delay penalty. */
const computeFuelCost = (distanceKm, trafficDelayMin) => {
  const baseCost = (distanceKm / 100) * FUEL_LITERS_PER_100KM * FUEL_PRICE_SAR;
  const penaltyMultiplier =
    trafficDelayMin > 10 ? 1.15 :
    trafficDelayMin > 5  ? 1.08 :
    1.0;
  return baseCost * penaltyMultiplier;
};

/**
 * Returns an on-time arrival confidence percentage (0–100).
 * Derived from the ratio of traffic delay to total travel time:
 *   - high delay ratio (> 30%): 65 %
 *   - moderate (> 15%): 72 %
 *   - slight (> 8%): 82 %
 *   - minimal: 94 %
 */
const computeArrivalGuarantee = (travelTimeMin, trafficDelayMin) => {
  if (!travelTimeMin || travelTimeMin <= 0) return 90;
  const delayRatio = (trafficDelayMin || 0) / travelTimeMin;
  if (delayRatio > 0.30) return 65;
  if (delayRatio > 0.15) return 72;
  if (delayRatio > 0.08) return 82;
  return 94;
};

/**
 * Derives a deterministic parking status from the destination text so that
 * the value is stable across re-renders but changes when the destination changes.
 * Returns "crowded" | "moderate" | "available".
 */
/**
 * Only called when `destinationShowsParkingAvailabilityUi` is true.
 * Deterministic parking crowding hint from destination text.
 */
const deriveStableParkingStatus = (destinationText) => {
  const text = (destinationText || "").trim();
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) & 0xffffffff;
  }
  const bucket = Math.abs(hash) % 100;
  if (bucket < 50) return "crowded";
  if (bucket < 75) return "moderate";
  return "available";
};

// ─── SmartAnalyticsCard component ────────────────────────────────────────────

const SmartAnalyticsCard = ({ recommendedRoute, destinationText }) => {
  const distanceKm       = parseFloat(recommendedRoute?.distance)    || 0;
  const travelTimeMin    = recommendedRoute?.travelTime               || 0;
  const trafficDelayMin  = recommendedRoute?.trafficDelay             || 0;

  const fuelCost         = computeFuelCost(distanceKm, trafficDelayMin);
  const arrivalGuarantee = computeArrivalGuarantee(travelTimeMin, trafficDelayMin);
  const showParkingUi    = destinationShowsParkingAvailabilityUi(destinationText);
  const parkingStatus    = showParkingUi ? deriveStableParkingStatus(destinationText) : null;

  const guaranteeColor =
    arrivalGuarantee >= 90 ? "#22C55E" :
    arrivalGuarantee >= 75 ? "#F59E0B" :
    "#EF4444";

  const innerCell = {
    padding: "10px 12px",
    background: "rgba(2, 8, 23, 0.65)",
    borderRadius: 10,
    border: "1px solid rgba(255, 255, 255, 0.07)",
  };

  return (
    <div
      style={{
        background: "rgba(30, 41, 59, 0.50)",
        borderRadius: 14,
        padding: "14px",
        border: "1px solid rgba(255, 255, 255, 0.07)",
      }}
    >
      {/* ── Card header ── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 14,
          paddingBottom: 10,
          borderBottom: "1px solid rgba(255, 255, 255, 0.06)",
        }}
      >
        <span style={{ fontSize: 15 }}>🧠</span>
        <span
          style={{
            fontSize: 12,
            fontWeight: 700,
            color: "#CBD5E1",
            letterSpacing: "0.3px",
          }}
        >
          التحليلات الذكية
        </span>
      </div>

      {/* ── Feature 1: Real Cost Routing ── */}
      <div style={{ marginBottom: 12 }}>
        <div
          style={{
            fontSize: 10,
            color: "#64748B",
            fontWeight: 700,
            letterSpacing: "0.8px",
            textTransform: "uppercase",
            marginBottom: 8,
          }}
        >
          💰 التكلفة التقديرية
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7 }}>
          {/* Fuel cost cell */}
          <div
            style={{
              ...innerCell,
              borderColor: "rgba(245, 158, 11, 0.28)",
              background: "rgba(66, 32, 6, 0.50)",
            }}
          >
            <div style={{ fontSize: 11, color: "#94A3B8", marginBottom: 4 }}>
              🚗 بنزين
            </div>
            <div
              style={{
                fontSize: 19,
                fontWeight: 800,
                color: "#FCD34D",
                lineHeight: 1,
              }}
            >
              {fuelCost.toFixed(2)}
            </div>
            <div style={{ fontSize: 9, color: "#92400E", marginTop: 3 }}>
              ريال سعودي
            </div>
          </div>

          {/* Metro cost cell */}
          <div
            style={{
              ...innerCell,
              borderColor: "rgba(99, 102, 241, 0.28)",
              background: "rgba(30, 27, 75, 0.50)",
            }}
          >
            <div style={{ fontSize: 11, color: "#94A3B8", marginBottom: 4 }}>
              🚇 مترو
            </div>
            <div
              style={{
                fontSize: 19,
                fontWeight: 800,
                color: "#A5B4FC",
                lineHeight: 1,
              }}
            >
              {METRO_TICKET_SAR}
            </div>
            <div style={{ fontSize: 9, color: "#4338CA", marginTop: 3 }}>
              ريال سعودي
            </div>
          </div>
        </div>
      </div>

      {/* ── Feature 2: Arrival Guarantee ── */}
      <div style={{ marginBottom: 12 }}>
        <div
          style={{
            ...innerCell,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderColor: `${guaranteeColor}28`,
            background: `${guaranteeColor}0D`,
          }}
        >
          <span style={{ fontSize: 12, color: "#CBD5E1" }}>
            🎯 ضمان الوصول على الوقت
          </span>
          <span
            style={{
              fontSize: 17,
              fontWeight: 800,
              color: guaranteeColor,
              flexShrink: 0,
              marginRight: 2,
            }}
          >
            {arrivalGuarantee}%
          </span>
        </div>
        {/* Thin progress fill bar */}
        <div
          style={{
            height: 3,
            background: "rgba(255, 255, 255, 0.06)",
            borderRadius: 99,
            marginTop: 6,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${arrivalGuarantee}%`,
              background: `linear-gradient(90deg, ${guaranteeColor}77, ${guaranteeColor})`,
              borderRadius: 99,
              transition: "width 0.6s ease",
            }}
          />
        </div>
      </div>

      {/* ── Feature 3: Parking Intelligence (POI destinations only) ── */}
      {showParkingUi && parkingStatus && (
        <div>
          <div
            style={{
              fontSize: 10,
              color: "#64748B",
              fontWeight: 700,
              letterSpacing: "0.8px",
              textTransform: "uppercase",
              marginBottom: 8,
            }}
          >
            🅿️ المواقف الذكية
          </div>

          {parkingStatus === "crowded" ? (
            <div
              style={{
                ...innerCell,
                borderColor: "rgba(239, 68, 68, 0.38)",
                background: "rgba(69, 10, 10, 0.55)",
              }}
            >
              <div style={{ fontSize: 12, color: "#FCA5A5", marginBottom: 5 }}>
                🅿️ المواقف الرئيسية: مزدحمة 🔴
              </div>
              <div style={{ fontSize: 11, color: "#86EFAC" }}>
                💡 نقترح: المواقف الجنوبية (تبعد 200م) 🟢
              </div>
            </div>
          ) : parkingStatus === "moderate" ? (
            <div
              style={{
                ...innerCell,
                borderColor: "rgba(245, 158, 11, 0.38)",
                background: "rgba(66, 32, 6, 0.45)",
              }}
            >
              <div style={{ fontSize: 12, color: "#FCD34D" }}>
                🅿️ المواقف متوسطة الازدحام 🟡
              </div>
              <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 4 }}>
                💡 يُفضَّل الوصول مبكراً لتفادي الازدحام
              </div>
            </div>
          ) : (
            <div
              style={{
                ...innerCell,
                borderColor: "rgba(34, 197, 94, 0.30)",
                background: "rgba(5, 46, 22, 0.45)",
              }}
            >
              <div style={{ fontSize: 12, color: "#86EFAC" }}>
                🅿️ المواقف متوفرة عند الوجهة 🟢
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ─── Viewport breakpoint hook ─────────────────────────────────────────────────
/**
 * Tracks whether the viewport is at or below the mobile breakpoint (768px).
 *
 * Why this lives here:
 *   The destination card (FROM / TO inputs) MUST render at the document root
 *   on mobile, because the `.floating-sidebar` bottom-sheet ancestor applies
 *   `transform: translateY(...)` for its slide animation.  Per CSS spec, any
 *   ancestor with a non-`none` transform becomes the containing block for
 *   `position: fixed` descendants — so a fixed-positioned input panel inside
 *   the sheet would anchor to the sheet, not the viewport, and end up
 *   floating over the bottom-sheet content (the exact bug we are fixing).
 *
 *   This hook lets the Sidebar conditionally portal the destination card to
 *   `document.body` only when needed, while preserving the React subtree
 *   (state, refs, handlers all keep working — only the DOM moves).
 *
 * SSR-safe: guards `window` access during the initial render.
 */
const MOBILE_BREAKPOINT_PX = 768;

const useIsMobile = () => {
  const getMatch = () => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX}px)`).matches;
  };

  const [isMobile, setIsMobile] = useState(getMatch);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return undefined;

    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX}px)`);
    const handleChange = (event) => setIsMobile(event.matches);

    // Sync once on mount in case the initial value drifted between SSR and
    // the first client paint.
    setIsMobile(mql.matches);

    // Older Safari (< 14) only supports `addListener`/`removeListener`.
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", handleChange);
      return () => mql.removeEventListener("change", handleChange);
    }
    mql.addListener(handleChange);
    return () => mql.removeListener(handleChange);
  }, []);

  return isMobile;
};

// ─── Main Sidebar component ───────────────────────────────────────────────────

const Sidebar = ({
  isMobileOpen = true,
  onMobileToggle,
  userLocation,
  mapCenter,
  startCoords,
  onStartCoordsChange,
  endCoords,
  onEndCoordsChange,
  onMapFocus,
  clickMode,
  onClickModeChange,
  destinationText,
  onDestinationTextChange,
  recommendedRoute,
  allRoutes,
  activeRouteIndex,
  onRouteSelect,
  routeLoading,
  routeError,
  onRecommendRoute,
  onClearRoute,
  // Mobile unified bottom-sheet: the sidebar owns the start/exit navigation
  // CTA on small screens so the duplicate NavigationControls dock can be
  // hidden, eliminating the overlapping floating-panel layout reported
  // in the mobile UI overhaul.  These props are passed from TrafficMap.
  isNavigating = false,
  onStartNavigation,
  onExitNavigation,
  incidents,
  incidentsOnRoute,
  closureAvoidedPerRoute,
  prediction,
  predictionLoading,
  lastUpdated,
  error,
  // Feature 1
  onRequestSmartDeparture,
  onCloseSmartDeparturePanel,
  smartDeparturePanelVisible,
  departureRecommendation,
  // Feature 4
  simulationActive,
  onSimulateTraffic,
  onStopSimulation,
  // Feature 5: Smart Metro Alternative
  metroAlternative,
  metroDismissed,
  metroRouteVisible,
  onMetroDismiss,
  onMetroToggleRoute,
  metroBannerFading = false,
  // Backend connectivity
  backendOnline,
  onRetryConnection,
  // Meeting Point feature
  onMeetingPointResult,
  onMeetingParticipantsChange,
}) => {
  const { t, isRTL } = useLanguage();

  const SIDEBAR_ALERT_DISMISS_MS = 12000;
  const SIDEBAR_ALERT_FADE_MS = 400;

  const [smartDetailFading, setSmartDetailFading] = useState(false);

  // ── API error toast ────────────────────────────────────────────────────────
  // Shown whenever /api/search-places returns 429 / 5xx or a network/CORS
  // error.  Auto-dismisses after 5 s so the user isn't blocked indefinitely.
  const [apiErrorToastVisible, setApiErrorToastVisible] = useState(false);
  const apiErrorToastTimerRef = useRef(null);
  const showApiErrorToast = useCallback(() => {
    clearTimeout(apiErrorToastTimerRef.current);
    setApiErrorToastVisible(true);
    apiErrorToastTimerRef.current = setTimeout(
      () => setApiErrorToastVisible(false),
      5000
    );
  }, []);
  // Cleanup on unmount.
  useEffect(() => () => clearTimeout(apiErrorToastTimerRef.current), []);

  // Show the server-pressure toast whenever a route request fails with a
  // server/timeout error.  SERVER_PRESSURE_MESSAGE is set by RouteEngine.js
  // when the backend returns 5xx or the request times out.
  useEffect(() => {
    if (routeError === SERVER_PRESSURE_MESSAGE) {
      showApiErrorToast();
    }
  }, [routeError, showApiErrorToast]);

  // ── Validation toast ───────────────────────────────────────────────────────
  // Fired when the user taps "اقترح الطريق" without a destination set.
  // Appears as a floating blue pill (same slot as the server-error toast so
  // both messages never fight for screen space) and auto-dismisses after 4 s.
  const [validationToastMsg, setValidationToastMsg] = useState(null);
  const validationToastTimerRef = useRef(null);
  const showValidationToast = useCallback((msg) => {
    clearTimeout(validationToastTimerRef.current);
    setValidationToastMsg(msg);
    validationToastTimerRef.current = setTimeout(
      () => setValidationToastMsg(null),
      4000
    );
  }, []);
  useEffect(() => () => clearTimeout(validationToastTimerRef.current), []);

  // ── Suggest-route click handler ───────────────────────────────────────────
  const handleSuggestRouteClick = useCallback(() => {
    try {
      const hasDestination = endCoords != null || destinationText?.trim().length > 0;
      const hasStart       = startCoords != null || userLocation != null;

      if (!hasDestination) {
        showValidationToast("الرجاء تحديد الوجهة أولاً");
        return;
      }
      if (!hasStart) {
        showValidationToast("يرجى تفعيل تحديد الموقع أو تحديد نقطة البداية");
        return;
      }

      onRecommendRoute?.();
    } catch (err) {
      console.error("[suggest-route] unexpected error:", err);
    }
  }, [
    endCoords,
    destinationText,
    startCoords,
    userLocation,
    onRecommendRoute,
    showValidationToast,
  ]);

  useEffect(() => {
    if (!smartDeparturePanelVisible || !onCloseSmartDeparturePanel) {
      setSmartDetailFading(false);
      return undefined;
    }
    setSmartDetailFading(false);
    const fadeStart = Math.max(0, SIDEBAR_ALERT_DISMISS_MS - SIDEBAR_ALERT_FADE_MS);
    const fadeTimer = setTimeout(() => setSmartDetailFading(true), fadeStart);
    const closeTimer = setTimeout(() => {
      onCloseSmartDeparturePanel();
      setSmartDetailFading(false);
    }, SIDEBAR_ALERT_DISMISS_MS);
    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(closeTimer);
    };
  }, [smartDeparturePanelVisible, onCloseSmartDeparturePanel]);

  // Resolve the best available bias point: prefer the map's current center
  // (where the user is looking) over their GPS location, and fall back to null
  // so the backend uses Riyadh city center as the default.
  const searchBiasLat = mapCenter?.[0] ?? userLocation?.[0] ?? null;
  const searchBiasLon = mapCenter?.[1] ?? userLocation?.[1] ?? null;

  // ── Viewport breakpoint ────────────────────────────────────────────────────
  // Drives DOM-level placement of the destination card (FROM / TO inputs).
  // On mobile we portal the card to `document.body` so its `position: fixed`
  // styles anchor to the viewport instead of the transformed bottom-sheet
  // ancestor — see `useIsMobile` jsdoc for the underlying CSS-spec rationale.
  const isMobile = useIsMobile();

  // ── Active sidebar tab ─────────────────────────────────────────────────────
  // "main" shows the navigation panel; "meeting" shows the meeting-point finder.
  const [activeTab, setActiveTab] = useState("main");

  // ── From field state ───────────────────────────────────────────────────────
  const [fromText, setFromText] = useState("");
  const [fromSuggestions, setFromSuggestions] = useState([]);
  const [showFromSuggestions, setShowFromSuggestions] = useState(false);
  const [fromFieldFocused, setFromFieldFocused] = useState(false);
  const [fromSearchLoading, setFromSearchLoading] = useState(false);
  const [fromLocating, setFromLocating] = useState(false);
  const fromDebounceRef = useRef(null);
  // Holds the AbortController for the currently in-flight "From" search request.
  // Cancelled immediately when a new keystroke triggers a fresh request.
  const fromAbortRef = useRef(null);

  // ── Meeting Point state ────────────────────────────────────────────────────
  // Each participant slot: { text, coords, suggestions, showSugg, loading, focused }
  const makeEmptyParticipant = () => ({
    text: "", coords: null, suggestions: [], showSugg: false, loading: false, focused: false,
  });

  const [participants, setParticipants] = useState([
    makeEmptyParticipant(),
    makeEmptyParticipant(),
  ]);

  // Propagate resolved participant locations to the map so it can render a
  // colored origin pin for each confirmed participant (mirrors Navigation pins).
  useEffect(() => {
    const resolvedPins = participants
      .map((p, idx) =>
        p.coords ? { lat: p.coords.lat, lon: p.coords.lon, color: PARTICIPANT_DOT_COLORS[idx] } : null
      )
      .filter(Boolean);
    onMeetingParticipantsChange?.(resolvedPins);
  }, [participants, onMeetingParticipantsChange]);

  // Selected venue type sent to the backend (maps to Foursquare category).
  const [meetingPlaceType, setMeetingPlaceType]         = useState("all");
  const [meetingSearchLoading, setMeetingSearchLoading] = useState(false);
  const [meetingError, setMeetingError]                 = useState(null);
  // Non-fatal warning surfaced when the backend could compute the midpoint
  // but Overpass returned no venues (timeout, empty area, etc.).
  const [meetingSearchWarning, setMeetingSearchWarning] = useState(null);
  // Tracks whether a search has been attempted at least once so we can show
  // an informative empty-state instead of nothing after a 0-result query.
  const [hasSearchedOnce, setHasSearchedOnce]           = useState(false);
  const [meetingResults, setMeetingResults]             = useState([]);
  // Driving distance + travel-time cards fetched from /api/calculate-routes
  // after a successful midpoint search. Independent of the OSM places logic.
  const [meetingRoutes, setMeetingRoutes]               = useState([]);
  const [meetingRoutesLoading, setMeetingRoutesLoading] = useState(false);

  // Local text filter applied to the fetched meetingResults list — does NOT
  // trigger any network request; purely a client-side display filter.
  const [meetingPlacesSearchQuery, setMeetingPlacesSearchQuery] = useState("");

  // Pre-create 4 ref slots so hook call count is always stable (never in a loop).
  const participantRefs         = [useRef(null), useRef(null), useRef(null), useRef(null)];
  const participantAbortRefs    = [useRef(null), useRef(null), useRef(null), useRef(null)];
  const participantDebounceRefs = [useRef(null), useRef(null), useRef(null), useRef(null)];

  // ── To field state ─────────────────────────────────────────────────────────
  const [toSuggestions, setToSuggestions] = useState([]);
  const [showToSuggestions, setShowToSuggestions] = useState(false);
  const [toSearchLoading, setToSearchLoading] = useState(false);
  const toDebounceRef = useRef(null);
  // Same pattern for the "To" field — separate controller so the two fields
  // don't cancel each other's requests.
  const toAbortRef = useRef(null);

  // Refs for portal dropdown anchor positioning
  const fromContainerRef = useRef(null);
  const toContainerRef = useRef(null);

  // When a suggestion is selected we set this flag so the useEffect below
  // does NOT overwrite the human-readable place name with raw coordinates.
  const skipFromTextSyncRef = useRef(false);

  // Sync "From" display text when the map click sets startCoords externally.
  // Skip when the coordinates were just set via a search suggestion (in which
  // case the place name is already correct and must not be replaced).
  useEffect(() => {
    if (startCoords) {
      if (skipFromTextSyncRef.current) {
        skipFromTextSyncRef.current = false;
        return;
      }
      setFromText(formatCoords(startCoords));
      setFromSuggestions([]);
      setShowFromSuggestions(false);
    }
  }, [startCoords]);

  // ── From handlers ──────────────────────────────────────────────────────────

  const handleFromInput = (value) => {
    setFromText(value);

    // Cancel both the pending debounce timer and any in-flight request so we
    // never show stale results from a previous, slower network round-trip.
    clearTimeout(fromDebounceRef.current);
    fromAbortRef.current?.abort();

    if (value.trim().length < 2) {
      setFromSuggestions([]);
      setShowFromSuggestions(false);
      return;
    }

    fromDebounceRef.current = setTimeout(async () => {
      const controller = new AbortController();
      fromAbortRef.current = controller;

      setFromSearchLoading(true);
      const results = await searchPlaces(
        value,
        controller.signal,
        searchBiasLat,
        searchBiasLon,
        showApiErrorToast,
      );

      // Drop the response if this request was superseded by a newer keystroke.
      if (controller.signal.aborted) return;

      setFromSuggestions(results);
      setShowFromSuggestions(results.length > 0);
      setFromSearchLoading(false);
    }, SEARCH_DEBOUNCE_MS);
  };

  const handleFromSuggestionSelect = (suggestion) => {
    // Prevent the startCoords useEffect from overwriting the place name
    skipFromTextSyncRef.current = true;
    setFromText(suggestion.name);
    onStartCoordsChange([suggestion.lat, suggestion.lng]);
    setFromSuggestions([]);
    setShowFromSuggestions(false);
    if (onMapFocus) onMapFocus([suggestion.lat, suggestion.lng], 14);
  };

  // Inline GPS error state — displayed below the From field on permission denial.
  const [gpsPermissionDenied, setGpsPermissionDenied] = useState(false);

  const handleUseCurrentLocation = () => {
    setGpsPermissionDenied(false);

    if (!navigator.geolocation) {
      setGpsPermissionDenied(true);
      return;
    }

    setFromLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const coords = [pos.coords.latitude, pos.coords.longitude];
        setFromText(formatCoords(coords));
        onStartCoordsChange(coords);
        setFromLocating(false);
        setGpsPermissionDenied(false);
      },
      (err) => {
        setFromLocating(false);
        // PERMISSION_DENIED (1) or POSITION_UNAVAILABLE (2) → show inline guidance.
        if (err.code === 1 || err.code === 2) {
          setGpsPermissionDenied(true);
        }
      },
      { timeout: 10000 }
    );
  };

  // ── To handlers ────────────────────────────────────────────────────────────

  const handleToInput = (value) => {
    onDestinationTextChange(value);

    clearTimeout(toDebounceRef.current);
    toAbortRef.current?.abort();

    if (value.trim().length < 2) {
      setToSuggestions([]);
      setShowToSuggestions(false);
      return;
    }

    toDebounceRef.current = setTimeout(async () => {
      const controller = new AbortController();
      toAbortRef.current = controller;

      setToSearchLoading(true);
      const results = await searchPlaces(
        value,
        controller.signal,
        searchBiasLat,
        searchBiasLon,
        showApiErrorToast,
      );

      if (controller.signal.aborted) return;

      setToSuggestions(results);
      setShowToSuggestions(results.length > 0);
      setToSearchLoading(false);
    }, SEARCH_DEBOUNCE_MS);
  };

  const handleToSuggestionSelect = (suggestion) => {
    onDestinationTextChange(suggestion.name);
    onEndCoordsChange([suggestion.lat, suggestion.lng]);
    setToSuggestions([]);
    setShowToSuggestions(false);
    if (onMapFocus) onMapFocus([suggestion.lat, suggestion.lng], 14);
  };

  // ── Swap From ↔ To ────────────────────────────────────────────────────────
  // Used by the "swap" icon button placed between the FROM and TO inputs in
  // the floating destination card.  Reverses the planned trip direction
  // without losing any state: the human-readable place names, the resolved
  // coordinates, and any pending searches are all swapped atomically.
  const handleSwapLocations = () => {
    fromAbortRef.current?.abort();
    toAbortRef.current?.abort();
    clearTimeout(fromDebounceRef.current);
    clearTimeout(toDebounceRef.current);

    const previousFromText   = fromText;
    const previousToText     = destinationText;
    const previousFromCoords = startCoords;
    const previousToCoords   = endCoords;

    // The startCoords useEffect would otherwise rewrite the new From label
    // back to raw coordinates the next render — skip that one sync pass.
    skipFromTextSyncRef.current = true;

    setFromText(previousToText);
    onDestinationTextChange(previousFromText);

    onStartCoordsChange(previousToCoords);
    onEndCoordsChange(previousFromCoords);

    setFromSuggestions([]);
    setToSuggestions([]);
    setShowFromSuggestions(false);
    setShowToSuggestions(false);
    setFromSearchLoading(false);
    setToSearchLoading(false);
  };

  // ── Meeting Point handlers ─────────────────────────────────────────────────

  const updateParticipant = (idx, patch) =>
    setParticipants((prev) => {
      const updated = [...prev];
      updated[idx] = { ...updated[idx], ...patch };
      return updated;
    });

  const handleParticipantInput = (idx, value) => {
    updateParticipant(idx, { text: value, coords: null });

    clearTimeout(participantDebounceRefs[idx].current);
    participantAbortRefs[idx].current?.abort();

    if (value.trim().length < 2) {
      updateParticipant(idx, { suggestions: [], showSugg: false, loading: false });
      return;
    }

    participantDebounceRefs[idx].current = setTimeout(async () => {
      const controller = new AbortController();
      participantAbortRefs[idx].current = controller;
      updateParticipant(idx, { loading: true });
      const hits = await searchPlaces(value, controller.signal, searchBiasLat, searchBiasLon, showApiErrorToast);
      if (controller.signal.aborted) return;
      updateParticipant(idx, { suggestions: hits, showSugg: hits.length > 0, loading: false });
    }, SEARCH_DEBOUNCE_MS);
  };

  const handleParticipantSelect = (idx, suggestion) => {
    updateParticipant(idx, {
      text:        suggestion.name,
      coords:      { lat: suggestion.lat, lon: suggestion.lng },
      suggestions: [],
      showSugg:    false,
    });
    if (onMapFocus) onMapFocus([suggestion.lat, suggestion.lng], 14);
  };

  const handleAddParticipant = () => {
    if (participants.length >= 4) return;
    setParticipants((prev) => [...prev, makeEmptyParticipant()]);
  };

  const handleRemoveParticipant = (idx) => {
    if (participants.length <= 2) return;
    setParticipants((prev) => prev.filter((_, i) => i !== idx));
  };

  // Populate a participant slot with the user's current GPS position.
  // Prefers the already-acquired `userLocation` prop to avoid a second
  // geolocation round-trip; falls back to a fresh Geolocation API call.
  const handleParticipantUseCurrentLocation = (idx) => {
    if (userLocation && userLocation[0] != null && userLocation[1] != null) {
      const [lat, lon] = userLocation;
      updateParticipant(idx, {
        text:     `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
        coords:   { lat, lon },
        showSugg: false,
        focused:  false,
      });
      return;
    }

    if (!navigator.geolocation) return;

    updateParticipant(idx, { loading: true });
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;
        updateParticipant(idx, {
          text:    `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
          coords:  { lat, lon },
          loading: false,
          showSugg: false,
          focused:  false,
        });
      },
      () => updateParticipant(idx, { loading: false }),
      { timeout: 10000 }
    );
  };

  // placeTypeOverride lets chip clicks trigger an immediate re-search with the
  // newly selected category without waiting for the React state update to flush.
  const handleMeetingSearch = async (placeTypeOverride = null) => {
    // Retain reference to resolved participants so we can build named origins
    // for the routes call without a second filter pass.
    const validParticipants = participants.filter((p) => p.coords !== null);
    const validLocations    = validParticipants.map((p) => p.coords);

    if (validLocations.length < 2) {
      setMeetingError("يرجى تحديد موقعَين على الأقل من قائمة الاقتراحات.");
      return;
    }

    // Use the override when provided (chip auto-search) so we don't depend on
    // the state setter having flushed before this async call begins.
    const effectivePlaceType = placeTypeOverride ?? meetingPlaceType;

    setMeetingSearchLoading(true);
    setMeetingError(null);
    setMeetingSearchWarning(null);
    setMeetingResults([]);
    setMeetingRoutes([]);
    try {
      const res = await fetch(`${BACKEND_BASE}/api/meeting-point`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ locations: validLocations, placeType: effectivePlaceType }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setHasSearchedOnce(true);
      // Surface the non-fatal backend warning (e.g. Overpass returned nothing).
      if (data.warning) setMeetingSearchWarning(data.warning);
      setMeetingResults(data.places || []);
      onMeetingPointResult?.(data.midpoint, data.places || []);

      // ── Route calculation (independent layer) ─────────────────────────────
      // Only attempt if a midpoint was actually returned by the meeting-point API.
      if (data.midpoint) {
        const origins = validParticipants.map((p, i) => ({
          lat:  p.coords.lat,
          lon:  p.coords.lon,
          name: p.text.trim() || `الشخص ${i + 1}`,
        }));
        setMeetingRoutesLoading(true);
        try {
          const routeRes  = await fetch(`${BACKEND_BASE}/api/calculate-routes`, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({
              origins,
              destination: { lat: data.midpoint.lat, lon: data.midpoint.lon },
            }),
          });
          const routeData = await routeRes.json();
          setMeetingRoutes(routeData.routes || []);
        } catch (_routeErr) {
          // Route calculation failure is non-fatal — the meeting point and
          // nearby places are still shown; we just suppress the route cards.
          setMeetingRoutes([]);
        } finally {
          setMeetingRoutesLoading(false);
        }
      }
    } catch (err) {
      setMeetingError(err.message || "فشل البحث عن نقطة التجمع. حاول مرة أخرى.");
    } finally {
      setMeetingSearchLoading(false);
    }
  };

  // ── Clear (navigation tab) ─────────────────────────────────────────────────

  const handleClear = () => {
    // Cancel any in-flight autocomplete requests before resetting state.
    fromAbortRef.current?.abort();
    toAbortRef.current?.abort();
    clearTimeout(fromDebounceRef.current);
    clearTimeout(toDebounceRef.current);

    setFromText("");
    setFromSuggestions([]);
    setShowFromSuggestions(false);
    setFromSearchLoading(false);
    setFromLocating(false);
    setGpsPermissionDenied(false);

    onDestinationTextChange("");
    setToSuggestions([]);
    setShowToSuggestions(false);
    setToSearchLoading(false);

    onClearRoute();
  };

  // ── Clear Meeting Point ────────────────────────────────────────────────────
  // Resets all meeting-tab state: participant inputs, results, routes, and
  // removes the map pins by notifying the parent with empty arrays.

  const handleMeetingClear = () => {
    setParticipants([makeEmptyParticipant(), makeEmptyParticipant()]);
    setMeetingResults([]);
    setMeetingRoutes([]);
    setMeetingError(null);
    setMeetingSearchWarning(null);
    setHasSearchedOnce(false);
    setMeetingPlaceType("all");
    setMeetingPlacesSearchQuery("");
    // Clear participant map markers.
    onMeetingParticipantsChange?.([]);
    // Clear midpoint + venue markers from the map.
    onMeetingPointResult?.(null, []);
  };

  // ── Derived display values ─────────────────────────────────────────────────

  const confidencePct = normalizePredictionAccuracyPercent(prediction?.confidence);

  const predictionLevel =
    prediction?.predictedTrafficLevel || prediction?.predictedTraffic;

  // ── Inline styles ──────────────────────────────────────────────────────────

  const S = {
    sidebar: {
      background: "rgba(15, 15, 20, 0.70)",
      backdropFilter: "blur(20px)",
      WebkitBackdropFilter: "blur(20px)",
      color: "#E2E8F0",
      display: "flex",
      flexDirection: "column",
      fontFamily: isRTL
        ? "'Segoe UI', Arial, 'Tahoma', sans-serif"
        : "'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif",
      border: "1px solid rgba(255, 255, 255, 0.08)",
      boxShadow:
        "0 24px 60px rgba(0, 0, 0, 0.60), 0 0 0 1px rgba(255,255,255,0.04) inset",
      direction: isRTL ? "rtl" : "ltr",
      borderRadius: 16,
    },
    header: {
      padding: "14px 18px 10px",
      flexShrink: 0,
    },
    headerRow: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: 5,
    },
    headerTitle: {
      margin: 0,
      fontSize: 17,
      fontWeight: 800,
      color: "#F1F5F9",
      display: "flex",
      alignItems: "center",
      gap: 9,
      letterSpacing: "-0.5px",
    },
    headerSub: {
      margin: 0,
      fontSize: 11,
      color: "#475569",
      letterSpacing: "0.3px",
    },
    content: {
      flex: 1,
      padding: "14px 14px 10px",
      display: "flex",
      flexDirection: "column",
      gap: 12,
      overflowY: "auto",
    },
    card: {
      background: "rgba(30, 41, 59, 0.50)",
      borderRadius: 14,
      padding: "14px",
      border: "1px solid rgba(255, 255, 255, 0.07)",
    },
    label: {
      fontSize: 10,
      color: "#64748B",
      marginBottom: 6,
      display: "block",
      fontWeight: 700,
      letterSpacing: "1px",
      textTransform: "uppercase",
    },
    // Base input — padding reserves space for the icon on the leading side
    // and the action button/spinner on the trailing side
    inputBase: {
      width: "100%",
      background: "rgba(2, 8, 24, 0.60)",
      border: "1.5px solid rgba(255, 255, 255, 0.07)",
      borderRadius: 50,
      color: "#E2E8F0",
      fontSize: 13,
      boxSizing: "border-box",
      outline: "none",
      transition: "all 0.3s ease",
      fontFamily: "inherit",
      boxShadow: "inset 0 1px 4px rgba(0,0,0,0.38)",
    },
    btnPrimary: {
      flex: 1,
      padding: "13px 0",
      background: "linear-gradient(135deg, #2563EB, #3B82F6)",
      color: "#fff",
      border: "none",
      borderRadius: 13,
      cursor: "pointer",
      fontWeight: 700,
      fontSize: 13,
      letterSpacing: "0.3px",
      boxShadow: "0 4px 16px rgba(37, 99, 235, 0.38)",
      transition: "transform 0.18s ease, box-shadow 0.18s ease, opacity 0.18s ease",
      fontFamily: "inherit",
    },
    btnSecondary: {
      padding: "13px 16px",
      background: "rgba(51, 65, 85, 0.60)",
      color: "#94A3B8",
      border: "1px solid rgba(71, 85, 105, 0.45)",
      borderRadius: 13,
      cursor: "pointer",
      fontWeight: 600,
      fontSize: 13,
      transition: "background 0.18s ease, transform 0.18s ease, color 0.18s ease",
      fontFamily: "inherit",
    },
    footer: {
      padding: "11px 16px",
      borderTop: "1px solid rgba(255, 255, 255, 0.06)",
      flexShrink: 0,
      background: "rgba(2, 8, 20, 0.45)",
      borderRadius: "0 0 16px 16px",
    },
  };

  // Padding helpers — leading icon + trailing action button
  const inputPadding = isRTL
    ? { padding: "11px 40px 11px 42px" }
    : { padding: "11px 42px 11px 40px" };

  const inputStyle = { ...S.inputBase, ...inputPadding, direction: isRTL ? "rtl" : "ltr", textAlign: isRTL ? "right" : "left" };

  const leadingSide  = isRTL ? "right" : "left";
  const trailingSide = isRTL ? "left"  : "right";

  // Inline icon positioned on the leading edge
  const leadingIconStyle = {
    position: "absolute",
    [leadingSide]: 13,
    top: "50%",
    transform: "translateY(-50%)",
    fontSize: 14,
    zIndex: 2,
    pointerEvents: "none",
    lineHeight: 1,
  };

  // Trailing action button (GPS or clear)
  const trailingBtnStyle = {
    position: "absolute",
    [trailingSide]: 8,
    top: "50%",
    transform: "translateY(-50%)",
    background: "transparent",
    border: "none",
    cursor: "pointer",
    padding: "4px 5px",
    zIndex: 2,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 6,
    transition: "color 0.2s, background 0.2s",
  };

  // Trailing spinner (loading state)
  const trailingSpinnerStyle = {
    position: "absolute",
    [trailingSide]: 12,
    top: "50%",
    fontSize: 14,
    color: "#64748B",
    animation: "spin 1s linear infinite",
    pointerEvents: "none",
  };

  // ── Mobile unified-bottom-sheet route phase ────────────────────────────
  // Drives the conditional rendering of the route-summary card and the
  // state-aware primary CTA, plus the CSS attribute selectors in
  // App.css that toggle Phase 1 (idle) vs Phase 2 (preview/navigating)
  // visibility.
  //   • idle        → no route yet            → "اقترح الطريق" CTA
  //   • preview     → route ready, not driving → "انطلق" CTA
  //   • navigating  → currently driving        → "إنهاء الملاحة" CTA
  const hasActiveRoute = Array.isArray(allRoutes) && allRoutes.length > 0;
  const mobileRouteState = isNavigating
    ? "navigating"
    : hasActiveRoute
      ? "preview"
      : "idle";

  return (
    <aside
      style={S.sidebar}
      data-route-state={mobileRouteState}
      className={`floating-sidebar${!isMobileOpen ? " sidebar-collapsed" : ""}`}
    >
      {/* ── Mobile drag handle — tap to toggle the bottom sheet ─────────── */}
      <div
        className="sidebar-pull-handle"
        onClick={onMobileToggle}
        role="button"
        aria-label={isMobileOpen ? "إغلاق القائمة" : "فتح القائمة"}
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onMobileToggle?.(); }}
      />

      {/* ── Tab Toggle ──────────────────────────────────────────────────────
       * Pinned as the FIRST content row of the bottom sheet — placed in
       * the JSX immediately after the drag handle (no flex-order tricks)
       * so the tabs always flow naturally as the top item of the card.
       *
       * Placing this block here in source order (rather than relying on
       * `order: 1` over `display: contents`-flattened siblings) makes the
       * layout robust against any browser quirk in the `display: contents`
       * + flex-order cascade — the tabs sit above the prediction widget /
       * meeting panel by virtue of their position in the DOM tree, not a
       * computed CSS hint.
       *
       * The button gradients (blue for "التنقل", purple for
       * "نقطة التجمع") and the active/inactive colour tokens are
       * intentionally preserved from the previous design.
       */}
      <div
        className="mobile-bottom-tabs"
        style={{
          display:    "flex",
          gap:        6,
          padding:    "0 14px 10px",
          flexShrink: 0,
        }}
      >
        <button
          onClick={() => setActiveTab("main")}
          style={{
            flex:       1,
            padding:    "8px 0",
            background: activeTab === "main"
              ? "linear-gradient(135deg, #2563EB, #3B82F6)"
              : "rgba(30, 41, 59, 0.50)",
            border:       activeTab === "main"
              ? "1px solid #3B82F6"
              : "1px solid rgba(255,255,255,0.07)",
            borderRadius: 10,
            color:        activeTab === "main" ? "#fff" : "#64748B",
            cursor:       "pointer",
            fontWeight:   700,
            fontSize:     12,
            fontFamily:   "inherit",
            transition:   "all 0.2s ease",
          }}
        >
          🧭 التنقل
        </button>
        <button
          onClick={() => setActiveTab("meeting")}
          style={{
            flex:       1,
            padding:    "8px 0",
            background: activeTab === "meeting"
              ? "linear-gradient(135deg, #7C3AED, #8B5CF6)"
              : "rgba(30, 41, 59, 0.50)",
            border:       activeTab === "meeting"
              ? "1px solid #8B5CF6"
              : "1px solid rgba(255,255,255,0.07)",
            borderRadius: 10,
            color:        activeTab === "meeting" ? "#fff" : "#64748B",
            cursor:       "pointer",
            fontWeight:   700,
            fontSize:     12,
            fontFamily:   "inherit",
            transition:   "all 0.2s ease",
          }}
        >
          🎯 نقطة التجمع
        </button>
      </div>

      {/* ── Header ──────────────────────────────────────────────────────────
       * The brand strip is hidden on mobile (CSS:
       * `.floating-sidebar > .sidebar-header-block { display: none }`).
       * On desktop it still renders; with the tab row now hoisted above
       * it, the desktop sidebar reads top-to-bottom as:
       *   pull-handle (mobile only) → tabs → brand → main content. */}
      <div style={S.header} className="sidebar-header-block">
        <div style={S.headerRow}>
          <span
            style={{
              fontSize: 22,
              fontWeight: 800,
              letterSpacing: "-0.5px",
              color: "#E2E8F0",
              fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif",
            }}
          >
            Traffstant
          </span>
        </div>
        <p style={S.headerSub}>{t("appSubtitle")}</p>
      </div>

      {/* ── Meeting Point Panel ──────────────────────────────────────────── */}
      {activeTab === "meeting" && (() => {
        // Venue-type chip definitions — value maps to backend placeType key.
        const VENUE_CHIPS = [
          { value: "coffee",     label: "قهوة",  emoji: "☕" },
          { value: "tea",        label: "شاهي",  emoji: "🫖" },
          { value: "restaurant", label: "مطعم",  emoji: "🍔" },
          { value: "all",        label: "الكل",  emoji: "🌟" },
        ];

        const hasEnoughLocations =
          participants.filter((p) => p.coords !== null).length >= 2;

        return (
          <div
            className="mobile-meeting-panel"
            style={{
              flex:          1,
              padding:       "0 14px 14px",
              display:       "flex",
              flexDirection: "column",
              gap:           12,
              overflowY:     "auto",
            }}
          >
            {/* ── Participants card ──────────────────────────────────────── */}
            <div style={S.card}>
              {/* Card header */}
              <div
                style={{
                  display:       "flex",
                  alignItems:    "center",
                  gap:           8,
                  marginBottom:  14,
                  paddingBottom: 10,
                  borderBottom:  "1px solid rgba(255,255,255,0.07)",
                }}
              >
                <span style={{ fontSize: 15 }}>👥</span>
                <span
                  style={{
                    fontSize:      10,
                    fontWeight:    800,
                    color:         "#475569",
                    letterSpacing: "1.4px",
                    textTransform: "uppercase",
                    flex:          1,
                  }}
                >
                  مواقع المشاركين ({participants.length})
                </span>
              </div>

              {/* Dynamic participant inputs */}
              {participants.map((participant, idx) => (
                <div
                  key={idx}
                  style={{ marginBottom: idx < participants.length - 1 ? 12 : 0 }}
                >
                  {/* Row label + optional remove button */}
                  <div
                    style={{
                      display:        "flex",
                      alignItems:     "center",
                      justifyContent: "space-between",
                      marginBottom:   6,
                    }}
                  >
                    <span style={S.label}>
                      موقع الشخص {idx + 1}
                      {participant.coords && (
                        <span
                          style={{
                            marginRight:  6,
                            fontSize:     9,
                            color:        "#22C55E",
                            fontWeight:   700,
                            letterSpacing: "0.3px",
                          }}
                        >
                          ✓ محدد
                        </span>
                      )}
                    </span>
                    {participants.length > 2 && (
                      <button
                        onClick={() => handleRemoveParticipant(idx)}
                        title="إزالة هذا الموقع"
                        style={{
                          background:  "transparent",
                          border:      "none",
                          color:       "#475569",
                          cursor:      "pointer",
                          fontSize:    15,
                          lineHeight:  1,
                          padding:     "2px 4px",
                          borderRadius: 4,
                          transition:  "color 0.15s",
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.color = "#EF4444")}
                        onMouseLeave={(e) => (e.currentTarget.style.color = "#475569")}
                      >
                        ✕
                      </button>
                    )}
                  </div>

                  {/* Input with autocomplete portal */}
                  <div ref={participantRefs[idx]} style={{ position: "relative" }}>
                    <span
                      style={{
                        ...leadingIconStyle,
                        color: PARTICIPANT_DOT_COLORS[idx],
                        filter: `drop-shadow(0 0 4px ${PARTICIPANT_DOT_COLORS[idx]})`,
                      }}
                    >
                      ●
                    </span>
                    <input
                      type="text"
                      placeholder={`ابحث عن موقع الشخص ${idx + 1}...`}
                      value={participant.text}
                      onChange={(e) => handleParticipantInput(idx, e.target.value)}
                      onFocus={(e) => {
                        e.currentTarget.style.borderColor = "rgba(0,200,255,0.50)";
                        e.currentTarget.style.boxShadow  =
                          "inset 0 1px 4px rgba(0,0,0,0.38), 0 0 0 2.5px rgba(0,200,255,0.28)";
                        e.currentTarget.style.background = "rgba(2, 10, 28, 0.72)";
                        updateParticipant(idx, {
                          focused:  true,
                          showSugg: participant.suggestions.length > 0,
                        });
                      }}
                      onBlur={(e) => {
                        e.currentTarget.style.borderColor = "rgba(255,255,255,0.07)";
                        e.currentTarget.style.boxShadow  = "inset 0 1px 4px rgba(0,0,0,0.38)";
                        e.currentTarget.style.background = "rgba(2, 8, 24, 0.60)";
                        setTimeout(() => updateParticipant(idx, { showSugg: false, focused: false }), 160);
                      }}
                      style={inputStyle}
                    />
                    {participant.loading && (
                      <span style={trailingSpinnerStyle}>⟳</span>
                    )}
                    <SearchDropdownPortal
                      suggestions={participant.suggestions}
                      onSelect={(s) => handleParticipantSelect(idx, s)}
                      isRTL={isRTL}
                      anchorRef={participantRefs[idx]}
                      show={participant.showSugg && participant.suggestions.length > 0}
                      showUseLocation={participant.focused && participant.text.trim().length < 2}
                      onUseLocation={() => handleParticipantUseCurrentLocation(idx)}
                    />
                  </div>
                </div>
              ))}

              {/* Add-person button (hidden once 4 participants are added) */}
              {participants.length < 4 && (
                <button
                  onClick={handleAddParticipant}
                  style={{
                    marginTop:   14,
                    width:       "100%",
                    padding:     "9px 0",
                    background:  "rgba(30, 41, 59, 0.50)",
                    border:      "1.5px dashed rgba(139, 92, 246, 0.40)",
                    borderRadius: 10,
                    color:       "#8B5CF6",
                    cursor:      "pointer",
                    fontWeight:  700,
                    fontSize:    12,
                    fontFamily:  "inherit",
                    display:     "flex",
                    alignItems:  "center",
                    justifyContent: "center",
                    gap:         6,
                    transition:  "all 0.2s ease",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background  = "rgba(139, 92, 246, 0.12)";
                    e.currentTarget.style.borderColor = "rgba(139, 92, 246, 0.70)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background  = "rgba(30, 41, 59, 0.50)";
                    e.currentTarget.style.borderColor = "rgba(139, 92, 246, 0.40)";
                  }}
                >
                  ➕ إضافة شخص آخر
                </button>
              )}
            </div>

            {/* ── Place type chips ───────────────────────────────────────── */}
            <div style={S.card}>
              <div
                style={{
                  fontSize:      10,
                  fontWeight:    800,
                  color:         "#475569",
                  letterSpacing: "1.4px",
                  textTransform: "uppercase",
                  marginBottom:  10,
                }}
              >
                🏷 نوع المكان
              </div>
              <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
                {VENUE_CHIPS.map((chip) => {
                  const isActive = meetingPlaceType === chip.value;
                  return (
                    <button
                      key={chip.value}
                      onClick={() => {
                        const newType = chip.value;
                        if (meetingPlaceType === newType) return; // no-op if already active
                        setMeetingPlaceType(newType);
                        setMeetingResults([]);
                        setMeetingRoutes([]);
                        // Auto-refilter immediately when at least two participants
                        // are already resolved — no extra Search click required.
                        const resolvedCount = participants.filter(
                          (p) => p.coords !== null
                        ).length;
                        if (resolvedCount >= 2) {
                          handleMeetingSearch(newType);
                        }
                      }}
                      style={{
                        padding:      "7px 13px",
                        background:   isActive
                          ? "linear-gradient(135deg, #7C3AED, #8B5CF6)"
                          : "rgba(30, 41, 59, 0.60)",
                        border:       isActive
                          ? "1px solid #8B5CF6"
                          : "1px solid rgba(255,255,255,0.08)",
                        borderRadius: 20,
                        color:        isActive ? "#FFFFFF" : "#94A3B8",
                        cursor:       "pointer",
                        fontWeight:   isActive ? 700 : 500,
                        fontSize:     12,
                        fontFamily:   "inherit",
                        display:      "flex",
                        alignItems:   "center",
                        gap:          5,
                        transition:   "all 0.18s ease",
                        boxShadow:    isActive ? "0 2px 10px rgba(139,92,246,0.35)" : "none",
                      }}
                    >
                      <span style={{ fontSize: 14 }}>{chip.emoji}</span>
                      {chip.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* ── Search + Clear button row ──────────────────────────────── */}
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => handleMeetingSearch()}
                disabled={meetingSearchLoading || !hasEnoughLocations}
                style={{
                  ...S.btnPrimary,
                  flex:       1,
                  background: "linear-gradient(135deg, #7C3AED, #8B5CF6)",
                  boxShadow:  "0 4px 16px rgba(124, 58, 237, 0.38)",
                  opacity:    (meetingSearchLoading || !hasEnoughLocations) ? 0.60 : 1,
                  cursor:     (meetingSearchLoading || !hasEnoughLocations)
                    ? "not-allowed"
                    : "pointer",
                }}
                onMouseEnter={(e) => {
                  if (!meetingSearchLoading && hasEnoughLocations) {
                    e.currentTarget.style.transform  = "translateY(-2px)";
                    e.currentTarget.style.boxShadow  = "0 8px 24px rgba(124,58,237,0.55)";
                    e.currentTarget.style.background = "linear-gradient(135deg, #6D28D9, #7C3AED)";
                  }
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform  = "translateY(0)";
                  e.currentTarget.style.boxShadow  = "0 4px 16px rgba(124,58,237,0.38)";
                  e.currentTarget.style.background = "linear-gradient(135deg, #7C3AED, #8B5CF6)";
                }}
              >
                {meetingSearchLoading ? "⟳ جارٍ البحث..." : "🎯 بحث عن نقطة تجمع"}
              </button>

              {/* Clear button — resets all meeting state and map markers */}
              <button
                onClick={handleMeetingClear}
                title="مسح جميع البيانات"
                style={{
                  flexShrink:   0,
                  padding:      "0 12px",
                  height:       "100%",
                  minHeight:    38,
                  background:   "transparent",
                  border:       "1px solid rgba(239, 68, 68, 0.38)",
                  borderRadius: 10,
                  boxShadow:    "none",
                  color:        "#F87171",
                  fontSize:     11,
                  fontWeight:   600,
                  fontFamily:   "inherit",
                  cursor:       "pointer",
                  letterSpacing: "0.3px",
                  transition:   "border-color 0.18s, color 0.18s, background 0.18s",
                  whiteSpace:   "nowrap",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background   = "rgba(239,68,68,0.10)";
                  e.currentTarget.style.borderColor  = "rgba(239,68,68,0.65)";
                  e.currentTarget.style.color        = "#FCA5A5";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background   = "transparent";
                  e.currentTarget.style.borderColor  = "rgba(239,68,68,0.38)";
                  e.currentTarget.style.color        = "#F87171";
                }}
              >
                مسح
              </button>
            </div>

            {/* ── Error banner ───────────────────────────────────────────── */}
            {meetingError && (
              <div
                style={{
                  padding:    "10px 13px",
                  background: "rgba(69, 10, 10, 0.70)",
                  border:     "1px solid rgba(239, 68, 68, 0.45)",
                  borderRadius: 12,
                  color:      "#FCA5A5",
                  fontSize:   12,
                  display:    "flex",
                  gap:        8,
                  alignItems: "flex-start",
                }}
              >
                <span style={{ flexShrink: 0 }}>⚠</span>
                <span>{meetingError}</span>
              </div>
            )}

            {/* ── Route summary cards ────────────────────────────────────── */}
            {/* Displayed after a successful midpoint search. Shows driving     */}
            {/* distance + travel time from each participant to the midpoint.   */}
            {(meetingRoutesLoading || meetingRoutes.length > 0) && (
              <div
                style={{
                  background:   "rgba(15, 23, 42, 0.72)",
                  border:       "1px solid rgba(139, 92, 246, 0.28)",
                  borderRadius: 14,
                  padding:      "14px 16px",
                  display:      "flex",
                  flexDirection: "column",
                  gap:          10,
                }}
              >
                {/* Section header */}
                <div
                  style={{
                    display:       "flex",
                    alignItems:    "center",
                    gap:           8,
                    paddingBottom: 10,
                    borderBottom:  "1px solid rgba(255,255,255,0.07)",
                  }}
                >
                  <span style={{ fontSize: 15 }}>🗺️</span>
                  <span
                    style={{
                      fontSize:      10,
                      fontWeight:    800,
                      color:         "#475569",
                      letterSpacing: "1.4px",
                      textTransform: "uppercase",
                    }}
                  >
                    المسافات من كل شخص
                  </span>
                </div>

                {/* Loading shimmer */}
                {meetingRoutesLoading && (
                  <div
                    style={{
                      fontSize:   12,
                      color:      "#64748B",
                      textAlign:  "center",
                      padding:    "6px 0",
                      animation:  "pulse 1.5s ease-in-out infinite",
                    }}
                  >
                    ⟳ جارٍ حساب المسافات…
                  </div>
                )}

                {/* One card per participant */}
                {!meetingRoutesLoading &&
                  meetingRoutes.map((route, idx) => (
                    <div
                      key={idx}
                      style={{
                        background:   "rgba(30, 41, 59, 0.55)",
                        border:       "1px solid rgba(255,255,255,0.06)",
                        borderRadius: 10,
                        padding:      "10px 13px",
                        display:      "flex",
                        flexDirection: "column",
                        gap:          5,
                      }}
                    >
                      {/* Participant label */}
                      <div
                        style={{
                          fontSize:   12,
                          fontWeight: 700,
                          color:      "#C4B5FD",
                          display:    "flex",
                          alignItems: "center",
                          gap:        6,
                          wordBreak:  "break-word",
                        }}
                      >
                        <span>👤</span>
                        <span>{route.name}</span>
                      </div>

                      {/* Distance / time row — or error message */}
                      {route.error ? (
                        <div style={{ fontSize: 11, color: "#F87171" }}>
                          ⚠ {route.error}
                        </div>
                      ) : (
                        <div
                          style={{
                            display:    "flex",
                            gap:        0,
                            flexWrap:   "nowrap",
                            fontSize:   12,
                            color:      "#94A3B8",
                            alignItems: "center",
                            overflow:   "hidden",
                          }}
                        >
                          <span style={{ whiteSpace: "nowrap" }}>
                            <span style={{ color: "#34D399", fontWeight: 700 }}>🚗 المسافة:</span>
                            {" "}{route.distanceText}
                          </span>
                          <span style={{ color: "rgba(255,255,255,0.20)", margin: "0 6px", flexShrink: 0 }}>|</span>
                          <span style={{ whiteSpace: "nowrap" }}>
                            <span style={{ color: "#FBBF24", fontWeight: 700 }}>⏳ الوقت:</span>
                            {" "}{route.timeText}
                          </span>
                        </div>
                      )}
                    </div>
                  ))}
              </div>
            )}

            {/* ── Meeting Places list (inline, below the distances section) ── */}
            {meetingResults.length > 0 && (
              <div
                style={{
                  background:    "rgba(15, 23, 42, 0.72)",
                  border:        "1px solid rgba(139, 92, 246, 0.28)",
                  borderRadius:  14,
                  padding:       "14px 16px",
                  display:       "flex",
                  flexDirection: "column",
                  gap:           10,
                }}
              >
                {/* Section header */}
                <div
                  style={{
                    display:       "flex",
                    alignItems:    "center",
                    gap:           8,
                    paddingBottom: 10,
                    borderBottom:  "1px solid rgba(255,255,255,0.07)",
                  }}
                >
                  <span style={{ fontSize: 15 }}>🎯</span>
                  <span
                    style={{
                      fontSize:      10,
                      fontWeight:    800,
                      color:         "#475569",
                      letterSpacing: "1.4px",
                      textTransform: "uppercase",
                      flex:          1,
                    }}
                  >
                    أماكن الاجتماع ({meetingResults.length})
                  </span>
                  <button
                    onClick={() => { setMeetingResults([]); setMeetingPlacesSearchQuery(""); }}
                    title="إغلاق"
                    style={{
                      background:   "transparent",
                      border:       "none",
                      color:        "#475569",
                      cursor:       "pointer",
                      fontSize:     16,
                      lineHeight:   1,
                      padding:      "2px 4px",
                      borderRadius: 4,
                      transition:   "color 0.15s",
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.color = "#E2E8F0")}
                    onMouseLeave={(e) => (e.currentTarget.style.color = "#475569")}
                  >
                    ✕
                  </button>
                </div>

                {/* ── Local search filter ──────────────────────────────────── */}
                <div
                  style={{
                    position:     "relative",
                    display:      "flex",
                    alignItems:   "center",
                  }}
                >
                  {/* Search icon */}
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width={14}
                    height={14}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="#475569"
                    strokeWidth={2.2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{
                      position:  "absolute",
                      right:     10,
                      pointerEvents: "none",
                      flexShrink: 0,
                    }}
                  >
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                  <input
                    type="text"
                    value={meetingPlacesSearchQuery}
                    onChange={(e) => setMeetingPlacesSearchQuery(e.target.value)}
                    placeholder="ابحث عن اسم مكان..."
                    dir="rtl"
                    style={{
                      width:           "100%",
                      padding:         "8px 34px 8px 10px",
                      background:      "rgba(2, 8, 23, 0.65)",
                      border:          "1px solid rgba(139, 92, 246, 0.25)",
                      borderRadius:    8,
                      color:           "#CBD5E1",
                      fontSize:        12,
                      fontFamily:      "inherit",
                      outline:         "none",
                      boxSizing:       "border-box",
                      transition:      "border-color 0.15s",
                    }}
                    onFocus={(e) => {
                      e.currentTarget.style.borderColor = "rgba(139, 92, 246, 0.6)";
                    }}
                    onBlur={(e) => {
                      e.currentTarget.style.borderColor = "rgba(139, 92, 246, 0.25)";
                    }}
                  />
                </div>

                {/* Scrollable venue list */}
                <div
                  style={{
                    display:       "flex",
                    flexDirection: "column",
                    gap:           8,
                    maxHeight:     300,
                    overflowY:     "auto",
                    overflowX:     "hidden",
                    paddingRight:  2,
                  }}
                >
                  {meetingResults
                    .filter((place) =>
                      meetingPlacesSearchQuery.trim() === "" ||
                      (place.name ?? "")
                        .toLowerCase()
                        .includes(meetingPlacesSearchQuery.trim().toLowerCase())
                    )
                    .map((place, i) => {
                    const catLower  = (place.category || "").toLowerCase();
                    const venueEmoji =
                      catLower.includes("قهوة") || catLower.includes("مقهى") || catLower.includes("café") || catLower.includes("coffee")
                        ? "☕"
                      : catLower.includes("شاي") || catLower.includes("tea") || catLower.includes("chai")
                        ? "🫖"
                      : catLower.includes("مطعم") || catLower.includes("restaurant")
                        ? "🍔"
                      : "🍽";

                    // Build a formatted Arabic address line from the
                    // discrete street / neighborhood fields returned by the API.
                    const addressParts = [];
                    if (place.neighborhood) addressParts.push(`حي ${place.neighborhood}`);
                    if (place.street)       addressParts.push(`شارع ${place.street}`);
                    const addressLine = addressParts.join(" · ");

                    return (
                      <div
                        key={i}
                        onClick={() => { if (onMapFocus) onMapFocus([place.lat, place.lng], 17); }}
                        style={{
                          display:      "flex",
                          alignItems:   "flex-start",
                          gap:          10,
                          padding:      "10px 12px",
                          background:   "rgba(2, 8, 23, 0.65)",
                          borderRadius: 12,
                          border:       "1px solid rgba(139, 92, 246, 0.20)",
                          cursor:       "pointer",
                          transition:   "background 0.15s ease",
                          ...(isRTL
                            ? { borderRight: "3px solid #8B5CF6" }
                            : { borderLeft:  "3px solid #8B5CF6" }
                          ),
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = "rgba(30, 12, 60, 0.75)";
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = "rgba(2, 8, 23, 0.65)";
                        }}
                      >
                        <span style={{ fontSize: 18, flexShrink: 0, lineHeight: 1.3 }}>
                          {venueEmoji}
                        </span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          {/* Name + drive-thru badge on the same line */}
                          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                            <div
                              style={{
                                fontSize:     13,
                                fontWeight:   600,
                                color:        "#E2E8F0",
                                lineHeight:   1.3,
                                overflow:     "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace:   "nowrap",
                                maxWidth:     "100%",
                              }}
                            >
                              {place.name}
                            </div>
                            {/* Drive-thru badge */}
                            {place.hasDriveThru && (
                              <span
                                style={{
                                  display:       "inline-flex",
                                  alignItems:    "center",
                                  gap:           3,
                                  fontSize:      9,
                                  fontWeight:    700,
                                  color:         "#10B981",
                                  background:    "rgba(16,185,129,0.10)",
                                  border:        "1px solid rgba(16,185,129,0.28)",
                                  borderRadius:  4,
                                  padding:       "1px 5px",
                                  letterSpacing: "0.3px",
                                  whiteSpace:    "nowrap",
                                  flexShrink:    0,
                                }}
                              >
                                🚗 خدمة سيارات
                              </span>
                            )}
                          </div>
                          {/* Category label */}
                          {place.category && (
                            <div
                              style={{
                                fontSize:   10,
                                color:      "#8B5CF6",
                                marginTop:  3,
                                fontWeight: 600,
                              }}
                            >
                              {place.category}
                            </div>
                          )}
                          {/* Formatted address — only rendered when at least one
                              part (street or neighborhood) is present */}
                          {addressLine && (
                            <div
                              style={{
                                fontSize:   10,
                                color:      "#64748B",
                                marginTop:  3,
                                lineHeight: 1.5,
                                overflow:   "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              📍 {addressLine}
                            </div>
                          )}
                        </div>
                        {place.distance != null && (
                          <span
                            style={{
                              fontSize:     10,
                              fontWeight:   700,
                              color:        "#8B5CF6",
                              background:   "rgba(139, 92, 246, 0.12)",
                              border:       "1px solid rgba(139, 92, 246, 0.22)",
                              borderRadius: 6,
                              padding:      "2px 6px",
                              flexShrink:   0,
                              whiteSpace:   "nowrap",
                            }}
                          >
                            {place.distance < 1000
                              ? `${place.distance} م`
                              : `${(place.distance / 1000).toFixed(1)} كم`}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ── Post-search warning (Overpass timeout / empty area) ──────── */}
            {!meetingSearchLoading && meetingSearchWarning && meetingResults.length === 0 && (
              <div
                style={{
                  padding:      "10px 13px",
                  background:   "rgba(69, 40, 10, 0.70)",
                  border:       "1px solid rgba(251, 146, 60, 0.45)",
                  borderRadius: 12,
                  color:        "#FED7AA",
                  fontSize:     12,
                  display:      "flex",
                  gap:          8,
                  alignItems:   "flex-start",
                  lineHeight:   1.55,
                }}
              >
                <span style={{ flexShrink: 0 }}>⚠</span>
                <span>{meetingSearchWarning}</span>
              </div>
            )}

            {/* ── Empty state after a successful search that returned 0 venues ── */}
            {!meetingSearchLoading && !meetingSearchWarning && hasSearchedOnce
              && meetingResults.length === 0 && (
              <div
                style={{
                  padding:      "14px 12px",
                  background:   "rgba(15, 23, 42, 0.55)",
                  border:       "1px solid rgba(255,255,255,0.07)",
                  borderRadius: 12,
                  textAlign:    "center",
                  lineHeight:   1.75,
                }}
              >
                <div style={{ fontSize: 24, marginBottom: 8 }}>🔍</div>
                <div style={{ fontSize: 12, color: "#94A3B8", fontWeight: 600 }}>
                  عذراً، لا توجد أماكن في هذه المنطقة.
                </div>
                <div style={{ fontSize: 11, color: "#475569", marginTop: 4 }}>
                  جرب تغيير الفلتر أو توسيع البحث.
                </div>
              </div>
            )}

            {/* ── Pre-search prompt (no search run yet) ─────────────────────── */}
            {!meetingSearchLoading && !hasSearchedOnce && !meetingError
              && meetingResults.length === 0 && hasEnoughLocations && (
              <div
                style={{
                  color:      "#475569",
                  fontSize:   12,
                  textAlign:  "center",
                  padding:    "8px 0",
                  lineHeight: 1.6,
                }}
              >
                اضغط على زر البحث لإيجاد أماكن الاجتماع بين المشاركين.
              </div>
            )}
          </div>
        );
      })()}

      {/* ── Main Navigation Panel ─────────────────────────────────────────── */}
      {activeTab === "main" && (
      <div style={S.content} className="sidebar-main-content">
        {/*
         * The `sidebar-main-content` wrapper exists so mobile CSS can flatten
         * its children into the sidebar's flex column (`display: contents`)
         * to reorder the bottom-sheet rows independently from desktop layout.
         */}

        {/* ── Backend Offline Warning ──────────────────────────────────── */}
        {backendOnline === false && (
          <div
            style={{
              padding: "11px 13px",
              background: "rgba(69, 10, 10, 0.85)",
              border: "1px solid rgba(239, 68, 68, 0.60)",
              borderRadius: 13,
              display: "flex",
              alignItems: "center",
              gap: 10,
              backdropFilter: "blur(8px)",
              WebkitBackdropFilter: "blur(8px)",
            }}
          >
            <span style={{ fontSize: 16, flexShrink: 0 }}>🔴</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#FEF2F2", marginBottom: 2 }}>
                {t("serverDisconnected")}
              </div>
              <div style={{ fontSize: 11, color: "#FCA5A5" }}>
                {t("errorBackendOffline")}
              </div>
            </div>
            {onRetryConnection && (
              <button
                onClick={onRetryConnection}
                style={{
                  padding: "5px 12px",
                  background: "rgba(239, 68, 68, 0.25)",
                  border: "1px solid rgba(239, 68, 68, 0.50)",
                  borderRadius: 8,
                  color: "#FCA5A5",
                  cursor: "pointer",
                  fontSize: 11,
                  fontWeight: 700,
                  fontFamily: "inherit",
                  flexShrink: 0,
                  transition: "background 0.2s",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(239, 68, 68, 0.40)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "rgba(239, 68, 68, 0.25)")}
              >
                {t("retryConnection")}
              </button>
            )}
          </div>
        )}

        {/* ── Destination Card ─────────────────────────────────────────── */}
        {/*
         * DOM-level placement:
         *   • Desktop (>768px): rendered inline as the first card inside the
         *     sidebar — same as before.
         *   • Mobile  (≤768px): rendered through a React portal into
         *     `document.body`, OUT of the `.floating-sidebar` subtree.
         *
         * Why portal on mobile:
         *   The bottom-sheet ancestor uses `transform: translateY(...)` for
         *   its slide animation, which (per CSS spec) becomes the containing
         *   block for any `position: fixed` descendant.  A fixed-positioned
         *   top panel kept inside the sheet would therefore anchor to the
         *   sheet — not the viewport — and end up floating directly over the
         *   bottom-sheet content, blocking the traffic alert and primary CTA.
         *   Portaling moves the DOM node to `document.body` while keeping
         *   the React subtree intact (state, refs, and event handlers all
         *   continue to work because the React tree is unchanged).
         *
         *   The `mobile-top-search-panel` class name is the CSS hook used to
         *   style the portaled panel at the top of the viewport.  See App.css.
         */}
        {(() => {
          const destinationCard = (
        <div
          style={isMobile ? undefined : S.card}
          className={`mobile-floating-inputs-card${isMobile ? " mobile-top-search-panel" : ""}`}
          dir={isRTL ? "rtl" : "ltr"}
          // Mirror the sidebar's route-state on the portaled top card so
          // App.css can hide the card during active navigation (the
          // turn-by-turn NavigationBanner needs the viewport top edge).
          // The card stays visible in `idle` and `preview` phases.
          data-route-state={mobileRouteState}
        >
          <SectionHeader titleKey="destination" icon="📍" />

          {/* FROM */}
          <div style={{ marginBottom: 12 }}>
            <span style={S.label}>{t("from")}</span>
            <div ref={fromContainerRef} style={{ position: "relative" }}>
              {/* Leading blue dot icon */}
              <span style={{ ...leadingIconStyle, color: "#0EA5E9" }}>●</span>

              <input
                type="text"
                placeholder={t("fromPlaceholder")}
                value={fromText}
                onChange={(e) => handleFromInput(e.target.value)}
                onFocus={(e) => {
                  e.currentTarget.style.borderColor =
                    "rgba(0, 200, 255, 0.50)";
                  e.currentTarget.style.boxShadow =
                    "inset 0 1px 4px rgba(0,0,0,0.38), 0 0 0 2.5px rgba(0,200,255,0.28), 0 0 14px rgba(0,180,255,0.12)";
                  e.currentTarget.style.background = "rgba(2, 10, 28, 0.72)";
                  setFromFieldFocused(true);
                  if (fromSuggestions.length > 0)
                    setShowFromSuggestions(true);
                }}
                onBlur={(e) => {
                  e.currentTarget.style.borderColor =
                    "rgba(255, 255, 255, 0.07)";
                  e.currentTarget.style.boxShadow = "inset 0 1px 4px rgba(0,0,0,0.38)";
                  e.currentTarget.style.background = "rgba(2, 8, 24, 0.60)";
                  setTimeout(() => {
                    setShowFromSuggestions(false);
                    setFromFieldFocused(false);
                  }, 160);
                }}
                style={inputStyle}
              />

              {/* GPS / current location button */}
              <button
                onClick={handleUseCurrentLocation}
                title={t("currentLocation")}
                style={{
                  ...trailingBtnStyle,
                  color: fromLocating ? "#0EA5E9" : "#475569",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = "#0EA5E9";
                  e.currentTarget.style.background =
                    "rgba(14, 165, 233, 0.12)";
                }}
                onMouseLeave={(e) => {
                  if (!fromLocating) {
                    e.currentTarget.style.color = "#475569";
                    e.currentTarget.style.background = "transparent";
                  }
                }}
              >
                {fromLocating ? (
                  <span
                    style={{
                      fontSize: 13,
                      display: "inline-block",
                      animation: "spinCenter 1s linear infinite",
                    }}
                  >
                    ⟳
                  </span>
                ) : (
                  <GpsIcon size={15} />
                )}
              </button>

              {fromSearchLoading && !fromLocating && (
                <span style={trailingSpinnerStyle}>⟳</span>
              )}

              {/* Rendered via portal so sidebar overflow:auto does not clip it */}
              <SearchDropdownPortal
                suggestions={fromSuggestions}
                onSelect={handleFromSuggestionSelect}
                isRTL={isRTL}
                anchorRef={fromContainerRef}
                show={showFromSuggestions && fromSuggestions.length > 0}
                showUseLocation={fromFieldFocused && fromText.trim().length < 2}
                onUseLocation={() => {
                  setFromFieldFocused(false);
                  handleUseCurrentLocation();
                }}
              />
            </div>

            {/* GPS permission error — shown when the user denies location access */}
            {gpsPermissionDenied && (
              <div
                style={{
                  marginTop: 7,
                  padding: "9px 12px",
                  background: "rgba(45, 24, 6, 0.80)",
                  border: "1px solid rgba(245, 158, 11, 0.40)",
                  borderRadius: 10,
                  fontSize: 11,
                  color: "#FDE68A",
                  lineHeight: 1.65,
                  display: "flex",
                  gap: 8,
                  alignItems: "flex-start",
                }}
              >
                <span style={{ flexShrink: 0, fontSize: 13 }}>📍</span>
                <span>
                  نحتاج صلاحية الموقع للعمل بشكل صحيح، أو يمكنك تحديد موقعك يدوياً على الخريطة.
                </span>
              </div>
            )}

            {/* Map-click hint when From is empty */}
            {!fromText && !startCoords && !gpsPermissionDenied && (
              <div
                style={{
                  marginTop: 5,
                  fontSize: 10,
                  color: "#334155",
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                }}
              >
                <span>🖱</span>
                {clickMode === "start"
                  ? t("nextMapClickStart")
                  : ""}
              </div>
            )}
          </div>

          {/* ── Swap (From ↔ To) ─────────────────────────────────────────
           * Small circular icon button that reverses the planned trip
           * direction in one tap — mirrors the swap affordance on Google
           * Maps mobile.  Always rendered (desktop + mobile) so the
           * interaction is consistent across breakpoints.
           */}
          <div className="dest-swap-row">
            <button
              type="button"
              onClick={handleSwapLocations}
              aria-label={isRTL ? "تبديل البداية والوجهة" : "Swap start and destination"}
              title={isRTL ? "تبديل البداية والوجهة" : "Swap"}
              className="dest-swap-btn"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M7 10V4M7 4l-3 3M7 4l3 3" />
                <path d="M17 14v6m0 0l-3-3m3 3l3-3" />
              </svg>
            </button>
          </div>

          {/* TO */}
          <div>
            <span style={S.label}>{t("to")}</span>
            <div ref={toContainerRef} style={{ position: "relative" }}>
              {/* Leading destination pin icon */}
              <span
                style={{
                  ...leadingIconStyle,
                  filter: "drop-shadow(0 0 4px #EF4444)",
                }}
              >
                📍
              </span>

              <input
                type="text"
                placeholder={t("searchPlaceholder")}
                value={destinationText}
                onChange={(e) => handleToInput(e.target.value)}
                onFocus={(e) => {
                  e.currentTarget.style.borderColor =
                    "rgba(0, 200, 255, 0.50)";
                  e.currentTarget.style.boxShadow =
                    "inset 0 1px 4px rgba(0,0,0,0.38), 0 0 0 2.5px rgba(0,200,255,0.28), 0 0 14px rgba(0,180,255,0.12)";
                  e.currentTarget.style.background = "rgba(2, 10, 28, 0.72)";
                  if (toSuggestions.length > 0) setShowToSuggestions(true);
                }}
                onBlur={(e) => {
                  e.currentTarget.style.borderColor =
                    "rgba(255, 255, 255, 0.07)";
                  e.currentTarget.style.boxShadow = "inset 0 1px 4px rgba(0,0,0,0.38)";
                  e.currentTarget.style.background = "rgba(2, 8, 24, 0.60)";
                  setTimeout(() => setShowToSuggestions(false), 160);
                }}
                style={inputStyle}
              />

              {toSearchLoading && (
                <span style={trailingSpinnerStyle}>⟳</span>
              )}

              {/* Rendered via portal so sidebar overflow:auto does not clip it */}
              <SearchDropdownPortal
                suggestions={toSuggestions}
                onSelect={handleToSuggestionSelect}
                isRTL={isRTL}
                anchorRef={toContainerRef}
                show={showToSuggestions && toSuggestions.length > 0}
              />
            </div>

            {endCoords && !showToSuggestions && (
              <div
                style={{
                  marginTop: 7,
                  padding: "8px 12px",
                  background: "rgba(2, 8, 23, 0.65)",
                  borderRadius: 10,
                  fontSize: 11,
                  color: "#94A3B8",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  border: "1px solid rgba(255, 255, 255, 0.07)",
                }}
              >
                <span
                  style={{
                    fontSize: 14,
                    flexShrink: 0,
                    filter: "drop-shadow(0 0 4px #EF4444)",
                  }}
                >
                  🔴
                </span>
                <span>{formatCoords(endCoords)}</span>
              </div>
            )}
          </div>

          <div style={{ marginTop: 6, fontSize: 10, color: "#334155" }}>
            {clickMode === "destination" ? t("nextMapClickDest") : ""}
          </div>

          {/* ── Mobile-only: primary "Find Best Route" CTA inside the
           *    floating top card ─────────────────────────────────────────
           * The card hosts the FROM / TO inputs; placing the recommend-
           * route action immediately below those inputs keeps the entire
           * "where do you want to go and let's calculate" workflow inside
           * one floating panel — exactly mirroring the Google-Maps-style
           * top search bar.  The button is rendered ONLY on mobile during
           * the idle phase.  Once a route is calculated (preview /
           * navigating), the bottom sheet takes over with the route
           * summary card and the big green "انطلق" CTA, so showing this
           * CTA twice would be confusing.
           *
           * Desktop (>768 px) keeps its original CTA row at the bottom of
           * the sidebar — `isMobile` gates the rendering so the desktop
           * tree is untouched.
           */}
          {isMobile && mobileRouteState === "idle" && (
            <div
              className="mobile-top-cta-row"
              style={{ position: "relative", zIndex: 2, pointerEvents: "auto" }}
            >
              <button
                type="button"
                onClick={handleSuggestRouteClick}
                disabled={routeLoading}
                className="mobile-top-cta-primary"
                aria-label={t("recommendRoute")}
                style={{
                  touchAction: "manipulation",
                  WebkitTapHighlightColor: "transparent",
                  pointerEvents: "auto",
                  cursor: "pointer",
                }}
              >
                {routeLoading ? (
                  <span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ animation: "spinCenter 0.85s linear infinite", flexShrink: 0 }}>
                      <circle cx="12" cy="12" r="9" stroke="rgba(255,255,255,0.25)" strokeWidth="2.5" />
                      <path d="M12 3a9 9 0 0 1 9 9" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" />
                    </svg>
                    {t("calculating")}
                  </span>
                ) : (
                  <>
                    <span style={{ marginInlineEnd: 8 }}>🧭</span>
                    {t("recommendRoute")}
                  </>
                )}
              </button>
            </div>
          )}
        </div>
          );
          // Portal-on-mobile so a transformed sidebar ancestor cannot capture
          // the panel's `position: fixed` containing block.  Falls back to the
          // inline desktop rendering when document.body is unavailable (e.g.
          // during the very first SSR pass).
          if (isMobile && typeof document !== "undefined" && document.body) {
            return createPortal(destinationCard, document.body);
          }
          return destinationCard;
        })()}

        {/* ── Mobile Route Summary Card (Phase 2) ─────────────────────────
         * Compact "estimated time + distance" card surfaced only on mobile
         * once a route has been calculated.  Replaces the verbose desktop
         * "Route Information" card inside the unified bottom-sheet so the
         * driver sees the two numbers that matter — ETA and distance — at
         * a glance, large and clear.  Hidden on desktop and during the
         * idle state by App.css selectors keyed off [data-route-state].
         */}
        {recommendedRoute && (
          <div
            className="mobile-route-summary-card"
            style={{
              display: "none",
              padding: "12px 14px",
              background:
                "linear-gradient(135deg, rgba(15, 23, 42, 0.85), rgba(2, 8, 24, 0.85))",
              border: "1px solid rgba(96, 165, 250, 0.22)",
              borderRadius: 14,
              boxShadow:
                "0 4px 20px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.04)",
            }}
          >
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 10,
                alignItems: "center",
              }}
            >
              <div style={{ textAlign: isRTL ? "right" : "left" }}>
                <div
                  style={{
                    fontSize: 9,
                    color: "#64748B",
                    letterSpacing: "1px",
                    textTransform: "uppercase",
                    fontWeight: 700,
                    marginBottom: 4,
                  }}
                >
                  {t("min")}
                </div>
                <div
                  style={{
                    fontSize: 26,
                    fontWeight: 800,
                    color: "#F1F5F9",
                    lineHeight: 1,
                    letterSpacing: "-0.5px",
                  }}
                >
                  {recommendedRoute.travelTime ?? "—"}
                </div>
              </div>
              <div style={{ textAlign: isRTL ? "left" : "right" }}>
                <div
                  style={{
                    fontSize: 9,
                    color: "#64748B",
                    letterSpacing: "1px",
                    textTransform: "uppercase",
                    fontWeight: 700,
                    marginBottom: 4,
                  }}
                >
                  {t("km")}
                </div>
                <div
                  style={{
                    fontSize: 26,
                    fontWeight: 800,
                    color: "#F1F5F9",
                    lineHeight: 1,
                    letterSpacing: "-0.5px",
                  }}
                >
                  {recommendedRoute.distance ?? "—"}
                </div>
              </div>
            </div>
            {recommendedRoute.trafficLevel && (
              <div
                style={{
                  marginTop: 10,
                  paddingTop: 10,
                  borderTop: "1px solid rgba(255,255,255,0.06)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <span style={{ fontSize: 11, color: "#94A3B8", fontWeight: 600 }}>
                  {t("trafficLevel")}
                </span>
                <TrafficBadge level={recommendedRoute.trafficLevel} />
              </div>
            )}
          </div>
        )}

        {/* ── Route Controls (state-aware primary CTA) ───────────────────
         * On mobile, this single row drives all three phases of the route
         * lifecycle (idle / preview / navigating) so the user never sees
         * two stacked floating panels with competing CTAs.  Desktop layout
         * is unaffected because the row keeps its previous flex shape
         * (controlled via App.css selectors).
         *
         *   idle        → "اقترح الطريق" — onRecommendRoute
         *   preview     → "انطلق"        — onStartNavigation (green pill)
         *   navigating  → "إنهاء الملاحة" — onExitNavigation (red pill)
         */}
        <div
          className="mobile-bottom-cta-row"
          data-route-state={mobileRouteState}
          style={{ display: "flex", gap: 9 }}
        >
          {mobileRouteState === "idle" && (
            <button
              onClick={handleSuggestRouteClick}
              disabled={routeLoading}
              className="mobile-cta-primary"
              style={{
                ...S.btnPrimary,
                opacity: routeLoading ? 0.65 : 1,
                cursor: routeLoading ? "not-allowed" : "pointer",
                touchAction: "manipulation",
                WebkitTapHighlightColor: "transparent",
                pointerEvents: routeLoading ? "none" : "auto",
              }}
              onMouseEnter={(e) => {
                if (!routeLoading) {
                  e.currentTarget.style.boxShadow =
                    "0 8px 24px rgba(37, 99, 235, 0.55)";
                  e.currentTarget.style.background =
                    "linear-gradient(135deg, #1D4ED8, #2563EB)";
                }
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.boxShadow =
                  "0 4px 16px rgba(37, 99, 235, 0.38)";
                e.currentTarget.style.background =
                  "linear-gradient(135deg, #2563EB, #3B82F6)";
              }}
            >
              {routeLoading ? (
                <span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ animation: "spinCenter 0.85s linear infinite", flexShrink: 0 }}>
                    <circle cx="12" cy="12" r="9" stroke="rgba(255,255,255,0.25)" strokeWidth="2.5" />
                    <path d="M12 3a9 9 0 0 1 9 9" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" />
                  </svg>
                  {t("calculating")}
                </span>
              ) : (
                `🧭 ${t("recommendRoute")}`
              )}
            </button>
          )}

          {mobileRouteState === "preview" && (
            <button
              onClick={onStartNavigation}
              className="mobile-cta-primary mobile-cta-start glow-cyan"
              aria-label="Start navigation"
              style={{
                ...S.btnPrimary,
                background: "linear-gradient(135deg, #047857, #10B981)",
                boxShadow: "0 4px 18px rgba(16, 185, 129, 0.45)",
                letterSpacing: "0.4px",
                textTransform: "uppercase",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.boxShadow =
                  "0 8px 28px rgba(16, 185, 129, 0.55)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.boxShadow =
                  "0 4px 18px rgba(16, 185, 129, 0.45)";
              }}
            >
              <span style={{ marginInlineEnd: 8 }}>🧭</span>
              انطلق
            </button>
          )}

          {mobileRouteState === "navigating" && (
            <button
              onClick={onExitNavigation}
              className="mobile-cta-primary mobile-cta-exit"
              aria-label="Exit navigation"
              style={{
                ...S.btnPrimary,
                background: "linear-gradient(135deg, #7F1D1D, #EF4444)",
                boxShadow: "0 4px 18px rgba(239, 68, 68, 0.45)",
                letterSpacing: "0.4px",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.boxShadow =
                  "0 8px 28px rgba(239, 68, 68, 0.55)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.boxShadow =
                  "0 4px 18px rgba(239, 68, 68, 0.45)";
              }}
            >
              <span style={{ marginInlineEnd: 8 }}>✕</span>
              إنهاء الملاحة
            </button>
          )}

          {/* Secondary "Clear / Cancel route" — hidden during active
           * navigation so the user cannot accidentally drop the route while
           * driving (exit must come from the dedicated red exit CTA). */}
          {mobileRouteState !== "navigating" && (
            <button
              onClick={handleClear}
              className="mobile-cta-clear"
              style={S.btnSecondary}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "rgba(71, 85, 105, 0.80)";
                e.currentTarget.style.color = "#CBD5E1";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "rgba(51, 65, 85, 0.60)";
                e.currentTarget.style.color = "#94A3B8";
              }}
            >
              {t("clearRoute")}
            </button>
          )}
        </div>

        {routeError && (
          <div
            style={{
              padding: "10px 13px",
              background: "rgba(69, 10, 10, 0.70)",
              border: "1px solid rgba(239, 68, 68, 0.45)",
              borderRadius: 12,
              color: "#FCA5A5",
              fontSize: 12,
              display: "flex",
              gap: 8,
              alignItems: "flex-start",
            }}
          >
            <span style={{ flexShrink: 0 }}>⚠</span>
            <span>{routeError}</span>
          </div>
        )}

        {/* ── Metro Alternative (Feature 5) — fades with map toast timer ─── */}
        {metroAlternative && !metroDismissed && (
          <div
            style={{
              opacity: metroBannerFading ? 0 : 1,
              transition: `opacity ${SIDEBAR_ALERT_FADE_MS}ms ease-out`,
            }}
          >
            <MetroSuggestionCard
              metro={metroAlternative}
              routeVisible={metroRouteVisible}
              onToggleRoute={onMetroToggleRoute}
              onDismiss={onMetroDismiss}
              isRTL={isRTL}
              t={t}
            />
          </div>
        )}

        {/* ── Route Comparison (Feature 3) ──────────────────────────────── */}
        {allRoutes.length > 1 && (
          <div style={S.card}>
            <SectionHeader titleKey="routeCompare" icon="🗺" />
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {allRoutes.map((route, index) => {
                const numberEmojis = ["1️⃣", "2️⃣", "3️⃣", "4️⃣"];
                const isActive = index === activeRouteIndex;
                return (
                  <div key={index} style={{ position: "relative" }}>
                    {/* Numbered badge */}
                    <div
                      style={{
                        position: "absolute",
                        top: 8,
                        [isRTL ? "left" : "right"]: -2,
                        zIndex: 2,
                        fontSize: 14,
                        lineHeight: 1,
                        filter: isActive ? "none" : "grayscale(40%) opacity(0.7)",
                      }}
                    >
                      {numberEmojis[index] || `${index + 1}.`}
                    </div>

                    <RouteOptionRow
                      route={route}
                      isActive={isActive}
                      onSelect={() => onRouteSelect(index)}
                      closureAvoided={closureAvoidedPerRoute?.[index] ?? false}
                    />
                  </div>
                );
              })}
            </div>
            <div
              style={{
                marginTop: 8,
                fontSize: 10,
                color: "#334155",
                textAlign: "center",
              }}
            >
              {t("clickSwitchRoute")}
            </div>
          </div>
        )}

        {/* ── Route Information ─────────────────────────────────────────── */}
        {recommendedRoute && (
          <div style={S.card}>
            <SectionHeader titleKey="routeInfo" icon="📊" />

            {recommendedRoute.label && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 12,
                }}
              >
                <div
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: "50%",
                    background: recommendedRoute.color || "#2563EB",
                    flexShrink: 0,
                  }}
                />
                <span
                  style={{ fontSize: 13, fontWeight: 700, color: "#E2E8F0" }}
                >
                  {recommendedRoute.label}
                </span>
                {recommendedRoute.isRecommended && (
                  <span
                    style={{
                      fontSize: 9,
                      background: "#1D4ED8",
                      color: "#BFDBFE",
                      padding: "2px 6px",
                      borderRadius: 4,
                      fontWeight: 700,
                      letterSpacing: "0.5px",
                      textTransform: "uppercase",
                    }}
                  >
                    {t("recommended").toUpperCase()}
                  </span>
                )}
              </div>
            )}

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 8,
                marginBottom: 12,
              }}
            >
              <StatCard value={recommendedRoute.distance} unitKey="km" />
              <StatCard value={recommendedRoute.travelTime} unitKey="min" />
            </div>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 8,
              }}
            >
              <span style={{ fontSize: 12, color: "#94A3B8" }}>
                {t("trafficLevel")}
              </span>
              <TrafficBadge level={recommendedRoute.trafficLevel} />
            </div>

            {prediction && predictionLevel && (
              <div
                style={{
                  marginTop: 6,
                  padding: "9px 12px",
                  background: "rgba(2, 8, 23, 0.65)",
                  borderRadius: 10,
                  border: "1px solid rgba(255, 255, 255, 0.07)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <span style={{ fontSize: 11, color: "#64748B" }}>
                  {t("next30min")}
                </span>
                <TrafficBadge level={predictionLevel} />
              </div>
            )}

            {recommendedRoute.trafficDelay > 0 && (
              <div
                style={{
                  marginTop: 8,
                  padding: "9px 12px",
                  background: "rgba(66, 32, 6, 0.70)",
                  border: "1px solid rgba(249, 115, 22, 0.45)",
                  borderRadius: 10,
                  fontSize: 12,
                  color: "#FED7AA",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span>⏱</span>
                +{recommendedRoute.trafficDelay} {t("minDelay")}
              </div>
            )}

            {recommendedRoute.source === "synthetic" && (
              <div
                style={{
                  marginTop: 8,
                  fontSize: 10,
                  color: "#475569",
                  fontStyle: "italic",
                }}
              >
                ℹ {t("estimatedPath")}
              </div>
            )}
          </div>
        )}

        {/* ── Smart Analytics (Cost, Arrival Guarantee, Parking) ────────── */}
        {recommendedRoute && (
          <SmartAnalyticsCard
            recommendedRoute={recommendedRoute}
            destinationText={destinationText}
          />
        )}

        {/* ── Traffic Prediction ──────────────────────────────────────────
         * `mobile-bottom-traffic-card` flags this as Row 1 of the mobile
         * bottom sheet — the prediction-score gauge + departure-advice line
         * stay inside the panel; the noisier sub-controls collapse on
         * mobile via App.css selectors.
         */}
        <div style={S.card} className="mobile-bottom-traffic-card">
          <SectionHeader titleKey="trafficPrediction" icon="🔮" />

          {predictionLoading ? (
            <div
              style={{
                color: "#64748B",
                fontSize: 12,
                textAlign: "center",
                padding: "12px 0",
              }}
            >
              {t("analyzingPatterns")}
            </div>
          ) : prediction ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {/* Score gauge + level badge */}
              <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                <div style={{ flexShrink: 0 }}>
                  <PredictionScoreGauge score={prediction.predictionScore} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: "#94A3B8", marginBottom: 6 }}>
                    {t("next30min")}
                  </div>
                  {predictionLevel && (
                    <TrafficBadge level={predictionLevel} />
                  )}
                  <div style={{ fontSize: 10, color: "#475569", marginTop: 6 }}>
                    {t("liveTrafficTitle")}
                  </div>
                </div>
              </div>

              {/* Departure advice card — always visible when prediction exists */}
              {predictionLevel && (
                <DepartureSuggestion level={predictionLevel} t={t} />
              )}

              {confidencePct !== null && (
                <ProgressBar
                  value={confidencePct}
                  label={t("predictionConfidence")}
                />
              )}

              {/* Feature 1: Smart Departure suggestion button */}
              {onRequestSmartDeparture && (
                <button
                  onClick={onRequestSmartDeparture}
                  style={{
                    width: "100%",
                    padding: "11px 14px",
                    background: smartDeparturePanelVisible
                      ? "linear-gradient(135deg, #065F46, #059669)"
                      : "linear-gradient(135deg, rgba(5, 46, 22, 0.80), rgba(6, 78, 59, 0.80))",
                    border: smartDeparturePanelVisible
                      ? "1px solid #22C55E"
                      : "1px solid rgba(34, 197, 94, 0.30)",
                    borderRadius: 12,
                    color: smartDeparturePanelVisible ? "#DCFCE7" : "#86EFAC",
                    cursor: "pointer",
                    fontWeight: 700,
                    fontSize: 12,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 7,
                    transition: "all 0.2s ease",
                    fontFamily: "inherit",
                    boxShadow: smartDeparturePanelVisible
                      ? "0 4px 16px rgba(34, 197, 94, 0.30)"
                      : "none",
                  }}
                  onMouseEnter={(e) => {
                    if (!smartDeparturePanelVisible) {
                      e.currentTarget.style.background =
                        "linear-gradient(135deg, rgba(6, 78, 59, 0.95), rgba(5, 46, 22, 0.95))";
                      e.currentTarget.style.borderColor = "rgba(34, 197, 94, 0.55)";
                      e.currentTarget.style.transform = "translateY(-1px)";
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!smartDeparturePanelVisible) {
                      e.currentTarget.style.background =
                        "linear-gradient(135deg, rgba(5, 46, 22, 0.80), rgba(6, 78, 59, 0.80))";
                      e.currentTarget.style.borderColor = "rgba(34, 197, 94, 0.30)";
                      e.currentTarget.style.transform = "translateY(0)";
                    }
                  }}
                >
                  <span style={{ fontSize: 14 }}>🕐</span>
                  {t("smartDepartureBtn")}
                </button>
              )}

              {smartDeparturePanelVisible &&
                departureRecommendation &&
                onCloseSmartDeparturePanel && (
                  <div
                    style={{
                      opacity: smartDetailFading ? 0 : 1,
                      transition: `opacity ${SIDEBAR_ALERT_FADE_MS}ms ease-out`,
                    }}
                  >
                    <SmartDepartureDetailPanel
                      recommendation={departureRecommendation}
                      onDismiss={onCloseSmartDeparturePanel}
                      t={t}
                    />
                  </div>
                )}
            </div>
          ) : (
            <div
              style={{
                color: "#475569",
                fontSize: 12,
                textAlign: "center",
                padding: "8px 0",
              }}
            >
              {t("clickMapForPrediction")}
            </div>
          )}
        </div>

        {/* ── Traffic Simulation (Feature 4) ─────────────────────────────
         * `mobile-bottom-sim-btn` is the CSS hook that re-enables this
         * button on mobile (the default `display:none` rule on every
         * `.sidebar-main-content` child suppresses it otherwise).  The
         * 60-minute simulation is one of the three features that MUST
         * remain reachable from the idle bottom sheet.
         */}
        {onSimulateTraffic && (
          <button
            onClick={simulationActive ? onStopSimulation : onSimulateTraffic}
            className="mobile-bottom-sim-btn"
            style={{
              width: "100%",
              padding: "13px 14px",
              background: simulationActive
                ? "linear-gradient(135deg, rgba(99, 102, 241, 0.30), rgba(139, 92, 246, 0.30))"
                : "linear-gradient(135deg, rgba(17, 24, 39, 0.85), rgba(30, 41, 59, 0.85))",
              border: simulationActive
                ? "1px solid rgba(139, 92, 246, 0.65)"
                : "1px solid rgba(99, 102, 241, 0.30)",
              borderRadius: 13,
              color: simulationActive ? "#C4B5FD" : "#818CF8",
              cursor: "pointer",
              fontWeight: 700,
              fontSize: 12,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              transition: "all 0.2s ease",
              fontFamily: "inherit",
              boxShadow: simulationActive ? "0 4px 18px rgba(99, 102, 241, 0.25)" : "none",
              letterSpacing: "0.2px",
            }}
            onMouseEnter={(e) => {
              if (!simulationActive) {
                e.currentTarget.style.background =
                  "linear-gradient(135deg, rgba(99, 102, 241, 0.20), rgba(139, 92, 246, 0.20))";
                e.currentTarget.style.borderColor = "rgba(99, 102, 241, 0.55)";
                e.currentTarget.style.transform = "translateY(-1px)";
              }
            }}
            onMouseLeave={(e) => {
              if (!simulationActive) {
                e.currentTarget.style.background =
                  "linear-gradient(135deg, rgba(17, 24, 39, 0.85), rgba(30, 41, 59, 0.85))";
                e.currentTarget.style.borderColor = "rgba(99, 102, 241, 0.30)";
                e.currentTarget.style.transform = "translateY(0)";
              }
            }}
          >
            <span style={{ fontSize: 15 }}>{simulationActive ? "⏹" : "🎬"}</span>
            {simulationActive ? t("stopSimulation") : t("simulateBtn")}
            {simulationActive && (
              <span
                style={{
                  display: "inline-block",
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: "#8B5CF6",
                  animation: "simulationPulse 1.2s ease-in-out infinite",
                  boxShadow: "0 0 6px #8B5CF6",
                }}
              />
            )}
          </button>
        )}

        {/* ── Alerts (Incidents) ────────────────────────────────────────── */}
        {incidents && incidents.length > 0 && (
          <div style={S.card}>
            <SectionHeader titleKey="alerts" icon="🚨" />
            <div
              style={{
                fontSize: 10,
                color: "#64748B",
                marginBottom: 8,
                marginTop: -6,
              }}
            >
              {incidents.length} {t("alerts").toLowerCase()}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {incidents.map((incident) => {
                const cfg = INCIDENT_CONFIG[incident.type] || {
                  icon: "⚠️",
                  borderColor: "#EF4444",
                };
                const typeKey =
                  incident.type === "accident"
                    ? "accident"
                    : incident.type === "road closure"
                    ? "roadClosure"
                    : incident.type === "heavy traffic"
                    ? "heavyTraffic"
                    : incident.type === "rain"
                    ? "rainAlert"
                    : "hazard";
                return (
                  <div
                    key={
                      incident.id ?? `${incident.type}-${incident.lat}`
                    }
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "10px 12px",
                      background: "rgba(2, 8, 23, 0.65)",
                      borderRadius: 12,
                      border: `1px solid rgba(255,255,255,0.06)`,
                      borderLeft: `3px solid ${cfg.borderColor}`,
                    }}
                  >
                    <span style={{ fontSize: 17, flexShrink: 0 }}>
                      {cfg.icon}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 13,
                          fontWeight: 600,
                          color: "#E2E8F0",
                          textTransform: "capitalize",
                        }}
                      >
                        {t(typeKey)}
                      </div>
                      {incident.message && (
                        <div
                          style={{
                            fontSize: 11,
                            color: "#64748B",
                            marginTop: 2,
                            lineHeight: 1.55,
                            wordBreak: "break-word",
                          }}
                        >
                          {incident.message}
                        </div>
                      )}
                    </div>
                    {incident.severity && (
                      <span
                        style={{
                          fontSize: 9,
                          fontWeight: 700,
                          color: cfg.borderColor,
                          textTransform: "uppercase",
                          letterSpacing: "0.5px",
                          flexShrink: 0,
                        }}
                      >
                        {incident.severity}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
      )}

      {/* ── Footer ──────────────────────────────────────────────────────── */}
      <div style={S.footer}>
        {lastUpdated && (
          <div
            style={{
              fontSize: 11,
              color: "#475569",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span style={{ fontSize: 12 }}>🔄</span>
            <span>
              {t("updated")} {new Date(lastUpdated).toLocaleTimeString()}
            </span>
          </div>
        )}
        {error && (
          <div
            style={{
              fontSize: 11,
              color: "#EF4444",
              marginTop: 5,
              display: "flex",
              gap: 6,
            }}
          >
            <span>⚠</span>
            <span>{error}</span>
          </div>
        )}
      </div>

      {/* ── API Error Toast ────────────────────────────────────────────────
       * Portaled to document.body so it floats above ALL other surfaces
       * (search panel, bottom sheet, navigation banner).  Appears whenever
       * /api/search-places returns 429 / 5xx or a network/CORS error.
       */}
      {apiErrorToastVisible &&
        createPortal(
          <div
            role="alert"
            aria-live="assertive"
            style={{
              position: "fixed",
              bottom: "max(90px, calc(env(safe-area-inset-bottom, 0px) + 90px))",
              left: "50%",
              transform: "translateX(-50%)",
              zIndex: 99999,
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "12px 20px",
              borderRadius: 16,
              background: "linear-gradient(135deg, rgba(30, 10, 10, 0.96) 0%, rgba(50, 12, 12, 0.96) 100%)",
              backdropFilter: "blur(24px)",
              WebkitBackdropFilter: "blur(24px)",
              border: "1px solid rgba(239, 68, 68, 0.35)",
              boxShadow:
                "0 8px 32px rgba(239, 68, 68, 0.28), 0 2px 8px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.05)",
              maxWidth: "calc(100vw - 32px)",
              whiteSpace: "normal",
              animation: "apiToastSlideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1) both",
            }}
          >
            <span style={{ fontSize: 20, flexShrink: 0 }}>⚠️</span>
            <span
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: "#FCA5A5",
                lineHeight: 1.45,
                direction: "rtl",
                fontFamily: "'Segoe UI', system-ui, Arial, sans-serif",
              }}
            >
              السيرفر عليه ضغط حالياً، يرجى المحاولة مرة أخرى بعد قليل
            </span>
            <button
              onClick={() => {
                clearTimeout(apiErrorToastTimerRef.current);
                setApiErrorToastVisible(false);
              }}
              aria-label="إغلاق"
              style={{
                background: "none",
                border: "none",
                color: "#94A3B8",
                cursor: "pointer",
                fontSize: 16,
                flexShrink: 0,
                padding: "2px 4px",
                lineHeight: 1,
              }}
            >
              ✕
            </button>
          </div>,
          document.body
        )}

      {/* ── Validation Toast ────────────────────────────────────────────────
       * Blue floating pill shown when the user taps "اقترح الطريق" without
       * a destination set.  Portaled to document.body so it floats above
       * all surfaces (search panel, bottom sheet, navigation banner).
       * Auto-dismisses after 4 s; the ✕ button dismisses it immediately.
       */}
      {validationToastMsg &&
        createPortal(
          <div
            role="alert"
            aria-live="assertive"
            style={{
              position: "fixed",
              bottom: "max(90px, calc(env(safe-area-inset-bottom, 0px) + 90px))",
              left: "50%",
              transform: "translateX(-50%)",
              zIndex: 99999,
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "12px 20px",
              borderRadius: 16,
              background:
                "linear-gradient(135deg, rgba(10, 20, 50, 0.97) 0%, rgba(14, 26, 56, 0.97) 100%)",
              backdropFilter: "blur(24px)",
              WebkitBackdropFilter: "blur(24px)",
              border: "1px solid rgba(96, 165, 250, 0.35)",
              boxShadow:
                "0 8px 32px rgba(37, 99, 235, 0.28), 0 2px 8px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.05)",
              maxWidth: "calc(100vw - 32px)",
              whiteSpace: "normal",
              animation: "apiToastSlideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1) both",
            }}
          >
            <span style={{ fontSize: 20, flexShrink: 0 }}>📍</span>
            <span
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: "#BAE6FD",
                lineHeight: 1.45,
                direction: "rtl",
                fontFamily: "'Segoe UI', system-ui, Arial, sans-serif",
              }}
            >
              {validationToastMsg}
            </span>
            <button
              onClick={() => {
                clearTimeout(validationToastTimerRef.current);
                setValidationToastMsg(null);
              }}
              aria-label="إغلاق"
              style={{
                background: "none",
                border: "none",
                color: "#94A3B8",
                cursor: "pointer",
                fontSize: 16,
                flexShrink: 0,
                padding: "2px 4px",
                lineHeight: 1,
              }}
            >
              ✕
            </button>
          </div>,
          document.body
        )}
    </aside>
  );
};

export default Sidebar;
