const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.TRAFFSTANT_DB_PATH = path.join(
  os.tmpdir(),
  `traffstant-vehicles-${process.pid}.db`
);

const { db, DB_PATH } = require("../../db");
const {
  createVehicle,
  listVehicles,
  updateVehicle,
  setDefaultVehicle,
  deleteVehicle,
} = require("../vehicles");
const { registerUser } = require("../../auth");

afterAll(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(DB_PATH + suffix, { force: true });
  }
});

describe("vehicles service", () => {
  let userId;

  beforeAll(() => {
    const { user } = registerUser({
      email: `vehicles-${process.pid}@traffstant.test`,
      password: "test-pass-1",
      name: "Driver",
    });
    userId = user.id;
  });

  test("creates multiple vehicles and marks the first as default", () => {
    const first = createVehicle(userId, {
      modified: false,
      manufacturer: "Toyota",
      model: "Corolla",
      year: 2020,
      fuelType: "gasoline",
    });
    const second = createVehicle(userId, {
      modified: false,
      manufacturer: "Hyundai",
      model: "Elantra",
      year: 2021,
      fuelType: "gasoline",
    });

    expect(first.isDefault).toBe(true);
    expect(second.isDefault).toBe(false);

    const listed = listVehicles(userId);
    expect(listed.length).toBeGreaterThanOrEqual(2);
    expect(listed.filter((v) => v.isDefault)).toHaveLength(1);
  });

  test("updates a vehicle and can set a new default", () => {
    const listed = listVehicles(userId);
    const target = listed.find((v) => v.model === "Elantra");
    expect(target).toBeTruthy();

    const updated = updateVehicle(userId, target.id, {
      year: 2022,
      transmission: "automatic",
      isDefault: true,
    });
    expect(updated.year).toBe(2022);
    expect(updated.transmission).toBe("automatic");
    expect(updated.isDefault).toBe(true);

    const defaults = listVehicles(userId).filter((v) => v.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe(target.id);
  });

  test("stores modified vehicle engine details", () => {
    const modified = createVehicle(userId, {
      modified: true,
      manufacturer: "Nissan",
      model: "Patrol",
      engineDisplacementL: 5.6,
      forcedInduction: "none",
      modifications: "exhaust and intake",
      fuelType: "gasoline",
      isDefault: false,
    });
    expect(modified.modified).toBe(true);
    expect(modified.engineDisplacementL).toBe(5.6);
    expect(modified.modifications).toMatch(/exhaust/);
  });

  test("deletes a default vehicle and promotes another", () => {
    const before = listVehicles(userId);
    const currentDefault = before.find((v) => v.isDefault);
    expect(currentDefault).toBeTruthy();

    deleteVehicle(userId, currentDefault.id);
    const after = listVehicles(userId);
    expect(after.find((v) => v.id === currentDefault.id)).toBeUndefined();
    if (after.length > 0) {
      expect(after.filter((v) => v.isDefault)).toHaveLength(1);
    }
  });

  test("setDefaultVehicle switches the default flag", () => {
    const listed = listVehicles(userId);
    expect(listed.length).toBeGreaterThan(0);
    const pick = listed[listed.length - 1];
    const result = setDefaultVehicle(userId, pick.id);
    expect(result.isDefault).toBe(true);
    expect(listVehicles(userId).filter((v) => v.isDefault)).toHaveLength(1);
  });
});
