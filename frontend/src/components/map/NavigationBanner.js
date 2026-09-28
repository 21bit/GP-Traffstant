/**
 * NavigationBanner — Fixed top-of-screen turn-by-turn guidance HUD.
 *
 * Appears only during active navigation (isNavigating === true).
 * Displays the current maneuver icon, the Arabic instruction text,
 * the distance remaining to the next maneuver, the step counter,
 * and a speaker/mute toggle for Arabic voice alerts.
 *
 * Design language intentionally matches NavigationControls.js:
 * glassmorphic panel, dark background, cyan/white accent colours.
 *
 * Props:
 *   instruction  { text, maneuver, routeOffsetInMeters } | null
 *   nextInstruction  { routeOffsetInMeters } | null  — used to compute distance-to-maneuver
 *   totalSteps   number
 *   currentStep  number (0-based)
 *   voiceEnabled boolean
 *   onToggleVoice () => void
 */

import React from "react";

// ─── Maneuver → icon mapping ──────────────────────────────────────────────────
//
// TomTom Routing API v1 returns maneuver as an uppercase string.
// We map each to a clear Unicode arrow so no image assets are needed.

const MANEUVER_ICON = {
  DEPART:           "🚦",
  ARRIVE:           "🏁",
  STRAIGHT:         "↑",
  KEEP_RIGHT:       "↗",
  KEEP_LEFT:        "↖",
  BEAR_RIGHT:       "↗",
  BEAR_LEFT:        "↖",
  TURN_RIGHT:       "↱",
  TURN_LEFT:        "↰",
  SHARP_RIGHT:      "↱",
  SHARP_LEFT:       "↰",
  U_TURN:           "↩",
  ROUNDABOUT_RIGHT: "↻",
  ROUNDABOUT_LEFT:  "↺",
  ROUNDABOUT_CROSS: "↻",
  TAKE_EXIT:        "↗",
  MOTORWAY_CHANGE:  "→",
  MOTORWAY_ENTER:   "↑",
  MOTORWAY_EXIT:    "↗",
  FOLLOW:           "↑",
};

const getManeuverIcon = (maneuver) =>
  MANEUVER_ICON[maneuver] ?? "↑";

// ─── Distance formatter ───────────────────────────────────────────────────────
//
// Formats a raw metre count as Arabic-digit strings:
//   < 1000 m  → "٣٠٠ م"
//   ≥ 1000 m  → "١.٢ كم"

const formatDistanceAr = (meters) => {
  if (!Number.isFinite(meters) || meters < 0) return "";
  if (meters < 1000) {
    // Round to nearest 50 m for clean display.
    const rounded = Math.round(meters / 50) * 50 || 50;
    return `${rounded.toLocaleString("ar-SA")} م`;
  }
  const km = (meters / 1000).toFixed(1);
  return `${parseFloat(km).toLocaleString("ar-SA", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} كم`;
};

// ─── Component ────────────────────────────────────────────────────────────────

const NavigationBanner = ({
  instruction,
  nextInstruction,
  totalSteps,
  currentStep,
  voiceEnabled,
  onToggleVoice,
}) => {
  if (!instruction) return null;

  const icon = getManeuverIcon(instruction.maneuver);

  // Distance to next maneuver = next step's cumulative offset − current step's offset.
  const distanceToNext =
    nextInstruction != null
      ? nextInstruction.routeOffsetInMeters - instruction.routeOffsetInMeters
      : null;

  const distanceLabel = distanceToNext != null ? formatDistanceAr(distanceToNext) : "";

  // "خطوة 3 من 14" step counter — uses Arabic-Indic digits automatically via ar-SA locale.
  const stepLabel = `خطوة ${(currentStep + 1).toLocaleString("ar-SA")} من ${totalSteps.toLocaleString("ar-SA")}`;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={`تعليمات الملاحة: ${instruction.text}`}
      className="nav-banner-root"
      style={{
        position:        "fixed",
        top:             0,
        left:            0,
        right:           0,
        zIndex:          1300,
        display:         "flex",
        justifyContent:  "center",
        pointerEvents:   "none",
        // Safe-area offset so banner clears notches / status bars on iOS
        paddingTop:      "max(0px, env(safe-area-inset-top))",
      }}
    >
      <div
        className="nav-banner-card"
        style={{
          width:              "100%",
          maxWidth:           520,
          margin:             "0 auto",
          pointerEvents:      "auto",
          background:         "rgba(6, 12, 28, 0.88)",
          backdropFilter:     "blur(22px)",
          WebkitBackdropFilter: "blur(22px)",
          borderBottom:       "1px solid rgba(0, 242, 255, 0.18)",
          boxShadow:          "0 4px 32px rgba(0,0,0,0.72), 0 1px 0 rgba(0,242,255,0.12) inset",
          padding:            "14px 18px 12px",
          display:            "flex",
          alignItems:         "center",
          gap:                14,
          direction:          "rtl",
        }}
      >
        {/* ── Maneuver icon ─────────────────────────────────────────────────── */}
        <div
          aria-hidden="true"
          className="nav-banner-icon"
          style={{
            flexShrink:     0,
            width:          52,
            height:         52,
            borderRadius:   14,
            background:     "rgba(0, 242, 255, 0.10)",
            border:         "1.5px solid rgba(0, 242, 255, 0.30)",
            display:        "flex",
            alignItems:     "center",
            justifyContent: "center",
            fontSize:       28,
            lineHeight:     1,
            boxShadow:      "0 0 18px rgba(0,242,255,0.18)",
          }}
        >
          {icon}
        </div>

        {/* ── Text column ───────────────────────────────────────────────────── */}
        <div className="nav-banner-text" style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
          {/* Distance-to-maneuver pill */}
          {distanceLabel && (
            <span
              style={{
                display:       "inline-block",
                width:         "fit-content",
                background:    "rgba(0, 242, 255, 0.14)",
                border:        "1px solid rgba(0, 242, 255, 0.32)",
                borderRadius:  20,
                padding:       "2px 10px",
                fontSize:      12,
                fontWeight:    700,
                color:         "#00f2ff",
                letterSpacing: "0.4px",
              }}
            >
              {distanceLabel}
            </span>
          )}

          {/* Instruction text */}
          <div
            className="nav-banner-instruction"
            style={{
              fontSize:   17,
              fontWeight: 700,
              color:      "#F1F5F9",
              lineHeight: 1.35,
              overflow:   "hidden",
              textOverflow: "ellipsis",
              // Allow two lines so long Arabic instructions aren't truncated.
              display:           "-webkit-box",
              WebkitLineClamp:   2,
              WebkitBoxOrient:   "vertical",
            }}
          >
            {instruction.text}
          </div>

          {/* Step counter */}
          <div
            style={{
              fontSize:      11,
              color:         "#64748B",
              fontWeight:    500,
              letterSpacing: "0.3px",
            }}
          >
            {stepLabel}
          </div>
        </div>

        {/* ── Voice mute/unmute toggle ───────────────────────────────────────── */}
        <button
          onClick={onToggleVoice}
          aria-label={voiceEnabled ? "كتم الصوت" : "تفعيل الصوت"}
          title={voiceEnabled ? "كتم الصوت" : "تفعيل الصوت"}
          className="nav-banner-voice-btn"
          style={{
            flexShrink:     0,
            width:          42,
            height:         42,
            borderRadius:   12,
            border:         voiceEnabled
              ? "1.5px solid rgba(16, 185, 129, 0.45)"
              : "1.5px solid rgba(100, 116, 139, 0.35)",
            background:     voiceEnabled
              ? "rgba(16, 185, 129, 0.14)"
              : "rgba(15, 23, 42, 0.60)",
            color:          voiceEnabled ? "#34D399" : "#475569",
            fontSize:       20,
            cursor:         "pointer",
            display:        "flex",
            alignItems:     "center",
            justifyContent: "center",
            transition:     "background 0.2s, border-color 0.2s, color 0.2s",
            boxShadow:      voiceEnabled
              ? "0 0 12px rgba(16,185,129,0.18)"
              : "none",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.transform = "scale(1.08)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = "scale(1)";
          }}
        >
          {voiceEnabled ? "🔊" : "🔇"}
        </button>
      </div>
    </div>
  );
};

export default NavigationBanner;
