import React, { useState } from "react";
import { useAuth } from "../../AuthContext";
import { useLanguage } from "../../LanguageContext";

export default function AuthModal({ open, onClose }) {
  const { login, register } = useAuth();
  const { t } = useLanguage();
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  const submit = async (event) => {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (mode === "login") {
        await login(email, password);
      } else {
        await register(email, password, name);
      }
      onClose();
    } catch (err) {
      setError(err.message || t("authFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="planner-modal-backdrop" onClick={onClose}>
      <div
        className="planner-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <h2>{mode === "login" ? t("login") : t("register")}</h2>
        <p className="planner-muted">{t("authSubtitle")}</p>
        <form onSubmit={submit} className="planner-form">
          {mode === "register" && (
            <label>
              {t("nameOptional")}
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
              />
            </label>
          )}
          <label>
            {t("email")}
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
            />
          </label>
          <label>
            {t("password")}
            <input
              type="password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
            />
          </label>
          {error && <div className="planner-error">{error}</div>}
          <button type="submit" className="planner-btn primary" disabled={busy}>
            {busy ? t("pleaseWait") : mode === "login" ? t("login") : t("createAccount")}
          </button>
        </form>
        <button
          type="button"
          className="planner-link"
          onClick={() => {
            setMode(mode === "login" ? "register" : "login");
            setError("");
          }}
        >
          {mode === "login" ? t("needAccount") : t("haveAccount")}
        </button>
      </div>
    </div>
  );
}
