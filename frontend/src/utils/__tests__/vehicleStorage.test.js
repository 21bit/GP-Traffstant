import {
  removeLocalVehicle,
  setLocalDefault,
  upsertLocalVehicle,
  vehicleDisplayName,
} from "../vehicleStorage";

describe("vehicleStorage", () => {
  test("adds multiple vehicles and defaults the first", () => {
    const first = upsertLocalVehicle([], {
      manufacturer: "Toyota",
      model: "Camry",
      modified: false,
      fuelType: "gasoline",
    });
    expect(first.vehicle.isDefault).toBe(true);

    const second = upsertLocalVehicle(first.vehicles, {
      manufacturer: "Kia",
      model: "K5",
      modified: false,
      fuelType: "gasoline",
    });
    expect(second.vehicles).toHaveLength(2);
    expect(second.vehicles.filter((v) => v.isDefault)).toHaveLength(1);
  });

  test("edits, defaults, and deletes vehicles", () => {
    let { vehicles, vehicle } = upsertLocalVehicle([], {
      manufacturer: "Nissan",
      model: "Sunny",
      modified: false,
      fuelType: "gasoline",
    });
    ({ vehicles } = upsertLocalVehicle(
      vehicles,
      {
        manufacturer: "Nissan",
        model: "Altima",
        modified: false,
        fuelType: "gasoline",
      },
      null
    ));
    const altima = vehicles.find((v) => v.model === "Altima");
    vehicles = setLocalDefault(vehicles, altima.id);
    expect(vehicles.find((v) => v.isDefault).model).toBe("Altima");

    ({ vehicles, vehicle } = upsertLocalVehicle(
      vehicles,
      {
        manufacturer: "Nissan",
        model: "Altima",
        year: 2024,
        modified: false,
        fuelType: "gasoline",
        isDefault: true,
      },
      altima.id
    ));
    expect(vehicle.year).toBe(2024);

    vehicles = removeLocalVehicle(vehicles, vehicle.id);
    expect(vehicles.find((v) => v.model === "Altima")).toBeUndefined();
    expect(vehicles[0].isDefault).toBe(true);
  });

  test("builds a readable display name", () => {
    expect(
      vehicleDisplayName({
        manufacturer: "Toyota",
        model: "Corolla",
        year: 2019,
      })
    ).toBe("Toyota Corolla 2019");
  });
});
