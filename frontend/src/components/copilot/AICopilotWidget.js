/**
 * AICopilotWidget — Floating AI Traffic Copilot (production implementation).
 *
 * Architecture:
 *   useSpeechRecognition  wraps the Web Speech API (lang: ar-SA).
 *   CopilotFab            the fixed mic FAB, turns red while recording.
 *   CopilotPanel          glassmorphism chat panel anchored above the FAB.
 *   AICopilotWidget       root: orchestrates speech → backend → display.
 *
 * Phase state machine:
 *   IDLE  ─[click FAB]──────► RECORDING  (mic active)
 *   RECORDING  ─[speech]────► THINKING   (API call in progress)
 *   RECORDING  ─[click FAB]─► IDLE       (user cancelled)
 *   THINKING   ─[response]──► RESPONDED
 *   THINKING   ─[click FAB]─► IDLE       (user cancelled)
 *   RESPONDED  ─[click FAB]─► IDLE
 *   ERROR  ─────[click FAB]─► RECORDING  (immediate retry)
 *   * / onClose / chips all collapse back to IDLE.
 *
 * Positioning (must stay in sync with TrafficMap.js LocateMeButton):
 *   LocateMeButton: fixed { bottom: 175, left: 20, height: 50 }
 *   Copilot FAB:    fixed { bottom: 113, left: 20 }  — 12 px gap below
 *   Copilot panel:  fixed { bottom: 173, left: 14 }  — 10 px above FAB
 */

import React, { useState, useCallback, useEffect, useRef } from "react";

// ─── Layout constants ─────────────────────────────────────────────────────────

const LOCATE_ME_BOTTOM_PX   = 175;
const GAP_BELOW_LOCATE_ME   = 12;
const COPILOT_FAB_SIZE_PX   = 50;
const COPILOT_FAB_BOTTOM_PX =
  LOCATE_ME_BOTTOM_PX - GAP_BELOW_LOCATE_ME - COPILOT_FAB_SIZE_PX; // 113
const COPILOT_PANEL_BOTTOM_PX =
  COPILOT_FAB_BOTTOM_PX + COPILOT_FAB_SIZE_PX + 10; // 173

// ─── API ──────────────────────────────────────────────────────────────────────

const COPILOT_API_URL =
  `${process.env.REACT_APP_API_BASE || "http://localhost:4000"}/api/copilot`;

// const RIYADH_CENTER = [24.7136, 46.6753];

// Maximum messages kept in local conversation history (2 per turn: user + assistant).
// 20 messages = 10 full exchanges — enough for a sustained multi-stop conversation
// without hitting token-budget limits on the backend.
const MAX_HISTORY_MESSAGES = 20;

// ─── Arabic UI copy ───────────────────────────────────────────────────────────

const COPY = {
  title:             "مساعد المرور الذكي",
  recording:         "جاري الاستماع، تحدث الآن…",
  thinking:          "جارٍ تحليل طلبك…",
  youSaid:           "قلت:",
  reroute:           "تغيير المسار",
  dismiss:           "تجاهل",
  goNow:             "انطلق الآن 🚀",
  retry:             "حاول مجدداً",
  closePanel:        "إغلاق لوحة المساعد",
  fabOpen:           "فتح مساعد الصوت",
  fabClose:          "إغلاق مساعد الصوت",
  fabTitle:          "مساعد الصوت",
  errorNotSupported: "المتصفح لا يدعم التعرف على الصوت.",
  errorNoSpeech:     "لم نسمع كلاماً واضحاً. حاول مرة أخرى.",
  errorApi:          "تعذر الاتصال بالخادم. حاول مجدداً.",
  /** Shown in chat when the API returns no usable message (429/500/HTML body, etc.). */
  apiGracefulError:
    "The AI is currently busy or out of quota. Please try again.",
};

// ─── Phase identifiers ────────────────────────────────────────────────────────

const PHASES = Object.freeze({
  IDLE:      "idle",
  RECORDING: "recording",
  THINKING:  "thinking",
  RESPONDED: "responded",
  ERROR:     "error",
});

// ─── Design tokens ────────────────────────────────────────────────────────────

const GLASS_DARK = {
  panel: {
    background:           "rgba(8, 15, 26, 0.88)",
    backdropFilter:       "blur(20px)",
    WebkitBackdropFilter: "blur(20px)",
    border:               "1px solid rgba(139, 92, 246, 0.28)",
    boxShadow:
      "0 8px 32px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.06)",
  },
  fabIdleBg:   "rgba(8, 15, 26, 0.82)",
  textPrimary: "#E2E8F0",
  textMuted:   "#94A3B8",
  textAccent:  "#C4B5FD",
  divider:     "rgba(139,92,246,0.14)",
};

const GLASS_LIGHT = {
  panel: {
    background:           "rgba(255, 255, 255, 0.80)",
    backdropFilter:       "blur(22px)",
    WebkitBackdropFilter: "blur(22px)",
    border:               "1px solid rgba(109, 40, 217, 0.22)",
    boxShadow:
      "0 8px 36px rgba(15,23,42,0.12), inset 0 1px 0 rgba(255,255,255,0.9)",
  },
  fabIdleBg:   "rgba(255, 255, 255, 0.82)",
  textPrimary: "#0F172A",
  textMuted:   "#475569",
  textAccent:  "#5B21B6",
  divider:     "rgba(109,40,217,0.12)",
};

const ARABIC_FONT =
  "'Segoe UI', Tahoma, 'Noto Sans Arabic', 'Arabic UI Text', 'Geeza Pro', sans-serif";

// ─── One-time keyframe injection ──────────────────────────────────────────────

const KEYFRAME_STYLE_ID = "ai-copilot-keyframes";

function ensureKeyframesInjected() {
  if (document.getElementById(KEYFRAME_STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = KEYFRAME_STYLE_ID;
  el.textContent = `
    @keyframes copilotSlideUp {
      from { opacity: 0; transform: translateY(14px) scale(0.96); }
      to   { opacity: 1; transform: translateY(0)     scale(1);    }
    }
    @keyframes copilotFadeIn {
      from { opacity: 0; }
      to   { opacity: 1; }
    }
    @keyframes copilotPulseRing {
      0%   { transform: scale(1);    opacity: 0.65; }
      100% { transform: scale(1.90); opacity: 0;    }
    }
    @keyframes copilotDot {
      0%, 80%, 100% { transform: scale(0.5); opacity: 0.35; }
      40%           { transform: scale(1);   opacity: 1;    }
    }
    @keyframes copilotSpin {
      from { transform: rotate(0deg); }
      to   { transform: rotate(360deg); }
    }
    @keyframes copilotRecordBlink {
      0%, 100% { opacity: 1;   transform: scale(1);    }
      50%      { opacity: 0.4; transform: scale(0.85); }
    }
  `;
  document.head.appendChild(el);
}

// ─── prefers-color-scheme hook ────────────────────────────────────────────────

function usePrefersLightScheme() {
  const [isLight, setIsLight] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: light)").matches
  );

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => setIsLight(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return isLight;
}

// ─── Web Speech API hook ──────────────────────────────────────────────────────
//
// Exposes startListening({ onResult, onError }) and abortListening().
// Language is locked to ar-SA.  "aborted" errors (user-initiated stop) are
// swallowed so they never propagate as user-visible errors.

function useSpeechRecognition() {
  const recognitionRef = useRef(null);

  // Evaluate once — both vendor-prefixed and standard APIs.
  const SpeechRecognitionClass =
    typeof window !== "undefined"
      ? window.SpeechRecognition || window.webkitSpeechRecognition || null
      : null;

  const isSupported = !!SpeechRecognitionClass;

  // Abort and clean up on unmount.
  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.abort();
        recognitionRef.current = null;
      }
    };
  }, []);

  const startListening = useCallback(({ onResult, onError }) => {
    if (!SpeechRecognitionClass) {
      onError("not-supported");
      return;
    }

    // Abort any in-progress session before starting a new one.
    if (recognitionRef.current) {
      recognitionRef.current.abort();
      recognitionRef.current = null;
    }

    const recognition = new SpeechRecognitionClass();
    recognition.lang = "ar-SA";
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    let resultFired = false;
    let errorFired  = false;

    // 1. هذي السطرين بتخلي المايك يركز على جملتك وما يفصل بسرعة
    recognition.continuous = false;
    recognition.interimResults = false;

    // 2. تحديث دالة اللقط
    recognition.onresult = (event) => {
      resultFired = true;
      const transcript = event.results[0]?.[0]?.transcript ?? "";
      
      // حماية: إذا المايك ما سمع شيء واضح، يوقف ولا يرسل طلب فاضي للسيرفر
      if (!transcript || transcript.trim() === "") {
          console.log("⚠️ المايك لقط صوت بس بدون كلام واضح.");
          return; 
      }
      
      console.log("🎤 المايك لقط كلامك بنجاح:", transcript);
      
      // هذي الدالة هي اللي بتاخذ كلامك وترسله للسيرفر
      onResult(transcript);
    };

    recognition.onerror = (event) => {
      // "aborted" means the user cancelled — not a surfaceable error.
      if (event.error === "aborted") return;
      console.error("Mic Error:", event.error);
      errorFired = true;
      onError(event.error);
    };

    // Fallback: some browsers end silently without firing onerror.
    recognition.onend = () => {
      recognitionRef.current = null; // Always clear the ref when done.
      if (!resultFired && !errorFired) {
        onError("no-speech");
      }
    };

    recognitionRef.current = recognition;

    try {
      recognition.start();
    } catch (startErr) {
      console.error("Mic Start Error:", startErr);
      recognitionRef.current = null;
      onError("start-failed");
    }
  // SpeechRecognitionClass is a module-level stable value — safe to omit.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const abortListening = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.abort();
      recognitionRef.current = null;
    }
  }, []);

  return { isSupported, startListening, abortListening };
}

// ─── Icon components ──────────────────────────────────────────────────────────

const MicIcon = ({ isRecording }) => (
  <svg
    width="22" height="22" viewBox="0 0 24 24" fill="none"
    stroke={isRecording ? "#FCA5A5" : "#A78BFA"}
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="9" y="2" width="6" height="11" rx="3" />
    <path d="M5 10a7 7 0 0 0 14 0" />
    <line x1="12" y1="17" x2="12" y2="21" />
    <line x1="9"  y1="21" x2="15" y2="21" />
  </svg>
);

const SparkleIcon = ({ size = 14, color = "#A78BFA" }) => (
  <svg
    width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
    style={{ flexShrink: 0 }} aria-hidden="true"
  >
    <path d="M12 2l2.4 6.4L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4L12 2z" />
  </svg>
);

const CloseIcon = ({ stroke = "#94A3B8" }) => (
  <svg
    width="11" height="11" viewBox="0 0 24 24" fill="none"
    stroke={stroke} strokeWidth="2.5" strokeLinecap="round"
    aria-hidden="true"
  >
    <line x1="18" y1="6"  x2="6"  y2="18" />
    <line x1="6"  y1="6"  x2="18" y2="18" />
  </svg>
);

// ─── Pulsing red recording indicator ─────────────────────────────────────────

const RecordingIndicator = ({ textColor }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 36 }}>
    <div style={{ position: "relative", width: 12, height: 12, flexShrink: 0 }}>
      <span style={{
        position: "absolute",
        inset: -5,
        borderRadius: "50%",
        background: "rgba(239,68,68,0.25)",
        animation: "copilotPulseRing 1.4s ease-out infinite",
      }} />
      <span style={{
        position: "absolute",
        inset: 0,
        borderRadius: "50%",
        background: "#EF4444",
        animation: "copilotRecordBlink 1.2s ease-in-out infinite",
      }} />
    </div>
    <span style={{
      fontSize: 13,
      color: textColor,
      fontStyle: "italic",
      flex: 1,
      textAlign: "right",
      lineHeight: 1.65,
      fontFamily: ARABIC_FONT,
    }}>
      {COPY.recording}
    </span>
  </div>
);

// ─── Thinking animation: three bouncing dots ──────────────────────────────────

const ThinkingDots = () => (
  <div style={{ display: "flex", gap: 5, alignItems: "center" }} dir="ltr">
    {[0, 1, 2].map((i) => (
      <span key={i} style={{
        width: 7, height: 7, borderRadius: "50%",
        background: "#A78BFA", display: "inline-block",
        animation: `copilotDot 1.3s ease-in-out ${i * 0.2}s infinite`,
      }} />
    ))}
  </div>
);

// ─── Action chip ──────────────────────────────────────────────────────────────

const ActionChip = ({ label, variant = "primary", onClick, prefersLight }) => {
  const [hovered, setHovered] = useState(false);

  const chipStyle =
    variant === "primary"
      ? {
          background: hovered ? "rgba(124,58,237,0.40)" : "rgba(124,58,237,0.22)",
          border: "1px solid rgba(139,92,246,0.50)",
          color: prefersLight ? "#5B21B6" : "#C4B5FD",
        }
      : prefersLight
        ? {
            background: hovered ? "rgba(15,23,42,0.08)" : "rgba(15,23,42,0.04)",
            border: "1px solid rgba(15,23,42,0.12)",
            color: "#475569",
          }
        : {
            background: hovered ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.06)",
            border: "1px solid rgba(255,255,255,0.10)",
            color: "#94A3B8",
          };

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        ...chipStyle,
        borderRadius: 20,
        padding: "6px 14px",
        fontSize: 12,
        fontWeight: 600,
        fontFamily: ARABIC_FONT,
        cursor: "pointer",
        outline: "none",
        transition: "background 0.15s ease, border-color 0.15s ease",
      }}
    >
      {label}
    </button>
  );
};

// ─── User speech bubble ───────────────────────────────────────────────────────

const UserBubble = ({ transcript, theme }) => (
  <div style={{
    background: "rgba(124,58,237,0.14)",
    border: "1px solid rgba(139,92,246,0.24)",
    borderRadius: "12px 4px 12px 12px",
    padding: "9px 12px",
    marginBottom: 12,
    fontFamily: ARABIC_FONT,
  }}>
    <p style={{
      margin: 0,
      fontSize: 13,
      lineHeight: 1.75,
      color: theme.textPrimary,
      textAlign: "right",
      wordBreak: "break-word",
    }}>
      {`أنت: ${transcript}`}
    </p>
  </div>
);

// ─── AI response bubble ───────────────────────────────────────────────────────

const AIResponseBubble = ({
  response, theme, onReroute, onDismiss, prefersLight,
  onNavigateTo, aiCoords,
  isLatest,   // controls whether action chips are visible
}) => (
  <div style={{
    animation: "copilotFadeIn 0.38s ease both",
    marginBottom: isLatest ? 0 : 14,
  }}>
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>

      {/* Avatar — sits on the right (RTL inline-start) */}
      <div aria-hidden="true" style={{
        width: 28, height: 28, borderRadius: "50%", flexShrink: 0,
        background: "linear-gradient(135deg, #7C3AED 0%, #2563EB 100%)",
        display: "flex", alignItems: "center", justifyContent: "center",
        marginTop: 2,
        boxShadow: "0 2px 10px rgba(124,58,237,0.45)",
      }}>
        <SparkleIcon size={12} color="#fff" />
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{
          margin: isLatest ? "0 0 12px" : "0",
          fontSize: 13,
          lineHeight: 1.75,
          color: theme.textPrimary,
          textAlign: "right",
          fontFamily: ARABIC_FONT,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}>
          {response}
        </p>

        {isLatest && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-start" }}>
            {aiCoords && (
              <ActionChip
                label={COPY.goNow}
                variant="primary"
                onClick={() => {
                  // Delegate entirely to handleNavigateTo in AICopilotWidget, which
                  // has access to userLocationRef and builds the full origin→destination
                  // Google Maps URL.  No navigation logic lives here.
                  if (onNavigateTo) onNavigateTo(aiCoords);
                }}
                prefersLight={prefersLight}
              />
            )}
            <ActionChip
              label={COPY.reroute}
              variant="secondary"
              onClick={onReroute}
              prefersLight={prefersLight}
            />
            <ActionChip
              label={COPY.dismiss}
              variant="secondary"
              onClick={onDismiss}
              prefersLight={prefersLight}
            />
          </div>
        )}
      </div>

    </div>
  </div>
);

// ─── Error message block ──────────────────────────────────────────────────────

const ErrorBlock = ({ message, onRetry, theme, prefersLight }) => (
  <div style={{ animation: "copilotFadeIn 0.28s ease both" }}>
    <div style={{
      background: "rgba(239,68,68,0.10)",
      border: "1px solid rgba(239,68,68,0.25)",
      borderRadius: 12,
      padding: "10px 13px",
      marginBottom: 12,
      fontSize: 12.5,
      lineHeight: 1.7,
      color: prefersLight ? "#B91C1C" : "#FCA5A5",
      textAlign: "right",
      fontFamily: ARABIC_FONT,
    }}>
      {message}
    </div>
    <ActionChip label={COPY.retry} variant="secondary" onClick={onRetry} prefersLight={prefersLight} />
  </div>
);

// ─── Chat panel ───────────────────────────────────────────────────────────────

const CopilotPanel = ({
  phase, userTranscript, conversationHistory, errorMessage,
  onClose, onReroute, onDismiss, onRetry,
  theme, prefersLight, onNavigateTo,
}) => {
  const isRecording = phase === PHASES.RECORDING;
  const isThinking  = phase === PHASES.THINKING;
  const isError     = phase === PHASES.ERROR;

  const bodyRef = useRef(null);

  // Scroll to the bottom whenever the conversation grows or phase changes.
  useEffect(() => {
    if (bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [conversationHistory, phase]);

  return (
    <div
      role="dialog"
      aria-label={COPY.title}
      dir="rtl"
      lang="ar"
      className="copilot-panel"
      style={{
        position: "fixed",
        bottom: COPILOT_PANEL_BOTTOM_PX,
        left: 14,
        width: "min(300px, calc(100vw - 28px))",
        maxHeight: "min(54vh, 360px)",
        zIndex: 9998,
        borderRadius: 18,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        animation: "copilotSlideUp 0.28s cubic-bezier(0.34, 1.56, 0.64, 1) both",
        fontFamily: ARABIC_FONT,
        ...theme.panel,
      }}
    >
      {/* ── Header ── */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "11px 14px 10px",
        borderBottom: `1px solid ${theme.divider}`,
        flexShrink: 0,
      }}>
        <SparkleIcon size={13} color="#A78BFA" />
        <span style={{
          fontSize: 13, fontWeight: 700, color: theme.textAccent,
          flexGrow: 1, textAlign: "right", lineHeight: 1.35,
        }}>
          {COPY.title}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={COPY.closePanel}
          onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
          onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.55")}
          style={{
            background: "none", border: "none", cursor: "pointer",
            padding: 5, borderRadius: 6,
            display: "flex", alignItems: "center", justifyContent: "center",
            opacity: 0.55, transition: "opacity 0.15s",
            outline: "none", flexShrink: 0,
          }}
        >
          <CloseIcon stroke={prefersLight ? "#64748B" : "#94A3B8"} />
        </button>
      </div>

      {/* ── Body ── */}
      <div
        ref={bodyRef}
        style={{
          padding: "14px 14px 16px",
          overflowY: "auto",
          flex: 1,
          minHeight: 0,
        }}
      >
        {/* ── Completed conversation turns ── */}
        {conversationHistory.map((item, idx) => {
          const isLastItem = idx === conversationHistory.length - 1;
          return item.role === "user" ? (
            <UserBubble key={idx} transcript={item.text} theme={theme} />
          ) : (
            <AIResponseBubble
              key={idx}
              response={item.text}
              theme={theme}
              prefersLight={prefersLight}
              onNavigateTo={onNavigateTo}
              aiCoords={item.coords}
              onReroute={onReroute}
              onDismiss={onDismiss}
              isLatest={isLastItem}
            />
          );
        })}

        {/* ── Current-turn in-progress state ── */}
        {isRecording && (
          <>
            {userTranscript && <UserBubble transcript={userTranscript} theme={theme} />}
            <RecordingIndicator textColor={theme.textMuted} />
          </>
        )}

        {isThinking && (
          <>
            {userTranscript && <UserBubble transcript={userTranscript} theme={theme} />}
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <ThinkingDots />
              <span style={{
                fontSize: 13, color: theme.textMuted, fontStyle: "italic",
                flex: 1, textAlign: "right", lineHeight: 1.65,
                fontFamily: ARABIC_FONT,
              }}>
                {COPY.thinking}
              </span>
            </div>
          </>
        )}

        {isError && (
          <ErrorBlock
            message={errorMessage}
            onRetry={onRetry}
            theme={theme}
            prefersLight={prefersLight}
          />
        )}
      </div>
    </div>
  );
};

// ─── FAB ─────────────────────────────────────────────────────────────────────

const CopilotFab = ({ isOpen, isRecording, onClick, fabIdleBg }) => {
  const [hovered, setHovered] = useState(false);

  const borderColor = isRecording
    ? "rgba(239,68,68,0.85)"
    : hovered
      ? "rgba(139,92,246,0.60)"
      : "rgba(139,92,246,0.28)";

  const shadow = isRecording
    ? "0 0 26px rgba(239,68,68,0.55), 0 4px 20px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.08)"
    : hovered
      ? "0 0 16px rgba(124,58,237,0.35), 0 4px 18px rgba(0,0,0,0.50), inset 0 1px 0 rgba(255,255,255,0.06)"
      : "0 4px 18px rgba(0,0,0,0.48), inset 0 1px 0 rgba(255,255,255,0.06)";

  const background = isRecording ? "rgba(239, 68, 68, 0.22)" : fabIdleBg;

  return (
    <div
      className="copilot-fab-wrapper"
      style={{
        position: "fixed",
        bottom: COPILOT_FAB_BOTTOM_PX,
        left: 20,
        zIndex: 9999,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      {isRecording && (
        <span aria-hidden="true" style={{
          position: "absolute",
          inset: 0,
          borderRadius: "50%",
          border: "2px solid rgba(239,68,68,0.50)",
          animation: "copilotPulseRing 1.4s cubic-bezier(0.215,0.61,0.355,1) infinite",
          pointerEvents: "none",
        }} />
      )}

      <button
        type="button"
        onClick={onClick}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        aria-label={isOpen ? COPY.fabClose : COPY.fabOpen}
        aria-expanded={isOpen}
        title={COPY.fabTitle}
        style={{
          width: COPILOT_FAB_SIZE_PX,
          height: COPILOT_FAB_SIZE_PX,
          borderRadius: "50%",
          background,
          backdropFilter: "blur(18px)",
          WebkitBackdropFilter: "blur(18px)",
          border: `1.5px solid ${borderColor}`,
          boxShadow: shadow,
          cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
          transform: hovered && !isRecording ? "scale(1.1)" : "scale(1)",
          transition:
            "transform 0.18s cubic-bezier(0.34,1.56,0.64,1), " +
            "box-shadow 0.2s ease, border-color 0.2s ease, background 0.2s ease",
          outline: "none",
        }}
      >
        <MicIcon isRecording={isRecording} />
      </button>
    </div>
  );
};

// ─── Root widget ──────────────────────────────────────────────────────────────

function AICopilotWidget({ onNavigateTo, trafficContext, userLocation }) {
  const [phase, setPhase]               = useState(PHASES.IDLE);
  const [userTranscript, setTranscript] = useState("");
  const [errorMessage, setErrorMessage] = useState("");

  // Accumulated conversation: [{ role: "user"|"assistant", text: string, coords: array|null }]
  // Completed turns live here; the in-progress turn is in userTranscript above.
  const [conversationHistory, setConversationHistory] = useState([]);

  const abortCtrlRef = useRef(null);

  // Refs keep both callCopilotAPI stable without chaining changing values through deps.
  const conversationHistoryRef = useRef([]);
  conversationHistoryRef.current = conversationHistory;

  // trafficContext is owned by TrafficMap and changes as incidents/predictions update.
  // Reading via ref ensures callCopilotAPI always sends the latest snapshot without
  // needing to be recreated on every context change.
  const trafficContextRef = useRef(null);
  trafficContextRef.current = trafficContext ?? null;

  // userLocation biases TomTom POI search toward the user so we surface the
  // nearest branch.  Intentionally kept null when the user has not granted GPS
  // permission — sending a hardcoded Riyadh-center fallback here was the root
  // cause of POI searches snapping to Central Riyadh instead of the neighborhood
  // the user explicitly mentioned.  The backend handles null gracefully.
  const userLocationRef = useRef(null);
  userLocationRef.current = userLocation ?? null;

  const prefersLight = usePrefersLightScheme();
  const theme        = prefersLight ? GLASS_LIGHT : GLASS_DARK;

  const { isSupported, startListening, abortListening } = useSpeechRecognition();

  useEffect(() => {
    ensureKeyframesInjected();
  }, []);

  // Cancel any in-flight API request on unmount.
  useEffect(() => {
    return () => abortCtrlRef.current?.abort();
  }, []);

  // ── API call ──────────────────────────────────────────────────────────────

  const callCopilotAPI = useCallback(async (transcript) => {
    abortCtrlRef.current?.abort();
    const ctrl = new AbortController();
    abortCtrlRef.current = ctrl;

    if (!transcript || transcript.trim() === "") return;

    try {
      // Include conversation history so the model can resolve follow-up queries
      // like "وش ثاني فرع؟" with full context.
      const historyForAPI = conversationHistoryRef.current.map(item => ({
        role: item.role,
        text: item.text,
      }));

      const res = await fetch(COPILOT_API_URL, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        signal:  ctrl.signal,
        body:    JSON.stringify({
          message:        transcript,
          history:        historyForAPI,
          trafficContext: trafficContextRef.current,
          userLocation:   userLocationRef.current,
        }),
      });

      if (ctrl.signal.aborted) return;

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const pickText = (v) =>
          typeof v === "string" && v.trim() !== "" ? v.trim() : "";
        const friendly =
          pickText(body.reply) ||
          pickText(body.message) ||
          pickText(body.error) ||
          COPY.apiGracefulError;
        const fallbackTurn = [
          { role: "user", text: transcript, coords: null },
          {
            role: "assistant",
            text: friendly,
            coords: body.coords ?? null,
          },
        ];
        setConversationHistory((prev) =>
          [...prev, ...fallbackTurn].slice(-MAX_HISTORY_MESSAGES)
        );
        setTranscript("");
        setErrorMessage("");
        setPhase(PHASES.RESPONDED);
        return;
      }

      const data = await res.json();

      // Commit the completed turn to history, then clear the current-turn state.
      const newTurn = [
        { role: "user",      text: transcript,       coords: null             },
        { role: "assistant", text: data.reply ?? "",  coords: data.coords ?? null },
      ];
      setConversationHistory(prev =>
        [...prev, ...newTurn].slice(-MAX_HISTORY_MESSAGES)
      );
      setTranscript("");
      setPhase(PHASES.RESPONDED);
    } catch (err) {
      if (err.name === "AbortError") return;
      console.error("Fetch Error:", err);
      const friendly = COPY.apiGracefulError;
      const fallbackTurn = [
        { role: "user", text: transcript, coords: null },
        { role: "assistant", text: friendly, coords: null },
      ];
      setConversationHistory((prev) =>
        [...prev, ...fallbackTurn].slice(-MAX_HISTORY_MESSAGES)
      );
      setTranscript("");
      setErrorMessage("");
      setPhase(PHASES.RESPONDED);
    }
  // Stable: reads history via ref, no dep on conversationHistory.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Close / full reset ────────────────────────────────────────────────────

  const handleClose = useCallback(() => {
    abortListening();
    abortCtrlRef.current?.abort();
    setConversationHistory([]);
    setTranscript("");
    setErrorMessage("");
    setPhase(PHASES.IDLE);
  }, [abortListening]);

  // ── Start / continue listening ────────────────────────────────────────────

  const beginListening = useCallback(() => {
    if (!isSupported) {
      setErrorMessage(COPY.errorNotSupported);
      setPhase(PHASES.ERROR);
      return;
    }

    // Explicitly terminate any lingering recognition session before starting a
    // new one.  Without this, browsers can leave the mic in an "active-but-idle"
    // state after a RESPONDED phase, causing the next startListening call to
    // silently fail or fire "no-speech" immediately.
    abortListening();

    setTranscript("");
    setErrorMessage("");
    setPhase(PHASES.RECORDING);

    startListening({
      onResult: (transcript) => {
        setTranscript(transcript);
        setPhase(PHASES.THINKING);
        callCopilotAPI(transcript);
      },
      // Functional setState guards against late-arriving callbacks overwriting
      // the phase after the user has already closed or continued.
      onError: (error) => {
        const msg =
          error === "not-supported"
            ? COPY.errorNotSupported
            : error === "no-speech" || error === "audio-capture"
              ? COPY.errorNoSpeech
              : COPY.errorApi;

        setPhase((cur) => {
          if (cur !== PHASES.RECORDING) return cur;
          setErrorMessage(msg);
          return PHASES.ERROR;
        });
      },
    });
  }, [isSupported, abortListening, startListening, callCopilotAPI]);

  // ── FAB click handler ─────────────────────────────────────────────────────

  const handleFabClick = useCallback(() => {
    if (phase === PHASES.RECORDING) {
      // Cancel current recording. If history exists, return to the last
      // response instead of closing the panel entirely.
      abortListening();
      abortCtrlRef.current?.abort();
      setTranscript("");
      setPhase(conversationHistoryRef.current.length > 0 ? PHASES.RESPONDED : PHASES.IDLE);
      return;
    }
    if (phase === PHASES.THINKING) {
      // Cancel in-flight API call with the same logic as above.
      abortCtrlRef.current?.abort();
      setTranscript("");
      setPhase(conversationHistoryRef.current.length > 0 ? PHASES.RESPONDED : PHASES.IDLE);
      return;
    }
    if (phase === PHASES.ERROR) {
      beginListening();
      return;
    }
    // RESPONDED or IDLE — continue / start the conversation.
    beginListening();
  }, [phase, abortListening, beginListening]);

  // Change Route: keep history context, start a new voice input for the new destination.
  const handleReroute = useCallback(() => beginListening(), [beginListening]);
  // Dismiss: close the panel and clear everything.
  const handleDismiss = useCallback(() => handleClose(),    [handleClose]);
  const handleRetry   = useCallback(() => beginListening(), [beginListening]);

  // ── Navigation handler ────────────────────────────────────────────────────
  // Single source of truth for the "انطلق الآن" action.
  // 1. Notifies the parent map component to draw the in-app route.
  // 2. Opens Google Maps with an explicit origin→destination URL so the user
  //    gets a real turn-by-turn route, not just a destination pin.
  //    Origin comes from userLocationRef so we always use the freshest GPS fix
  //    without needing to thread the prop through every child component.
  const handleNavigateTo = useCallback((coords) => {
    if (!coords) return;

    // In-app route update (parent TrafficMap handler).
    if (onNavigateTo) onNavigateTo(coords);

    const [destLat, destLon] = coords;
    const userLoc = userLocationRef.current;

    const hasValidOrigin =
      Array.isArray(userLoc) &&
      userLoc.length === 2 &&
      typeof userLoc[0] === "number" && !Number.isNaN(userLoc[0]) &&
      typeof userLoc[1] === "number" && !Number.isNaN(userLoc[1]);

    const mapsUrl = hasValidOrigin
      ? `https://www.google.com/maps/dir/?api=1&origin=${userLoc[0]},${userLoc[1]}&destination=${destLat},${destLon}`
      : `https://www.google.com/maps/dir/?api=1&destination=${destLat},${destLon}`;

    window.open(mapsUrl, "_blank", "noopener,noreferrer");
  // onNavigateTo is a stable prop reference; userLocationRef is a ref (never stale).
  }, [onNavigateTo]); // eslint-disable-line react-hooks/exhaustive-deps

  const isOpen      = phase !== PHASES.IDLE;
  const isRecording = phase === PHASES.RECORDING;

  return (
    <>
      {isOpen && (
        <CopilotPanel
          phase={phase}
          userTranscript={userTranscript}
          conversationHistory={conversationHistory}
          errorMessage={errorMessage}
          onClose={handleClose}
          onReroute={handleReroute}
          onDismiss={handleDismiss}
          onRetry={handleRetry}
          theme={theme}
          prefersLight={prefersLight}
          onNavigateTo={handleNavigateTo}
        />
      )}

      <CopilotFab
        isOpen={isOpen}
        isRecording={isRecording}
        onClick={handleFabClick}
        fabIdleBg={theme.fabIdleBg}
      />
    </>
  );
}

export default AICopilotWidget;
