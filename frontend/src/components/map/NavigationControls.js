/**
 * NavigationControls — "Bottom Sheet" navigation bar.
 *
 * Mobile-first, thumb-friendly panel pinned to the bottom of the viewport.
 * Uses a glassmorphism "frosted panel" instead of a plain toolbar so the map
 * remains partially visible beneath the controls.
 *
 * Renders one of two states:
 *   Preview mode  → "وضع المعاينة" badge + "انطلق" pill + "إلغاء المسار" pill
 *   Navigation    → "جارٍ التنقل" status + Live-tracking toggle + "إنهاء الملاحة" pill
 *
 * NOTE: All layout uses inline styles — the project's tailwind.config.js lives
 * inside src/components/map/ (not at the frontend root) so Tailwind utility
 * classes are never compiled.  Relying on them caused the panel to be invisible.
 */

import React from "react";

// ─── Shared style tokens ──────────────────────────────────────────────────────

const PILL_BASE = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 10,
  borderRadius: 50,
  border: "none",
  cursor: "pointer",
  fontWeight: 700,
  fontSize: 17,
  letterSpacing: 0.3,
  transition:
    "transform 0.18s cubic-bezier(0.34,1.56,0.64,1), box-shadow 0.18s ease",
  userSelect: "none",
  WebkitTapHighlightColor: "transparent",
  minHeight: 56,
};

const START_PILL = {
  ...PILL_BASE,
  padding: "15px 40px",
  minWidth: 168,
  background: "rgba(16, 185, 129, 0.25)",
  backdropFilter: "blur(8px)",
  WebkitBackdropFilter: "blur(8px)",
  border: "1px solid rgba(16, 185, 129, 0.30)",
  color: "#ffffff",
  // text-shadow ensures the label stays legible against both light and dark map tiles
  textShadow: "0 1px 4px rgba(0, 0, 0, 0.45)",
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  boxShadow:
    "0 4px 24px rgba(16, 185, 129, 0.22), 0 1px 0 rgba(255,255,255,0.14) inset",
};

const CLEAR_PILL = {
  ...PILL_BASE,
  padding: "14px 26px",
  background: "rgba(8, 16, 36, 0.72)",
  backdropFilter: "blur(18px)",
  WebkitBackdropFilter: "blur(18px)",
  color: "#94A3B8",
  border: "1.5px solid rgba(148,163,184,0.20)",
  boxShadow:
    "0 4px 20px rgba(0,0,0,0.42), inset 0 1px 0 rgba(255,255,255,0.05)",
  fontSize: 15,
};

const EXIT_PILL = {
  ...PILL_BASE,
  padding: "15px 44px",
  minWidth: 196,
  background: "linear-gradient(135deg, #7f1d1d 0%, #ef4444 100%)",
  color: "#fff",
  boxShadow:
    "0 0 32px rgba(239,68,68,0.55), 0 8px 28px rgba(239,68,68,0.28), 0 0 0 3px rgba(239,68,68,0.16), inset 0 1px 0 rgba(255,255,255,0.14)",
};

const RECENTER_PILL = {
  ...PILL_BASE,
  fontSize: 13,
  padding: "10px 20px",
  background: "rgba(4, 10, 22, 0.88)",
  backdropFilter: "blur(18px)",
  WebkitBackdropFilter: "blur(18px)",
  color: "#60A5FA",
  border: "1.5px solid rgba(96,165,250,0.38)",
  boxShadow:
    "0 0 18px rgba(96,165,250,0.22), 0 6px 20px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.06)",
  position: "fixed",
  bottom: 100,
  right: 20,
  zIndex: 1200,
  fontWeight: 600,
};

const LIVE_TRACKING_PILL = {
  ...PILL_BASE,
  fontSize: 12,
  padding: "9px 18px",
  minHeight: 38,
  background: "rgba(0, 22, 32, 0.82)",
  backdropFilter: "blur(16px)",
  WebkitBackdropFilter: "blur(16px)",
  color: "#00f2ff",
  border: "1.5px solid rgba(0,242,255,0.32)",
  boxShadow:
    "0 0 14px rgba(0,242,255,0.22), 0 4px 18px rgba(0,0,0,0.42), inset 0 1px 0 rgba(255,255,255,0.06)",
  fontWeight: 600,
  letterSpacing: 0.2,
};

// Mobile-only inline "Re-center" button base style.  Mirrors RECENTER_PILL's
// blue accent but without the `position: fixed` anchors so it can sit inside
// the bottom-sheet action row.  Default `display: none` hides it on desktop;
// the mobile media-query (see App.css → .nav-recenter-inline-btn) flips it on.
const RECENTER_INLINE_PILL = {
  ...PILL_BASE,
  display: "none",
  fontSize: 13,
  padding: "10px 16px",
  minHeight: 44,
  background: "rgba(4, 10, 22, 0.88)",
  backdropFilter: "blur(18px)",
  WebkitBackdropFilter: "blur(18px)",
  color: "#60A5FA",
  border: "1.5px solid rgba(96,165,250,0.38)",
  boxShadow:
    "0 0 18px rgba(96,165,250,0.22), 0 6px 20px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.06)",
  fontWeight: 600,
  letterSpacing: 0.2,
};

// ─── Component ────────────────────────────────────────────────────────────────

const NavigationControls = ({
  isNavigating,
  isMapCentered,
  hasActiveRoute,
  isRTL,
  navigationMode,
  cameraCountOnRoute,
  incidentCountOnRoute,
  isLiveTracking,
  onEnableLiveTracking,
  onStartNavigation,
  onExitNavigation,
  onClearRoute,
  onReCenter,
  isDarkTheme = true,
}) => {
  if (!hasActiveRoute) return null;

  // ── Theme-driven panel tokens ─────────────────────────────────────────────
  const panelBackground = isDarkTheme
    ? "rgba(10, 14, 26, 0.72)"
    // Charcoal gunmetal — opaque enough to ensure contrast in light map mode
    // while still allowing a faint backdrop-blur shimmer through
    : "rgba(31, 41, 55, 0.94)";
  const panelBorder = isDarkTheme
    ? "1px solid rgba(255, 255, 255, 0.07)"
    : "1px solid rgba(255, 255, 255, 0.08)";
  const panelShadow = isDarkTheme
    ? "0 -12px 56px rgba(0,0,0,0.80), 0 -1px 0 rgba(0,251,251,0.14), inset 0 1px 0 rgba(255,255,255,0.07)"
    : "0 -8px 40px rgba(0,0,0,0.55), 0 -1px 0 rgba(255,255,255,0.06), inset 0 1px 0 rgba(255,255,255,0.06)";
  const dragHandleGradient = isDarkTheme
    ? "linear-gradient(90deg, transparent, rgba(0,251,251,0.42), rgba(0,242,255,0.68), rgba(0,251,251,0.42), transparent)"
    : "rgba(0,0,0,0.15)";
  const glowLineGradient = isDarkTheme
    ? "linear-gradient(90deg, transparent, rgba(0,210,255,0.42), rgba(0,242,255,0.72), rgba(0,210,255,0.42), transparent)"
    : "linear-gradient(90deg, transparent, rgba(37,99,235,0.35), transparent)";

  return (
    <>
      {/* ── Bottom sheet ──────────────────────────────────────────────────── */}
      <div
        className="nav-controls-dock"
        data-is-navigating={isNavigating ? "1" : "0"}
        style={{
          position: "fixed",
          bottom: 0,
          left: 0,
          right: 0,
          display: "flex",
          justifyContent: "center",
          alignItems: "flex-end",
          pointerEvents: "none",
          zIndex: 1200,
          padding: "0 16px 0",
          paddingBottom: "max(16px, env(safe-area-inset-bottom))",
        }}
      >
        {/* Glassmorphic panel */}
        <div
          className="nav-controls-panel"
          style={{
            position: "relative",
            width: "100%",
            maxWidth: 480,
            borderRadius: "24px 24px 0 0",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            pointerEvents: "auto",
            background: panelBackground,
            backdropFilter: "blur(24px)",
            WebkitBackdropFilter: "blur(24px)",
            border: panelBorder,
            borderBottom: "none",
            padding: "20px 22px 22px",
            boxShadow: panelShadow,
            gap: 14,
          }}
        >
          {/* Top-edge cyan glow accent line */}
          <div
            style={{
              position: "absolute",
              top: 0,
              left: "18%",
              right: "18%",
              height: "1.5px",
              background: glowLineGradient,
              borderRadius: "0 0 50% 50%",
              zIndex: 1,
              pointerEvents: "none",
            }}
          />

          {/* Drag handle pill */}
          <div
            style={{
              width: 40,
              height: 4,
              borderRadius: 2,
              background: dragHandleGradient,
              marginBottom: 2,
            }}
          />

          {/* Panel header — brand name with cyan accent bar */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              width: "100%",
              marginBottom: 4,
            }}
          >
            <div
              style={{
                width: 4,
                height: 30,
                background: "linear-gradient(180deg, #00fbfb 0%, #0ea5e9 100%)",
                borderRadius: 4,
                boxShadow: "0 0 22px rgba(0, 251, 251, 0.45)",
                flexShrink: 0,
              }}
            />
            <span
              style={{
                fontSize: 13,
                fontWeight: 800,
                color: "#e2e8f0",
                fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif",
                letterSpacing: "0.15em",
                textTransform: "uppercase",
              }}
            >
              Traffstant
            </span>
          </div>

          {!isNavigating ? (
            /* ── STATE 1: PREVIEW MODE ─────────────────────────────────────── */
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                width: "100%",
                gap: 12,
                direction: isRTL ? "rtl" : "ltr",
              }}
            >
              {/* "وضع المعاينة · Preview Mode" badge */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  width: "fit-content",
                  gap: 7,
                  background: "rgba(0, 242, 255, 0.07)",
                  border: "1px solid rgba(0,242,255,0.20)",
                  borderRadius: 20,
                  padding: "5px 14px",
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: "#00f2ff",
                    animation: "navPulse 1.8s ease-out infinite",
                    display: "inline-block",
                    flexShrink: 0,
                  }}
                />
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: "#00f2ff",
                    letterSpacing: "0.6px",
                  }}
                >
                  وضع المعاينة · جاهز للانطلاق
                </span>

                {/* Camera / incident tally badge */}
                {(cameraCountOnRoute > 0 || incidentCountOnRoute > 0) && (
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      color: "#F59E0B",
                      background: "rgba(245,158,11,0.12)",
                      border: "1px solid rgba(245,158,11,0.30)",
                      borderRadius: 10,
                      padding: "1px 7px",
                      marginInlineStart: 2,
                    }}
                  >
                    {[
                      cameraCountOnRoute > 0 ? `📷 ${cameraCountOnRoute}` : null,
                      incidentCountOnRoute > 0 ? `⚠️ ${incidentCountOnRoute}` : null,
                    ]
                      .filter(Boolean)
                      .join("  ")}
                  </span>
                )}
              </div>

              {/* Action buttons row */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexWrap: "wrap",
                  width: "100%",
                  gap: 12,
                }}
              >
                {/* انطلق — Start Navigation */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onStartNavigation();
                  }}
                  className="glow-cyan"
                  style={START_PILL}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.transform = "translateY(-4px) scale(1.05)";
                    e.currentTarget.style.background = "rgba(16, 185, 129, 0.38)";
                    e.currentTarget.style.boxShadow =
                      "0 8px 40px rgba(16,185,129,0.38), 0 2px 12px rgba(16,185,129,0.22), inset 0 1px 0 rgba(255,255,255,0.22)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.transform = "translateY(0) scale(1)";
                    e.currentTarget.style.background = START_PILL.background;
                    e.currentTarget.style.boxShadow = START_PILL.boxShadow;
                  }}
                  aria-label="بدء الملاحة"
                >
                  <span style={{ fontSize: 22 }}>🧭</span>
                  انطلق
                </button>

                {/* إلغاء المسار — Cancel Route */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onClearRoute();
                  }}
                  style={CLEAR_PILL}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.transform = "translateY(-2px)";
                    e.currentTarget.style.color = "#CBD5E1";
                    e.currentTarget.style.borderColor =
                      "rgba(203,213,225,0.42)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.transform = "translateY(0)";
                    e.currentTarget.style.color = "#94A3B8";
                    e.currentTarget.style.borderColor =
                      "rgba(148,163,184,0.20)";
                  }}
                  aria-label="مسح الطريق"
                >
                  <span style={{ fontSize: 16 }}>✕</span>
                  إلغاء المسار
                </button>
              </div>
            </div>
          ) : (
            /* ── STATE 2: ACTIVE NAVIGATION ────────────────────────────────── */
            <div
              className="active-nav-container"
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                width: "100%",
                gap: 10,
                direction: isRTL ? "rtl" : "ltr",
              }}
            >
              {/* Status indicator row (desktop layout) */}
              <div
                className="active-nav-status-row"
                style={{
                  display: "flex",
                  alignItems: "center",
                  flexWrap: "wrap",
                  justifyContent: "center",
                  gap: 10,
                }}
              >
                {/* جارٍ التنقل */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    fontWeight: 700,
                    textTransform: "uppercase",
                    fontSize: 11,
                    color: "#22C55E",
                    letterSpacing: "1.2px",
                    gap: 6,
                  }}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: "#22C55E",
                      animation: "navPulse 1.6s ease-out infinite",
                      display: "inline-block",
                    }}
                  />
                  جارٍ التنقل
                </div>

                {/* Live-tracking: active badge OR manual-enable button */}
                {isLiveTracking ? (
                  <div
                    className="nav-live-tracking-badge"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      fontWeight: 700,
                      gap: 5,
                      background: "rgba(0,242,255,0.08)",
                      border: "1px solid rgba(0,242,255,0.28)",
                      borderRadius: 12,
                      padding: "3px 10px",
                      fontSize: 10,
                      color: "#00f2ff",
                      letterSpacing: "0.4px",
                      boxShadow: "0 0 10px rgba(0,242,255,0.14)",
                    }}
                  >
                    <span
                      style={{
                        width: 5,
                        height: 5,
                        borderRadius: "50%",
                        background: "#00f2ff",
                        animation: "navPulse 1.4s ease-out infinite",
                        display: "inline-block",
                      }}
                    />
                    تتبع مباشر · جاري التتبع
                  </div>
                ) : (
                  <button
                    className="nav-live-tracking-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      onEnableLiveTracking?.();
                    }}
                    style={LIVE_TRACKING_PILL}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.transform = "translateY(-2px)";
                      e.currentTarget.style.boxShadow =
                        "0 0 22px rgba(0,242,255,0.35), 0 6px 20px rgba(0,0,0,0.48)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.transform = "translateY(0)";
                      e.currentTarget.style.boxShadow =
                        LIVE_TRACKING_PILL.boxShadow;
                    }}
                    aria-label="تفعيل تتبع الموقع"
                  >
                    <span style={{ fontSize: 14 }}>🛰</span>
                    تفعيل التتبع الحي
                  </button>
                )}
              </div>

              {/*
                Mobile-only in-panel "Re-center" button.
                Desktop layout is unchanged: the original floating recenter FAB
                (rendered below with .recenter-fab) still appears whenever the
                map has been dragged away from the driver's position.  Mobile
                CSS sets `display: none` on the floating FAB and reveals this
                in-panel button instead so all three controls sit inside the
                single cohesive bottom panel.
              */}
              {!isMapCentered && (
                <button
                  type="button"
                  className="nav-recenter-inline-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onReCenter?.();
                  }}
                  style={RECENTER_INLINE_PILL}
                  aria-label="Re-center map on my location"
                >
                  <span style={{ fontSize: 18 }}>🎯</span>
                  إعادة تمركز
                </button>
              )}

              {/* إنهاء الملاحة — End Navigation */}
              <button
                className="nav-exit-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onExitNavigation();
                }}
                style={EXIT_PILL}
                onMouseEnter={(e) => {
                  e.currentTarget.style.transform = "translateY(-4px) scale(1.05)";
                  e.currentTarget.style.boxShadow =
                    "0 0 48px rgba(239,68,68,0.72), 0 12px 36px rgba(239,68,68,0.38), 0 0 0 4px rgba(239,68,68,0.22)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = "translateY(0) scale(1)";
                  e.currentTarget.style.boxShadow = EXIT_PILL.boxShadow;
                }}
                aria-label="إنهاء الملاحة"
              >
                <span style={{ fontSize: 20 }}>✕</span>
                إنهاء الملاحة
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── Re-center button (only while navigating and map has been panned) ── */}
      {isNavigating && !isMapCentered && (
        <button
          onClick={onReCenter}
          className="recenter-fab"
          style={RECENTER_PILL}
          onMouseEnter={(e) => {
            e.currentTarget.style.transform = "scale(1.07)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = "scale(1)";
          }}
          aria-label="Re-center map on my location"
        >
          <span style={{ fontSize: 16 }}>🎯</span>
          إعادة تمركز
        </button>
      )}
    </>
  );
};

export default NavigationControls;
