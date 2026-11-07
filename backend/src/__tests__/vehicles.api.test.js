const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.TRAFFSTANT_DB_PATH = path.join(
  os.tmpdir(),
  `traffstant-vehicles-api-${process.pid}.db`
);
process.env.PREDICTION_PROVIDER = "mock";

const request = require("supertest");
const app = require("../../server");
const { db, DB_PATH } = require("../db");

afterAll(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(DB_PATH + suffix, { force: true });
  }
});

describe("vehicles API", () => {
  let token;

  beforeAll(async () => {
    const res = await request(app).post("/api/auth/register").send({
      email: `vehicles-api-${process.pid}@traffstant.test`,
      password: "test-pass-1",
      name: "Fleet",
    });
    token = res.body.token;
  });

  test("requires authentication", async () => {
    const res = await request(app).get("/api/vehicles");
    expect(res.status).toBe(401);
  });

  test("creates lists updates and deletes vehicles for the user", async () => {
    const create = await request(app)
      .post("/api/vehicles")
      .set("Authorization", `Bearer ${token}`)
      .send({
        modified: false,
        manufacturer: "Toyota",
        model: "Yaris",
        year: 2018,
        fuelType: "gasoline",
        transmission: "automatic",
      });
    expect(create.status).toBe(201);
    expect(create.body.vehicle.isDefault).toBe(true);

    const create2 = await request(app)
      .post("/api/vehicles")
      .set("Authorization", `Bearer ${token}`)
      .send({
        modified: true,
        engineDisplacementL: 3.5,
        modifications: "stage 1 tune",
        fuelType: "gasoline",
        forcedInduction: "turbo",
      });
    expect(create2.status).toBe(201);
    expect(create2.body.vehicle.modified).toBe(true);

    const list = await request(app)
      .get("/api/vehicles")
      .set("Authorization", `Bearer ${token}`);
    expect(list.status).toBe(200);
    expect(list.body.vehicles.length).toBe(2);

    const id = create2.body.vehicle.id;
    const makeDefault = await request(app)
      .post(`/api/vehicles/${id}/default`)
      .set("Authorization", `Bearer ${token}`);
    expect(makeDefault.status).toBe(200);
    expect(makeDefault.body.vehicle.isDefault).toBe(true);

    const update = await request(app)
      .put(`/api/vehicles/${id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ modifications: "stage 2 tune", engineDisplacementL: 3.5 });
    expect(update.status).toBe(200);
    expect(update.body.vehicle.modifications).toMatch(/stage 2/);

    const del = await request(app)
      .delete(`/api/vehicles/${id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(del.status).toBe(200);

    const after = await request(app)
      .get("/api/vehicles")
      .set("Authorization", `Bearer ${token}`);
    expect(after.body.vehicles).toHaveLength(1);
    expect(after.body.vehicles[0].isDefault).toBe(true);
  });
});
