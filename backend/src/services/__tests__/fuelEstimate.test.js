const { calculateTripFuel, buildFuelEstimate } = require("../fuelEstimate");
const { clearEfficiencyCache } = require("../vehicleEfficiency");

const corolla = {
  modified: false,
  manufacturer: "Toyota",
  model: "Corolla",
  year: 2022,
  fuelType: "gasoline",
};

describe("calculateTripFuel", () => {
  test("divides distance by km/L and multiplies liters by the grade price", () => {
    const result = calculateTripFuel({
      distanceKm: 100,
      kmPerLiter: 15,
      pricePerLiterSar: 2.18,
    });
    expect(result.liters).toBe(6.67);
    expect(result.costSar).toBe(14.54);
  });

  test("uses the grade 95 price when that price is supplied", () => {
    const result = calculateTripFuel({
      distanceKm: 100,
      kmPerLiter: 15,
      pricePerLiterSar: 2.33,
    });
    expect(result.liters).toBe(6.67);
    expect(result.costSar).toBe(15.54);
  });

  test("rejects a missing, zero, or negative distance", () => {
    expect(() =>
      calculateTripFuel({ distanceKm: 0, kmPerLiter: 15, pricePerLiterSar: 2.18 })
    ).toThrow(/distance/i);
    expect(() =>
      calculateTripFuel({ distanceKm: -5, kmPerLiter: 15, pricePerLiterSar: 2.18 })
    ).toThrow(/distance/i);
    expect(() =>
      calculateTripFuel({
        distanceKm: "none",
        kmPerLiter: 15,
        pricePerLiterSar: 2.18,
      })
    ).toThrow(/distance/i);
  });

  test("rejects a non-positive efficiency and avoids division by zero", () => {
    expect(() =>
      calculateTripFuel({ distanceKm: 10, kmPerLiter: 0, pricePerLiterSar: 2.18 })
    ).toThrow(/efficiency/i);
    expect(() =>
      calculateTripFuel({ distanceKm: 10, kmPerLiter: -1, pricePerLiterSar: 2.18 })
    ).toThrow(/efficiency/i);
  });
});

describe("buildFuelEstimate", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.FUEL_PRICE_91;
    delete process.env.FUEL_PRICE_95;
    clearEfficiencyCache();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
    clearEfficiencyCache();
  });

  test("calculates grade 91 and 95 from a mocked efficiency", async () => {
    const generate = async () =>
      JSON.stringify({
        kmPerLiter: 15,
        basis: "published_specification",
        explanation: "رقم مجمع منشور.",
        confidence: "high",
      });

    const grade91 = await buildFuelEstimate(
      { vehicle: corolla, distanceKm: 100, fuelGrade: "91" },
      { generate }
    );
    const grade95 = await buildFuelEstimate(
      { vehicle: corolla, distanceKm: 100, fuelGrade: "95" },
      { generate, bypassCache: true }
    );

    expect(grade91.fuel.liters).toBe(6.67);
    expect(grade91.fuel.costSar).toBe(14.54);
    expect(grade91.price.pricePerLiterSar).toBe(2.18);
    expect(grade95.fuel.costSar).toBe(15.54);
    expect(grade95.price.pricePerLiterSar).toBe(2.33);
  });

  test("recalculates another distance from a known efficiency without calling the model", async () => {
    const generate = jest.fn();
    const result = await buildFuelEstimate(
      { kmPerLiter: 15, distanceKm: 50, fuelGrade: "91", vehicle: corolla },
      { generate }
    );
    expect(generate).not.toHaveBeenCalled();
    expect(result.fuel.liters).toBe(3.33);
    expect(result.fuel.costSar).toBe(7.26);
  });

  test("returns an unavailable efficiency instead of a cost when the model cannot estimate", async () => {
    const result = await buildFuelEstimate(
      { vehicle: corolla, distanceKm: 40, fuelGrade: "91" },
      {
        generate: async () =>
          JSON.stringify({
            kmPerLiter: null,
            basis: "unavailable",
            explanation: "لا توجد بيانات كافية.",
            confidence: null,
          }),
      }
    );
    expect(result.status).toBe("unavailable");
    expect(result.fuel).toBeNull();
  });

  test("does not price diesel with gasoline 91 or 95", async () => {
    const result = await buildFuelEstimate(
      {
        vehicle: { ...corolla, model: "Hilux", fuelType: "diesel", modified: true },
        distanceKm: 100,
        fuelGrade: "91",
      },
      {
        generate: async () =>
          JSON.stringify({
            kmPerLiter: 12,
            basis: "approximation",
            explanation: "تقدير تقريبي.",
            confidence: null,
          }),
      }
    );
    expect(result.efficiency.kmPerLiter).toBe(12);
    expect(result.fuel).toBeNull();
    expect(result.costStatus).toBe("unavailable");
  });

  test("rejects an invalid grade and a missing route distance", async () => {
    await expect(
      buildFuelEstimate(
        { vehicle: corolla, distanceKm: 10, fuelGrade: "98" },
        { generate: async () => "{}" }
      )
    ).rejects.toThrow(/91 or 95/);

    await expect(
      buildFuelEstimate(
        { kmPerLiter: 15, distanceKm: 0, fuelGrade: "91" },
        { generate: async () => "{}" }
      )
    ).rejects.toThrow(/distance/i);
  });

  test("fails open when the API key is missing", async () => {
    delete process.env.GEMINI_API_KEY;
    const result = await buildFuelEstimate({
      vehicle: corolla,
      distanceKm: 20,
      fuelGrade: "91",
    });
    expect(result.status).toBe("unavailable");
    expect(result.fuel).toBeNull();
    expect(result.efficiency.explanation).toMatch(/GEMINI_API_KEY/);
  });
});
