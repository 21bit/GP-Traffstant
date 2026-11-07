const express = require("express");
const { requireAuth } = require("../auth");
const {
  listVehicles,
  createVehicle,
  updateVehicle,
  setDefaultVehicle,
  deleteVehicle,
} = require("../services/vehicles");

const router = express.Router();

router.use(requireAuth);

router.get("/", (req, res) => {
  return res.json({ vehicles: listVehicles(req.user.id) });
});

router.post("/", (req, res) => {
  try {
    const vehicle = createVehicle(req.user.id, req.body || {});
    return res.status(201).json({ vehicle });
  } catch (err) {
    return res.status(err.status || 500).json({
      error: err.message || "Could not save vehicle.",
      code: err.code || "VEHICLE_SAVE_FAILED",
    });
  }
});

router.put("/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: "Invalid vehicle id" });
  }
  try {
    const vehicle = updateVehicle(req.user.id, id, req.body || {});
    return res.json({ vehicle });
  } catch (err) {
    return res.status(err.status || 500).json({
      error: err.message || "Could not update vehicle.",
      code: err.code || "VEHICLE_UPDATE_FAILED",
    });
  }
});

router.post("/:id/default", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: "Invalid vehicle id" });
  }
  try {
    const vehicle = setDefaultVehicle(req.user.id, id);
    return res.json({ vehicle });
  } catch (err) {
    return res.status(err.status || 500).json({
      error: err.message || "Could not set default vehicle.",
      code: err.code || "VEHICLE_DEFAULT_FAILED",
    });
  }
});

router.delete("/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: "Invalid vehicle id" });
  }
  try {
    return res.json(deleteVehicle(req.user.id, id));
  } catch (err) {
    return res.status(err.status || 500).json({
      error: err.message || "Could not delete vehicle.",
      code: err.code || "VEHICLE_DELETE_FAILED",
    });
  }
});

module.exports = router;
