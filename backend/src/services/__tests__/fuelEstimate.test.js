const { estimateFuel, getFuelDefaults } = require("../fuelEstimate");

describe("getFuelDefaults", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  test("falls back to hardcoded defaults when env vars are missing", () => {
    delete process.env.FUEL_LITERS_PER_100KM;
    delete process.env.FUEL_PRICE_SAR;

    expect(getFuelDefaults()).toEqual({
      litersPer100Km: 9.5,
      priceSar: 2.18,
    });
  });

  test("reads values from environment variables when present", () => {
    process.env.FUEL_LITERS_PER_100KM = "7";
    process.env.FUEL_PRICE_SAR = "3";

    expect(getFuelDefaults()).toEqual({
      litersPer100Km: 7,
      priceSar: 3,
    });
  });
});

describe("estimateFuel", () => {
  beforeEach(() => {
    process.env.FUEL_LITERS_PER_100KM = "10";
    process.env.FUEL_PRICE_SAR = "2";
  });

  test("computes liters and cost for a normal distance", () => {
    // 100km at 10L/100km = 10L, at 2 SAR/L = 20 SAR
    const result = estimateFuel(100);
    expect(result.liters).toBe(10);
    expect(result.costSar).toBe(20);
  });

  test("returns 0 liters/cost for a distance of 0", () => {
    const result = estimateFuel(0);
    expect(result.liters).toBe(0);
    expect(result.costSar).toBe(0);
  });

  test("treats negative distance as 0 (never a negative fuel cost)", () => {
    const result = estimateFuel(-50);
    expect(result.liters).toBe(0);
    expect(result.costSar).toBe(0);
  });

  test("treats non-numeric distance as 0 instead of throwing", () => {
    const result = estimateFuel("not-a-number");
    expect(result.liters).toBe(0);
    expect(result.costSar).toBe(0);
  });

  test("rounds liters and cost to 2 decimal places", () => {
    process.env.FUEL_LITERS_PER_100KM = "9.5";
    process.env.FUEL_PRICE_SAR = "2.18";
    const result = estimateFuel(33.333);
    // 33.333 * 9.5 / 100 = 3.166635 -> rounds to 3.17
    expect(result.liters).toBe(3.17);
    expect(result.costSar).toBeCloseTo(3.17 * 2.18, 2);
  });

  test("echoes back the rate/price used for the calculation", () => {
    const result = estimateFuel(50);
    expect(result.litersPer100Km).toBe(10);
    expect(result.priceSar).toBe(2);
  });
});
