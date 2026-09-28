import React, { useState, useMemo, useEffect } from "react";
import { useLanguage } from "../LanguageContext";

// ─── Responsive breakpoint helper ─────────────────────────────────────────────
//
// Mirrors the breakpoint used throughout App.css so the panel is rendered in
// its compact "mobile dock" variant below 768 px WITHOUT introducing any
// desktop regression.  Uses window.matchMedia rather than a resize-listener
// fan-out — both cheaper and eliminates the need for a debounce.
const MOBILE_MEDIA_QUERY = "(max-width: 768px)";

const useIsMobile = () => {
  const [isMobile, setIsMobile] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia(MOBILE_MEDIA_QUERY).matches
  );

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return undefined;
    }
    const mql = window.matchMedia(MOBILE_MEDIA_QUERY);
    const handler = (event) => setIsMobile(event.matches);
    // Modern browsers use addEventListener; Safari < 14 needs addListener.
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", handler);
      return () => mql.removeEventListener("change", handler);
    }
    mql.addListener(handler);
    return () => mql.removeListener(handler);
  }, []);

  return isMobile;
};

// ─── Color maps ───────────────────────────────────────────────────────────────

const LEVEL_COLOR = {
  high: "#EF4444",
  medium: "#F59E0B",
  low: "#22C55E",
};

const LEVEL_BG = {
  high: "#450A0A",
  medium: "#422006",
  low: "#052E16",
};

// ─── Forecast generation ──────────────────────────────────────────────────────

/**
 * Generates 5 forecast time slots (now, +15, +30, +45, +60 min) from a base
 * prediction score, applying a sine-wave variance to simulate natural change.
 */
const buildForecastSlots = (prediction) => {
  const baseScore = prediction?.predictionScore ?? 50;

  return [0, 15, 30, 45, 60].map((offsetMin) => {
    const variance = Math.round(Math.sin(offsetMin * 0.08) * 10);
    const score = Math.min(100, Math.max(5, baseScore + variance));
    const level = score >= 68 ? "high" : score >= 36 ? "medium" : "low";
    return { score, level, offsetMin };
  });
};

const getOffsetLabel = (offsetMin, t) => {
  if (offsetMin === 0) return t("nowLabel");
  return t("afterMinLabel").replace("{min}", offsetMin);
};

// ─── SVG mini line chart ──────────────────────────────────────────────────────

const ForecastChart = ({ slots, t }) => {
  const W = 210;
  const H = 72;
  const pad = { top: 8, right: 10, bottom: 22, left: 8 };
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;

  const toX = (i) => pad.left + (i / (slots.length - 1)) * innerW;
  const toY = (score) => pad.top + (1 - score / 100) * innerH;

  const points = slots.map((s, i) => ({ x: toX(i), y: toY(s.score), ...s }));
  const linePath = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(" ");

  const areaPath = [
    linePath,
    `L ${points[points.length - 1].x.toFixed(1)} ${(pad.top + innerH).toFixed(1)}`,
    `L ${points[0].x.toFixed(1)} ${(pad.top + innerH).toFixed(1)}`,
    "Z",
  ].join(" ");

  // Threshold guide lines at score 36 (medium) and 68 (high)
  const thresholds = [
    { score: 68, color: "#EF444430" },
    { score: 36, color: "#F59E0B30" },
  ];

  return (
    <svg
      width={W}
      height={H}
      aria-label="Traffic forecast chart"
      style={{ overflow: "visible" }}
    >
      <defs>
        <linearGradient id="forecastAreaGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#2563EB" stopOpacity="0.25" />
          <stop offset="100%" stopColor="#2563EB" stopOpacity="0.01" />
        </linearGradient>
      </defs>

      {/* Threshold reference lines */}
      {thresholds.map(({ score, color }) => (
        <line
          key={score}
          x1={pad.left}
          y1={toY(score)}
          x2={W - pad.right}
          y2={toY(score)}
          stroke={color}
          strokeWidth="1"
          strokeDasharray="3 3"
        />
      ))}

      {/* Area fill */}
      <path d={areaPath} fill="url(#forecastAreaGrad)" />

      {/* Main line */}
      <path
        d={linePath}
        fill="none"
        stroke="#3B82F6"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* Data points */}
      {points.map((p) => (
        <g key={p.offsetMin}>
          <circle cx={p.x} cy={p.y} r={4} fill={LEVEL_COLOR[p.level]} stroke="#0F172A" strokeWidth="1.5" />
        </g>
      ))}

      {/* X-axis relative time labels */}
      {points.map((p) => {
        const shortLabel = p.offsetMin === 0 ? t("nowLabel") : `+${p.offsetMin}`;
        return (
          <text
            key={`lbl-${p.offsetMin}`}
            x={p.x}
            y={H - 5}
            textAnchor="middle"
            fill="#475569"
            fontSize="8"
            fontFamily="'Segoe UI', system-ui, sans-serif"
          >
            {shortLabel}
          </text>
        );
      })}
    </svg>
  );
};

// ─── Traffic level badge row ──────────────────────────────────────────────────

const ForecastRow = ({ slot, t }) => {
  const levelLabels = { high: t("high"), medium: t("medium"), low: t("low") };
  const offsetLabel = getOffsetLabel(slot.offsetMin, t);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "7px 10px",
        borderRadius: 8,
        background: `${LEVEL_BG[slot.level]}bb`,
        border: `1px solid rgba(255,255,255,0.05)`,
        borderLeft: `3px solid ${LEVEL_COLOR[slot.level]}`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: LEVEL_COLOR[slot.level],
            flexShrink: 0,
            boxShadow: `0 0 5px ${LEVEL_COLOR[slot.level]}`,
          }}
        />
        <span style={{ fontSize: 11, color: "#94A3B8", fontVariantNumeric: "tabular-nums" }}>
          {offsetLabel}
        </span>
      </div>
      <span
        style={{
          fontSize: 10,
          fontWeight: 700,
          color: LEVEL_COLOR[slot.level],
          textTransform: "uppercase",
          letterSpacing: "0.6px",
        }}
      >
        {levelLabels[slot.level]}
      </span>
    </div>
  );
};

// ─── Confidence progress bar ──────────────────────────────────────────────────

const ConfidenceBar = ({ value, label }) => {
  const pct =
    typeof value === "string"
      ? parseInt(value, 10)
      : Math.round((value ?? 0) * 100);

  const barColor = pct >= 75 ? "#22C55E" : pct >= 50 ? "#F59E0B" : "#EF4444";

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontSize: 10, color: "#64748B" }}>{label}</span>
        <span style={{ fontSize: 10, fontWeight: 700, color: barColor }}>{pct}%</span>
      </div>
      <div style={{ height: 4, background: "rgba(30, 41, 59, 0.8)", borderRadius: 2, overflow: "hidden" }}>
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            background: barColor,
            borderRadius: 2,
            transition: "width 0.6s ease",
          }}
        />
      </div>
    </div>
  );
};

// ─── Main component ───────────────────────────────────────────────────────────

/**
 * Floating analytics panel rendered over the map.
 * Displays the current traffic level, a line chart forecast, and confidence.
 * Collapsible to minimise map obstruction.
 */
const AnalyticsDashboard = ({ prediction, isRTL }) => {
  const { t } = useLanguage();
  const isMobile = useIsMobile();
  // On mobile the panel is docked bottom-left and starts collapsed so the
  // user sees the map first — they can expand by tapping the header.
  // On desktop the panel defaults to expanded, matching the original UX.
  const [collapsed, setCollapsed] = useState(() => isMobile);

  const slots = useMemo(() => buildForecastSlots(prediction), [prediction]);

  const currentLevel =
    prediction?.predictedTrafficLevel || prediction?.predictedTraffic;

  const confidenceValue = prediction?.confidence;

  // Desktop position (unchanged): top-right (LTR) / top-left (RTL).
  // Mobile position: anchored bottom-left with CSS-only overrides (see App.css)
  // so this inline style stays byte-identical to the previous desktop layout.
  const position = isRTL
    ? { left: 20, right: "auto" }
    : { right: 20, left: "auto" };

  return (
    <div
      className="analytics-dashboard"
      data-ad-collapsed={collapsed ? "1" : "0"}
      style={{
        position: "absolute",
        top: 20,
        ...position,
        width: 252,
        background: "rgba(8, 15, 26, 0.82)",
        backdropFilter: "blur(22px)",
        WebkitBackdropFilter: "blur(22px)",
        borderRadius: 18,
        border: "1px solid rgba(255, 255, 255, 0.09)",
        boxShadow: "0 24px 56px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255,255,255,0.03) inset",
        zIndex: 1000,
        overflow: "hidden",
        fontFamily: "'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif",
        direction: isRTL ? "rtl" : "ltr",
      }}
    >
      {/* Panel header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "13px 16px",
          borderBottom: collapsed ? "none" : "1px solid rgba(255, 255, 255, 0.07)",
          cursor: "pointer",
          background: "rgba(2, 8, 20, 0.45)",
          transition: "background 0.2s",
        }}
        onClick={() => setCollapsed((c) => !c)}
        role="button"
        aria-expanded={!collapsed}
        aria-label="Toggle analytics panel"
        onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(37, 99, 235, 0.10)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "rgba(2, 8, 20, 0.45)")}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <span style={{ fontSize: 15 }}>📊</span>
          <span
            style={{
              fontSize: 10,
              fontWeight: 800,
              color: "#475569",
              textTransform: "uppercase",
              letterSpacing: "1.2px",
            }}
          >
            {t("analyticsDashboard")}
          </span>
        </div>
        <span style={{ fontSize: 13, color: "#475569", lineHeight: 1 }}>
          {collapsed ? "▾" : "▴"}
        </span>
      </div>

      {!collapsed && (
        <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 14 }}>

          {/* Current level */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: 11, color: "#64748B" }}>{t("currentLevel")}</span>
            {currentLevel ? (
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "4px 10px",
                  borderRadius: 12,
                  background: LEVEL_BG[currentLevel] || "#1E293B",
                  color: LEVEL_COLOR[currentLevel] || "#94A3B8",
                  border: `1px solid ${LEVEL_COLOR[currentLevel]}44` || "1px solid #334155",
                  fontSize: 10,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.6px",
                  boxShadow: `0 0 10px ${LEVEL_COLOR[currentLevel] || "#94A3B8"}22`,
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: LEVEL_COLOR[currentLevel] || "#94A3B8",
                    flexShrink: 0,
                    boxShadow: `0 0 5px ${LEVEL_COLOR[currentLevel] || "#94A3B8"}`,
                  }}
                />
                {t(currentLevel)}
              </span>
            ) : (
              <span style={{ fontSize: 10, color: "#334155" }}>—</span>
            )}
          </div>

          {/* Mini chart */}
          <div>
            <div
              style={{
                fontSize: 9,
                color: "#475569",
                marginBottom: 10,
                fontWeight: 800,
                textTransform: "uppercase",
                letterSpacing: "1.2px",
              }}
            >
              {t("trafficForecastHour")}
            </div>
            <ForecastChart slots={slots} t={t} />
          </div>

          {/* Forecast rows */}
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {slots.map((slot) => (
              <ForecastRow key={slot.offsetMin} slot={slot} t={t} />
            ))}
          </div>

          {/* Confidence bar */}
          {confidenceValue != null && (
            <ConfidenceBar value={confidenceValue} label={t("confidence")} />
          )}
        </div>
      )}
    </div>
  );
};

export default AnalyticsDashboard;
