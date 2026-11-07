/**
 * Lightweight checks that departure copy keys and slot selection stay coherent.
 */
describe("departure recommendation UX data", () => {
  test("leave-now recommendation maps to offset 0 slot", () => {
    const recommendation = { action: "leave_now", waitMinutes: 0, estimatedTimeSavedMinutes: 0 };
    const departureComparison = [
      { offsetMinutes: 0, etaMinutes: 28, departAt: "2026-11-06T15:00:00.000Z" },
      { offsetMinutes: 15, etaMinutes: 24, departAt: "2026-11-06T15:15:00.000Z" },
    ];
    const isWait = recommendation.action === "wait";
    const slot = isWait
      ? departureComparison.find((s) => s.offsetMinutes === recommendation.waitMinutes)
      : departureComparison.find((s) => s.offsetMinutes === 0);
    expect(slot.offsetMinutes).toBe(0);
    expect(slot.etaMinutes).toBe(28);
  });

  test("wait recommendation picks the matching offset", () => {
    const recommendation = {
      action: "wait",
      waitMinutes: 15,
      estimatedTimeSavedMinutes: 4,
    };
    const departureComparison = [
      { offsetMinutes: 0, etaMinutes: 28 },
      { offsetMinutes: 15, etaMinutes: 24 },
      { offsetMinutes: 30, etaMinutes: 26 },
    ];
    const slot = departureComparison.find(
      (s) => s.offsetMinutes === recommendation.waitMinutes
    );
    expect(slot.etaMinutes).toBe(24);
  });
});
