/**
 * SafetyOverlay — premium digital dashboard components for driver safety.
 *
 * Exports:
 *   SpeedGauge          — SVG arc-based speedometer with car-dashboard aesthetics.
 *   SafetyAlertToast    — Camera / seatbelt warning toast (amber, frosted glass).
 *   SpeedAlertToast     — Speed-exceeded toast (critical red, frosted glass).
 *   SpeedViolationBanner — Full-width fixed banner when speed > highway limit.
 *   CameraProximityBanner — Shown when GPS is within 500 m of a belt/mobile camera.
 *   SaherAlertBadge       — Top-of-screen Saher (speed) camera radar badge,
 *                           fed from frontend/src/data/saherCameras.json (400 m).
 */

import React from "react";
import { ROAD_SPEED_LIMIT_HIGHWAY } from "./mapConfig";

// ─── Premium audio utility ────────────────────────────────────────────────────

// Module-level singleton AudioContext.
//
// iOS Safari and Chrome for Android start every AudioContext in a "suspended"
// state when it is created outside of a user-gesture event handler.  A
// per-call context (the previous approach) therefore produces silence on
// mobile because the GPS callback that triggers the chime is never a user
// gesture.
//
// The fix is a two-step pattern:
//   1. unlockAudio() — called once inside the "Start Navigation" button click
//      (a genuine user gesture).  This creates the context AND calls resume(),
//      which permanently lifts the browser's autoplay restriction for the
//      lifetime of the page.
//   2. playSoftChime() — reuses the already-resumed singleton.  If it is
//      somehow still suspended (e.g. the user never tapped Start), a
//      best-effort resume() is attempted so chimes work on desktop browsers
//      that have looser autoplay policies.
let _sharedAudioCtx = null;

const getOrCreateAudioContext = () => {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;
  if (!_sharedAudioCtx || _sharedAudioCtx.state === "closed") {
    _sharedAudioCtx = new AudioCtx();
  }
  return _sharedAudioCtx;
};

/**
 * Must be called exactly once inside a user-gesture handler — specifically
 * the "Start Navigation" button click — to satisfy iOS Safari's and Chrome
 * for Android's autoplay policy.  Subsequent calls are harmless no-ops.
 */
export const unlockAudio = () => {
  try {
    const ctx = getOrCreateAudioContext();
    if (ctx && ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }
  } catch (_err) {
    // Web Audio API unavailable (e.g. SSR environment).
  }
};

/**
 * Plays a soft, elegant UI chime using the Web Audio API.
 *
 * Two stacked sine-wave partials (A5 + E6) decay over 700 ms so the sound
 * feels like a premium notification bell rather than a harsh alert.
 */
export const playSoftChime = () => {
  try {
    const ctx = getOrCreateAudioContext();
    if (!ctx) return;

    // Best-effort resume for desktop browsers where the context may have
    // been auto-suspended after a period of inactivity.  On iOS this is a
    // no-op if unlockAudio() was never called from a user gesture — the
    // promise resolves but audio remains blocked — which is the correct
    // browser-enforced behaviour.
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }

    const createPartial = (frequency, gainPeak, durationSec) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.type = "sine";
      osc.frequency.setValueAtTime(frequency, ctx.currentTime);
      // Slight pitch drop gives a bell-decay character.
      osc.frequency.exponentialRampToValueAtTime(frequency * 0.98, ctx.currentTime + durationSec);

      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(gainPeak, ctx.currentTime + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + durationSec);

      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + durationSec);
    };

    createPartial(880,  0.22, 0.65); // A5 — fundamental
    createPartial(1318, 0.10, 0.45); // E6 — natural fifth overtone
  } catch (_err) {
    // Silently ignore if the Web Audio API is unavailable (e.g. server-side render).
  }
};

// ─── SVG gauge helpers ────────────────────────────────────────────────────────

const CX = 64;
const CY = 64;
const RADIUS = 52;
// Gauge sweeps 270° clockwise starting at the 8 o'clock position (225°).
const GAUGE_START_ANGLE = 225; // degrees (0° = 12 o'clock, clockwise)
const GAUGE_SWEEP = 270; // total degrees of the arc

/**
 * Converts a gauge angle (0° = 12 o'clock, clockwise) to an SVG {x, y} point
 * on the circle with the configured center and radius.
 */
const polarToCartesian = (angleDeg) => {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return {
    x: CX + RADIUS * Math.cos(rad),
    y: CY + RADIUS * Math.sin(rad),
  };
};

/**
 * Builds the SVG "d" attribute for an arc from the gauge start to a point
 * that corresponds to `speedRatio` (0–1) of max speed.
 * Returns null when speedRatio ≈ 0 (nothing to draw).
 */
// const buildSpeedArcPath = (speedRatio) => {
//   if (speedRatio < 0.005) return null;
//
//   const sweepDegrees = speedRatio * GAUGE_SWEEP;
//   const endAngle = (GAUGE_START_ANGLE + sweepDegrees) % 360;
//   const startPt = polarToCartesian(GAUGE_START_ANGLE);
//   const endPt = polarToCartesian(endAngle);
//   const largeArc = sweepDegrees > 180 ? 1 : 0;
//
//   return `M ${startPt.x.toFixed(2)} ${startPt.y.toFixed(2)} A ${RADIUS} ${RADIUS} 0 ${largeArc} 1 ${endPt.x.toFixed(2)} ${endPt.y.toFixed(2)}`;
// };

// /** Full background track — always visible as a dim arc. */
// const buildTrackPath = () => {
//   const startPt = polarToCartesian(GAUGE_START_ANGLE);
//   const endPt = polarToCartesian((GAUGE_START_ANGLE + GAUGE_SWEEP) % 360);
//   return `M ${startPt.x.toFixed(2)} ${startPt.y.toFixed(2)} A ${RADIUS} ${RADIUS} 0 1 1 ${endPt.x.toFixed(2)} ${endPt.y.toFixed(2)}`;
// };

// /** Returns the stroke colour for the speed arc based on speed relative to the limit. */
// const gaugeColor = (currentSpeed, speedLimit) => {
//   const ratio = speedLimit > 0 ? currentSpeed / speedLimit : 0;
//   if (ratio >= 1.0) return "#EF4444"; // red — limit exceeded
//   if (ratio >= 0.85) return "#F97316"; // orange — approaching limit
//   if (ratio >= 0.60) return "#F59E0B"; // amber — moderate speed
//   return "#22C55E"; // green — safe speed
// };

// ─── SpeedGauge ──────────────────────────────────────────────────────────────

/**
 * SpeedGauge — Glassmorphic speedometer pill (Top-Right).
 *
 * Styled after the template's "Floating Speedometer Pill":
 *   • glass-panel pill shape with a cyan left-border accent.
 *   • Large bold speed number + KM/H label.
 *   • Inline status badge that flips to red when speed limit is exceeded.
 *   • All speed-limit and exceeding logic is preserved from the original.
 */
export const SpeedGauge = ({
  currentSpeed,
  speedLimit,
  maxSpeed = 160, // kept for API compatibility — not used in pill layout
}) => {
  const isExceeding = currentSpeed > speedLimit;

  // Derived style tokens that flip between safe (cyan) and over-limit (red).
  const accentColor  = isExceeding ? "#EF4444" : "#00fbfb";
  const badgeBg      = isExceeding ? "rgba(239,68,68,0.15)"       : "rgba(1,63,185,0.30)";
  const badgeBorder  = isExceeding ? "rgba(239,68,68,0.30)"       : "rgba(182,196,255,0.20)";
  const badgeText    = isExceeding ? "#EF4444"                    : "#b6c4ff";
  const dotGlow      = isExceeding ? "rgba(239,68,68,0.5)"        : "rgba(0,251,251,0.5)";
  const pillGlow     = isExceeding ? "rgba(239,68,68,0.3)"        : "rgba(0,251,251,0.15)";

  return (
    <div
      className="speed-gauge-root"
      style={{
        position: "fixed",
        top: 80,
        right: 20,
        zIndex: 1001,
        userSelect: "none",
        fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif",
        animation: "fadeInUp 0.35s ease forwards",
      }}
    >
      {/* ── Glassmorphic speedometer pill ──────────────────────────────── */}
      <div
        className="speed-gauge-pill"
        style={{
          background: "rgba(19, 19, 19, 0.6)",
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
          border: "1px solid rgba(255, 255, 255, 0.08)",
          // Cyan (or red) left-border accent — mirrors template's border-l-4 border-primary-container
          borderLeft: `4px solid ${accentColor}`,
          borderRadius: 9999,
          padding: "16px 32px",
          display: "flex",
          alignItems: "center",
          gap: 24,
          boxShadow: `0 0 20px ${pillGlow}, 0 20px 50px rgba(0,0,0,0.55)`,
          transition: "border-color 0.4s ease, box-shadow 0.4s ease",
        }}
        aria-label={`السرعة: ${currentSpeed} كم/س، الحد: ${speedLimit} كم/س`}
      >
        {/* Speed number + KM/H label */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
          <span
            style={{
              fontSize: 48,
              fontWeight: 900,
              color: isExceeding ? "#EF4444" : "#ffffff",
              lineHeight: 1,
              letterSpacing: "-2px",
              transition: "color 0.3s ease",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {currentSpeed}
          </span>
          <span
            style={{
              fontSize: 9,
              fontWeight: 800,
              color: "#00fbfb",
              letterSpacing: "0.2em",
              textTransform: "uppercase",
              marginTop: 4,
              lineHeight: 1,
            }}
          >
            KM/H
          </span>
        </div>

        {/* Vertical divider */}
        <div style={{ width: 1, height: 40, background: "rgba(255,255,255,0.10)", flexShrink: 0 }} />

        {/* Status column */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {/* Glowing status badge — mirrors template's Preview Mode pill */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              background: badgeBg,
              border: `1px solid ${badgeBorder}`,
              padding: "4px 12px",
              borderRadius: 9999,
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: accentColor,
                boxShadow: `0 0 20px ${dotGlow}`,
                flexShrink: 0,
                display: "inline-block",
              }}
            />
            <span
              style={{
                fontSize: 9,
                fontWeight: 800,
                color: badgeText,
                letterSpacing: "0.15em",
                textTransform: "uppercase",
                whiteSpace: "nowrap",
              }}
            >
              {isExceeding ? "تجاوز السرعة" : "وضع الأمان"}
            </span>
          </div>

          {/* Speed limit row */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 4px" }}>
            <span style={{ fontSize: 10, color: "#b9cac9", whiteSpace: "nowrap" }}>
              {isExceeding
                ? `${currentSpeed} / ${speedLimit} كم/س`
                : `حد: ${speedLimit} كم/س ✓`}
            </span>
          </div>
        </div>
      </div>

      {/* Pulse label — only shown when speed is exceeded */}
      {isExceeding && (
        <div
          style={{
            marginTop: 6,
            textAlign: "center",
            fontSize: 9,
            fontWeight: 800,
            color: "#EF4444",
            textTransform: "uppercase",
            letterSpacing: "1.2px",
            animation: "pulse 0.85s ease-in-out infinite",
            textShadow: "0 0 10px rgba(239,68,68,0.65)",
          }}
        >
          ⚡ تجاوز السرعة
        </div>
      )}
    </div>
  );
};

// ─── SafetyAlertToast ─────────────────────────────────────────────────────────

/** Camera / seatbelt warning — amber frosted glass. */
export const SafetyAlertToast = ({ message, onDismiss }) => (
  <div
    style={{
      width: "100%",
      background: "linear-gradient(135deg, rgba(36, 22, 4, 0.94) 0%, rgba(28, 16, 2, 0.96) 100%)",
      border: "1px solid rgba(245,158,11,0.45)",
      borderInlineStart: "3px solid #F59E0B",
      borderRadius: 12,
      padding: "9px 10px",
      boxShadow:
        "0 2px 20px rgba(245,158,11,0.22), 0 6px 28px rgba(0,0,0,0.45), inset 0 1px 0 rgba(245,158,11,0.08)",
      color: "#FEF3C7",
      fontSize: 11,
      backdropFilter: "blur(22px)",
      WebkitBackdropFilter: "blur(22px)",
      direction: "rtl",
      animation: "slideInFromTopStack 0.28s cubic-bezier(0.16,1,0.3,1) forwards",
      fontFamily: "'Inter', 'Segoe UI', Arial, Tahoma, sans-serif",
    }}
  >
    <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
      <div
        style={{
          flex: 1,
          fontSize: 11,
          fontWeight: 600,
          lineHeight: 1.5,
          color: "#FFFFFF",
          wordBreak: "break-word",
        }}
      >
        {message}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="إغلاق التنبيه"
        style={{
          background: "transparent",
          border: "none",
          color: "#78716C",
          cursor: "pointer",
          fontSize: 17,
          flexShrink: 0,
          padding: 0,
          lineHeight: 1,
          transition: "color 0.2s",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.color = "#FEF3C7"; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = "#78716C"; }}
      >
        ×
      </button>
    </div>
  </div>
);

// ─── SpeedAlertToast ──────────────────────────────────────────────────────────

/** Speed-exceeded toast — critical red. */
export const SpeedAlertToast = ({ currentSpeed, speedLimit, onDismiss }) => (
  <div
    style={{
      width: "100%",
      background: "linear-gradient(135deg, rgba(40, 6, 8, 0.96) 0%, rgba(28, 4, 6, 0.97) 100%)",
      border: "1px solid rgba(239,68,68,0.52)",
      borderInlineStart: "3px solid #EF4444",
      borderRadius: 12,
      padding: "9px 10px",
      boxShadow:
        "0 2px 20px rgba(239,68,68,0.25), 0 6px 28px rgba(0,0,0,0.50), inset 0 1px 0 rgba(239,68,68,0.08)",
      color: "#FCA5A5",
      fontSize: 11,
      backdropFilter: "blur(22px)",
      WebkitBackdropFilter: "blur(22px)",
      direction: "rtl",
      animation: "slideInFromTopStack 0.28s cubic-bezier(0.16,1,0.3,1) forwards",
      fontFamily: "'Inter', 'Segoe UI', Arial, Tahoma, sans-serif",
    }}
  >
    <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
      <span style={{ fontSize: 15, flexShrink: 0, lineHeight: 1 }}>🛑</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontWeight: 700,
            color: "#FEF2F2",
            marginBottom: 2,
            fontSize: 12,
          }}
        >
          تجاوز السرعة المحددة
        </div>
        <div
          style={{
            fontSize: 11,
            color: "#FCA5A5",
            lineHeight: 1.45,
            marginBottom: 4,
          }}
        >
          تحذير: لقد تجاوزت السرعة المحددة! خفف سرعتك لسلامتك.
        </div>
        <div
          style={{
            display: "flex",
            gap: 6,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <span
            style={{
              fontSize: 11,
              fontWeight: 800,
              color: "#EF4444",
              background: "rgba(239,68,68,0.15)",
              padding: "1px 6px",
              borderRadius: 5,
            }}
          >
            {currentSpeed} كم/س
          </span>
          <span style={{ fontSize: 9, color: "#64748B" }}>الحد المسموح:</span>
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: "#22C55E",
              background: "rgba(34,197,94,0.12)",
              padding: "1px 6px",
              borderRadius: 5,
            }}
          >
            {speedLimit} كم/س
          </span>
        </div>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="إغلاق تحذير السرعة"
        style={{
          background: "transparent",
          border: "none",
          color: "#64748B",
          cursor: "pointer",
          fontSize: 17,
          flexShrink: 0,
          padding: 0,
          lineHeight: 1,
          transition: "color 0.2s",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.color = "#FCA5A5"; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = "#64748B"; }}
      >
        ×
      </button>
    </div>
  </div>
);

// ─── SpeedViolationBanner ─────────────────────────────────────────────────────

/** Fixed red banner shown during navigation when GPS speed exceeds the highway limit. */
export const SpeedViolationBanner = ({ currentSpeed }) => (
  <div
    style={{
      position: "fixed",
      top: 70,
      left: "50%",
      transform: "translateX(-50%)",
      zIndex: 1300,
      background:
        "linear-gradient(135deg, rgba(100, 12, 12, 0.98), rgba(185, 28, 28, 0.98))",
      border: "1.5px solid rgba(239, 68, 68, 0.70)",
      borderRadius: 14,
      padding: "10px 22px",
      color: "#FCA5A5",
      fontSize: 13,
      fontWeight: 700,
      letterSpacing: 0.2,
      backdropFilter: "blur(16px)",
      WebkitBackdropFilter: "blur(16px)",
      boxShadow:
        "0 0 0 3px rgba(239,68,68,0.22), 0 8px 28px rgba(0,0,0,0.70), inset 0 1px 0 rgba(255,255,255,0.08)",
      display: "flex",
      alignItems: "center",
      gap: 8,
      pointerEvents: "none",
      whiteSpace: "nowrap",
      direction: "rtl",
      animation: "slideInFromTop 0.3s ease forwards",
    }}
  >
    <span style={{ fontSize: 16 }}>⚠️</span>
    تجاوزت السرعة القانونية ({ROAD_SPEED_LIMIT_HIGHWAY} كم/س)
  </div>
);

// ReconRadarBanner was removed in favour of the compact camera/incident tally
// already embedded inside the "Preview Mode" badge in NavigationControls.

// ─── CameraProximityBanner ────────────────────────────────────────────────────

/**
 * Fixed banner shown when GPS is within 500 m of a Saher / safety camera.
 * Auto-dismisses after 10 s; tapping it closes it immediately.
 *
 * Props:
 *   topOffset    — vertical position in px (shifts down when SpeedViolationBanner is also visible).
 *   onDismiss    — callback to hide the banner.
 *   currentSpeed — driver's live speed in km/h (from GPS coords.speed × 3.6).
 *   cameraType   — "speed" | "belt" | "mobile"  (defaults to "speed").
 *   speedLimit   — posted speed limit in km/h for speed cameras; null for belt/mobile.
 *
 * Visual distinction:
 *   speed cameras  → red gradient + flashing red border (cameraAlertFlashSpeed)
 *   belt/mobile    → amber gradient + flashing amber border (cameraAlertFlashBelt)
 */
export const CameraProximityBanner = ({
  topOffset,
  onDismiss,
  currentSpeed,
  cameraType = "speed",
  speedLimit = null,
}) => {
  const isSpeedCamera = cameraType === "speed";

  const background = isSpeedCamera
    ? "linear-gradient(135deg, rgba(100, 12, 12, 0.98), rgba(180, 28, 28, 0.98))"
    : "linear-gradient(135deg, rgba(92, 35, 5, 0.98), rgba(180, 83, 9, 0.98))";

  const borderColor = isSpeedCamera
    ? "rgba(239, 68, 68, 0.65)"
    : "rgba(245, 158, 11, 0.65)";

  const flashAnimation = isSpeedCamera
    ? "cameraAlertFlashSpeed 0.7s ease-in-out infinite"
    : "cameraAlertFlashBelt 0.7s ease-in-out infinite";

  const textColor = isSpeedCamera ? "#FCA5A5" : "#FDE68A";

  const icon = isSpeedCamera ? "🚨" : "📷";

  const primaryLabel = isSpeedCamera
    ? "كاميرا سرعة (ساهر) — 500 متر"
    : "كاميرا حزام / جوال — 500 متر";

  const isSpeedingAboveLimit =
    isSpeedCamera && speedLimit != null && currentSpeed > speedLimit;

  return (
    <div
      onClick={onDismiss}
      role="alert"
      aria-live="assertive"
      className="camera-proximity-banner"
      style={{
        position: "fixed",
        top: topOffset,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 1300,
        background,
        border: `1.5px solid ${borderColor}`,
        borderRadius: 14,
        padding: "12px 20px",
        color: textColor,
        fontSize: 13,
        fontWeight: 700,
        backdropFilter: "blur(16px)",
        WebkitBackdropFilter: "blur(16px)",
        animation: `slideInFromTop 0.3s ease forwards, ${flashAnimation}`,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        cursor: "pointer",
        maxWidth: "min(92vw, 440px)",
        width: "max-content",
        direction: "rtl",
        fontFamily: "'Inter', 'Segoe UI', Arial, Tahoma, sans-serif",
      }}
    >
      {/* ── Header row: icon + label ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 20, flexShrink: 0, lineHeight: 1 }}>{icon}</span>
        <span style={{ fontSize: 14, fontWeight: 800, color: "#FFFFFF", letterSpacing: "0.1px" }}>
          {primaryLabel}
        </span>
      </div>

      {/* ── Speed limit row (speed cameras only) ── */}
      {isSpeedCamera && speedLimit != null && (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 11, color: textColor, opacity: 0.85 }}>الحد المسموح:</span>
          <span
            style={{
              fontSize: 15,
              fontWeight: 900,
              color: "#FFFFFF",
              background: isSpeedingAboveLimit
                ? "rgba(239,68,68,0.35)"
                : "rgba(255,255,255,0.15)",
              borderRadius: 8,
              padding: "2px 10px",
              fontVariantNumeric: "tabular-nums",
              letterSpacing: "0.5px",
              border: isSpeedingAboveLimit
                ? "1px solid rgba(239,68,68,0.6)"
                : "1px solid rgba(255,255,255,0.15)",
            }}
          >
            {speedLimit} كم/س
          </span>

          {currentSpeed > 0 && (
            <>
              <span style={{ fontSize: 11, color: textColor, opacity: 0.70 }}>سرعتك:</span>
              <span
                style={{
                  fontSize: 15,
                  fontWeight: 900,
                  color: isSpeedingAboveLimit ? "#FCA5A5" : "#86EFAC",
                  background: isSpeedingAboveLimit
                    ? "rgba(239,68,68,0.20)"
                    : "rgba(34,197,94,0.15)",
                  borderRadius: 8,
                  padding: "2px 10px",
                  fontVariantNumeric: "tabular-nums",
                  letterSpacing: "0.5px",
                  border: isSpeedingAboveLimit
                    ? "1px solid rgba(239,68,68,0.40)"
                    : "1px solid rgba(34,197,94,0.30)",
                }}
              >
                {currentSpeed} كم/س
              </span>
            </>
          )}
        </div>
      )}

      {/* ── Belt/mobile camera: show current speed only ── */}
      {!isSpeedCamera && currentSpeed > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: textColor }}>
          <span style={{ opacity: 0.80 }}>سرعتك الحالية:</span>
          <span
            style={{
              fontWeight: 800,
              color: "#FFFFFF",
              background: "rgba(245,158,11,0.25)",
              borderRadius: 6,
              padding: "1px 8px",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {currentSpeed} كم/س
          </span>
        </div>
      )}

      {/* ── Sub-label ── */}
      <div style={{ fontSize: 10, color: textColor, opacity: 0.75, fontWeight: 600 }}>
        {isSpeedCamera
          ? "انتبه · خفف سرعتك · التزم بالحد المسموح"
          : "انتبه · ارتدِ حزام الأمان · لا تستخدم الجوال أثناء القيادة"}
      </div>
    </div>
  );
};

// ─── SaherAlertBadge ──────────────────────────────────────────────────────────

/**
 * SaherAlertBadge — premium top-of-screen radar badge for Saher speed cameras.
 *
 * Wired up from frontend/src/data/saherCameras.json (populated by
 * scripts/enrichSaherData.js).  Renders only while the device is within
 * SAHER_PROXIMITY_RADIUS_KM (400 m) of a known camera; the parent component
 * drops the badge once the driver clears the zone, which triggers the
 * `slideOutToTop`-style fade-out via the `isExiting` prop.
 *
 * Positioning convention:
 *   • topOffset is supplied by TrafficMap so the badge clears the
 *     turn-by-turn NavigationBanner (≈ 88 px tall + safe-area inset).
 *   • horizontally centred, max-width tuned to remain compact at 360p.
 *
 * Props:
 *   topOffset      — vertical distance (px) from the top of the viewport.
 *   speedLimit     — posted limit (km/h) at the camera; fallback "—" if null.
 *   currentSpeed   — driver's live speed (km/h); used to flag overspeed.
 *   distanceMeters — live distance (m) to the camera; null hides the chip.
 *   isExiting      — when true, the badge plays its fade-out animation.
 */
export const SaherAlertBadge = ({
  topOffset = 96,
  speedLimit,
  currentSpeed = 0,
  distanceMeters = null,
  isExiting = false,
}) => {
  const hasSpeedLimit = Number.isFinite(speedLimit);
  const isOverSpeedLimit = hasSpeedLimit && currentSpeed > speedLimit;

  // Distance chip: round to nearest 10 m for readability; hide entirely
  // when the parent component hasn't computed a value yet.
  const distanceLabel =
    Number.isFinite(distanceMeters)
      ? distanceMeters >= 1000
        ? `${(distanceMeters / 1000).toFixed(1)} كم`
        : `${Math.max(10, Math.round(distanceMeters / 10) * 10)} م`
      : null;

  const accentColor = isOverSpeedLimit ? "#FCA5A5" : "#FEF3C7";

  return (
    <div
      role="alert"
      aria-live="assertive"
      aria-label={
        hasSpeedLimit
          ? `كاميرا مراقبة. الحد المسموح ${speedLimit} كيلومتر في الساعة.`
          : "كاميرا مراقبة"
      }
      className="saher-alert-badge"
      style={{
        position: "fixed",
        top: topOffset,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 1250, // below NavigationBanner (1300) so we never cover guidance
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 16px 10px 14px",
        // Premium dark glass background with a subtle red glow for "danger".
        background:
          "linear-gradient(135deg, rgba(20, 8, 8, 0.94) 0%, rgba(40, 14, 14, 0.96) 100%)",
        border: "1px solid rgba(239, 68, 68, 0.55)",
        borderRadius: 18,
        backdropFilter: "blur(22px)",
        WebkitBackdropFilter: "blur(22px)",
        boxShadow:
          "0 0 0 3px rgba(239, 68, 68, 0.18), 0 12px 36px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.06)",
        color: "#FEF3C7",
        fontFamily: "'Inter', 'Segoe UI', Arial, Tahoma, sans-serif",
        direction: "rtl",
        whiteSpace: "nowrap",
        pointerEvents: "none",
        userSelect: "none",
        maxWidth: "min(92vw, 420px)",
        // Entry: slideInFromTop (already in App.css).  Exit: gentle fade+lift.
        animation: isExiting
          ? "saherBadgeExit 0.28s ease forwards"
          : "slideInFromTop 0.32s cubic-bezier(0.16,1,0.3,1) forwards, saherBadgePulse 1.6s ease-in-out infinite 0.4s",
      }}
    >
      {/* ── Camera icon disc ──────────────────────────────────────────────── */}
      <div
        aria-hidden="true"
        style={{
          flexShrink: 0,
          width: 38,
          height: 38,
          borderRadius: 12,
          background: "rgba(239, 68, 68, 0.18)",
          border: "1px solid rgba(239, 68, 68, 0.45)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 20,
          lineHeight: 1,
          boxShadow: "0 0 14px rgba(239, 68, 68, 0.25)",
        }}
      >
        📷
      </div>

      {/* ── Text column: title + sub-row ─────────────────────────────────── */}
      <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <span
          style={{
            fontSize: 13,
            fontWeight: 800,
            color: "#FFFFFF",
            letterSpacing: "0.2px",
            lineHeight: 1.15,
          }}
        >
          كاميرا مراقبة
        </span>
        <span
          style={{
            fontSize: 10.5,
            fontWeight: 600,
            color: accentColor,
            opacity: 0.85,
            letterSpacing: "0.2px",
            lineHeight: 1.15,
          }}
        >
          {isOverSpeedLimit ? "تجاوزت السرعة المحددة" : "خفف سرعتك"}
          {distanceLabel ? `  ·  ${distanceLabel}` : ""}
        </span>
      </div>

      {/* ── Speed-limit chip (red road-sign vibe) ────────────────────────── */}
      <div
        aria-hidden={!hasSpeedLimit}
        style={{
          flexShrink: 0,
          minWidth: 56,
          height: 56,
          borderRadius: "50%",
          background: "#FFFFFF",
          // Saudi/EU road-sign convention: red ring around white disc.
          border: "4px solid #DC2626",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "0 6px",
          boxShadow:
            "0 0 0 1px rgba(0,0,0,0.08), 0 4px 14px rgba(0, 0, 0, 0.45), inset 0 -2px 4px rgba(0, 0, 0, 0.08)",
        }}
      >
        <span
          style={{
            fontSize: hasSpeedLimit ? 20 : 18,
            fontWeight: 900,
            color: "#0F172A",
            lineHeight: 1,
            letterSpacing: "-0.5px",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {hasSpeedLimit ? speedLimit : "—"}
        </span>
        <span
          style={{
            fontSize: 8,
            fontWeight: 800,
            color: "#475569",
            letterSpacing: "0.5px",
            marginTop: 1,
            lineHeight: 1,
          }}
        >
          كم/س
        </span>
      </div>
    </div>
  );
};
