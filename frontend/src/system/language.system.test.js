import { render, screen } from "@testing-library/react";
import { LanguageProvider, useLanguage } from "../LanguageContext";
import { translations } from "../translations";

const PLANNER_KEYS = [
  "planTrip",
  "adviceLeaveNow",
  "adviceWait",
  "healthScore",
  "peakTrends",
  "fuelEstimate",
];

function PlannerLabels() {
  const { t, isRTL } = useLanguage();
  return (
    <div>
      {PLANNER_KEYS.map((key) => (
        <span key={key}>{t(key)}</span>
      ))}
      <span>{isRTL ? "rtl" : "ltr"}</span>
    </div>
  );
}

describe("system: planner language", () => {
  test("the running screen shows the Arabic planner labels", () => {
    render(
      <LanguageProvider>
        <PlannerLabels />
      </LanguageProvider>
    );

    expect(screen.getByText("خطّط رحلتك")).toBeTruthy();
    expect(screen.getByText("غادر الآن")).toBeTruthy();
    expect(screen.getByText("انتظر قبل المغادرة")).toBeTruthy();
    expect(screen.getByText("صحة الطريق")).toBeTruthy();
    expect(screen.getByText("اتجاهات ساعة الذروة")).toBeTruthy();
    expect(screen.getByText("تقدير الوقود")).toBeTruthy();
    expect(screen.getByText("rtl")).toBeTruthy();
    expect(document.documentElement.lang).toBe("ar");
    expect(document.documentElement.dir).toBe("rtl");
  });

  test("the same planner labels exist in English", () => {
    expect(translations.en.planTrip).toBe("Plan your trip");
    expect(translations.en.adviceLeaveNow).toBe("Leave now");
    expect(translations.en.adviceWait).toBe("Wait before leaving");
    expect(translations.en.healthScore).toBe("Health");
    expect(translations.en.peakTrends).toBe("Peak-hour trends");
    expect(translations.en.fuelEstimate).toBe("Estimated fuel");
  });
});
