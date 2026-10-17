const {
  estimateVehicleEfficiency,
  buildEfficiencyPrompt,
  clearEfficiencyCache,
  normalizeVehicle,
} = require("../vehicleEfficiency");

const stock = {
  modified: false,
  manufacturer: "Hyundai",
  model: "Elantra",
  year: 2021,
  fuelType: "gasoline",
};

describe("normalizeVehicle", () => {
  test("requires manufacturer and model for a standard vehicle", () => {
    expect(() => normalizeVehicle({ modified: false, manufacturer: "Kia" })).toThrow(
      /model/i
    );
  });

  test("accepts a modified vehicle identified only by engine size", () => {
    const vehicle = normalizeVehicle({
      modified: true,
      engineDisplacementL: 2.5,
      forcedInduction: "turbo",
      fuelType: "gasoline",
    });
    expect(vehicle.engineDisplacementL).toBe(2.5);
    expect(vehicle.forcedInduction).toBe("turbo");
    expect(vehicle.manufacturer).toBe("");
  });

  test("rejects a modified vehicle with no usable description", () => {
    expect(() => normalizeVehicle({ modified: true, forcedInduction: "turbo" })).toThrow(
      /manufacturer|engine|modifications/i
    );
  });

  test("rejects an impossible year and displacement", () => {
    expect(() =>
      normalizeVehicle({ ...stock, year: 1800 })
    ).toThrow(/year/i);
    expect(() =>
      normalizeVehicle({ ...stock, modified: true, engineDisplacementL: 0 })
    ).toThrow(/displacement/i);
  });
});

describe("buildEfficiencyPrompt", () => {
  test("asks for km/L and does not include a trip distance or a cost request as an output", () => {
    const prompt = buildEfficiencyPrompt(normalizeVehicle(stock));
    expect(prompt).toMatch(/km\/L|kilometers per liter/);
    expect(prompt).toMatch(/Hyundai/);
    expect(prompt).toMatch(/Elantra/);
    expect(prompt).toMatch(/Do not calculate liters/);
    expect(prompt).not.toMatch(/\b\d+(\.\d+)?\s*km\b/);
  });
});

describe("estimateVehicleEfficiency", () => {
  beforeEach(() => {
    clearEfficiencyCache();
  });

  test("reads a structured successful response", async () => {
    const result = await estimateVehicleEfficiency(stock, {
      generate: async () =>
        JSON.stringify({
          kmPerLiter: 16.4,
          basis: "published_specification",
          explanation: "استهلاك مجمع منشور.",
          confidence: "high",
        }),
    });
    expect(result.status).toBe("ok");
    expect(result.kmPerLiter).toBe(16.4);
    expect(result.basis).toBe("published_specification");
    expect(result.confidence).toBe("high");
  });

  test("treats a malformed response as unusable", async () => {
    const result = await estimateVehicleEfficiency(stock, {
      generate: async () => "sure, about average",
    });
    expect(result.kmPerLiter).toBeNull();
    expect(result.status).toBe("malformed");
  });

  test("rejects an implausible efficiency instead of using it", async () => {
    const result = await estimateVehicleEfficiency(stock, {
      generate: async () =>
        JSON.stringify({
          kmPerLiter: 250,
          basis: "approximation",
          explanation: "too high",
          confidence: "high",
        }),
    });
    expect(result.status).toBe("uncertain");
    expect(result.kmPerLiter).toBeNull();
    expect(result.confidence).toBeNull();
  });

  test("keeps an explicit unavailable result", async () => {
    const result = await estimateVehicleEfficiency(
      {
        modified: true,
        modifications: "unknown engine swap",
        fuelType: "unknown",
      },
      {
        generate: async () =>
          JSON.stringify({
            kmPerLiter: null,
            basis: "unavailable",
            explanation: "الوصف غير كافٍ.",
            confidence: null,
          }),
      }
    );
    expect(result.status).toBe("unavailable");
    expect(result.kmPerLiter).toBeNull();
  });

  test("reports a timeout without throwing", async () => {
    const result = await estimateVehicleEfficiency(stock, {
      timeoutMs: 20,
      generate: () => new Promise(() => {}),
    });
    expect(result.status).toBe("timeout");
    expect(result.kmPerLiter).toBeNull();
  });

  test("reports a rate limit without throwing", async () => {
    const result = await estimateVehicleEfficiency(stock, {
      generate: async () => {
        const err = new Error("429 Too Many Requests");
        err.status = 429;
        throw err;
      },
    });
    expect(result.status).toBe("rate_limited");
    expect(result.kmPerLiter).toBeNull();
  });

  test("reports other provider failures without throwing", async () => {
    const result = await estimateVehicleEfficiency(stock, {
      generate: async () => {
        throw new Error("socket hang up");
      },
    });
    expect(result.status).toBe("provider_error");
  });

  test("does not call the provider again for the same vehicle", async () => {
    const generate = jest.fn(async () =>
      JSON.stringify({
        kmPerLiter: 14,
        basis: "approximation",
        explanation: "تقدير.",
        confidence: null,
      })
    );
    await estimateVehicleEfficiency(stock, { generate });
    const second = await estimateVehicleEfficiency(stock, { generate });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(second.cached).toBe(true);
    expect(second.kmPerLiter).toBe(14);
  });
});
