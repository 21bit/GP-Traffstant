import React, { createContext, useContext, useEffect } from "react";
import { translations } from "./translations";

const LanguageContext = createContext(null);

/**
 * Provides the Arabic translation helper `t()` and `isRTL` (always true)
 * to the component tree. Language is fixed to Arabic — no switching needed.
 */
export const LanguageProvider = ({ children }) => {
  const t = (key) => translations.ar?.[key] ?? key;
  const isRTL = true;

  useEffect(() => {
    document.documentElement.dir = "rtl";
    document.documentElement.lang = "ar";
  }, []);

  return (
    <LanguageContext.Provider value={{ t, isRTL }}>
      {children}
    </LanguageContext.Provider>
  );
};

/**
 * Convenience hook — throws if used outside <LanguageProvider>.
 */
export const useLanguage = () => {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error("useLanguage must be used inside <LanguageProvider>");
  return ctx;
};
