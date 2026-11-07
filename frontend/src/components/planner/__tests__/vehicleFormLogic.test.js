import { buildVehiclePayload, isVehicleFormValid } from "../VehicleForm";

describe("VehicleForm logic", () => {
  test("standard vehicles are valid with make and model only (no engine size)", () => {
    const form = {
      modified: false,
      manufacturer: "Toyota",
      model: "Corolla",
      year: "2020",
      otherManufacturer: "",
      otherModel: "",
      otherYear: "",
      engineDisplacementL: "",
      forcedInduction: "unknown",
      modifications: "",
      fuelType: "gasoline",
      isDefault: false,
    };
    expect(isVehicleFormValid(form)).toBe(true);
    const payload = buildVehiclePayload(form);
    expect(payload.engineDisplacementL).toBeNull();
    expect(payload.manufacturer).toBe("Toyota");
    expect(payload.model).toBe("Corolla");
  });

  test("modified vehicles require identity, engine, or modification notes", () => {
    expect(
      isVehicleFormValid({
        modified: true,
        manufacturer: "",
        model: "",
        year: "",
        otherManufacturer: "",
        otherModel: "",
        otherYear: "",
        engineDisplacementL: "",
        forcedInduction: "turbo",
        modifications: "",
        fuelType: "gasoline",
        isDefault: false,
      })
    ).toBe(false);

    expect(
      isVehicleFormValid({
        modified: true,
        manufacturer: "",
        model: "",
        year: "",
        otherManufacturer: "",
        otherModel: "",
        otherYear: "",
        engineDisplacementL: "2.5",
        forcedInduction: "turbo",
        modifications: "",
        fuelType: "gasoline",
        isDefault: false,
      })
    ).toBe(true);
  });
});
