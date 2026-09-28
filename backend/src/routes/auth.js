const express = require("express");
const { registerUser, loginUser, requireAuth } = require("../auth");

const router = express.Router();

router.post("/register", (req, res) => {
  try {
    const result = registerUser(req.body || {});
    return res.status(201).json(result);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
});

router.post("/login", (req, res) => {
  try {
    const result = loginUser(req.body || {});
    return res.json(result);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
});

router.get("/me", requireAuth, (req, res) => {
  return res.json({ user: req.user });
});

module.exports = router;
