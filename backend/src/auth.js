const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { db } = require("./db");

const JWT_SECRET = process.env.JWT_SECRET || "traffstant-dev-secret-change-me";
const JWT_EXPIRES_IN = "7d";
const SALT_ROUNDS = 10;

function sanitizeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name || null,
    createdAt: row.created_at,
  };
}

function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function registerUser({ email, password, name }) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const rawPassword = String(password || "");
  const displayName = name ? String(name).trim() : null;

  if (!normalizedEmail || !normalizedEmail.includes("@")) {
    const err = new Error("A valid email is required.");
    err.status = 400;
    throw err;
  }
  if (rawPassword.length < 6) {
    const err = new Error("Password must be at least 6 characters.");
    err.status = 400;
    throw err;
  }

  const existing = db
    .prepare("SELECT id FROM users WHERE email = ?")
    .get(normalizedEmail);
  if (existing) {
    const err = new Error("An account with this email already exists.");
    err.status = 409;
    throw err;
  }

  const passwordHash = bcrypt.hashSync(rawPassword, SALT_ROUNDS);
  const result = db
    .prepare(
      "INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)"
    )
    .run(normalizedEmail, passwordHash, displayName);

  const user = sanitizeUser(
    db.prepare("SELECT * FROM users WHERE id = ?").get(result.lastInsertRowid)
  );
  return { user, token: signToken(user) };
}

function loginUser({ email, password }) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const rawPassword = String(password || "");

  const row = db
    .prepare("SELECT * FROM users WHERE email = ?")
    .get(normalizedEmail);

  if (!row || !bcrypt.compareSync(rawPassword, row.password_hash)) {
    const err = new Error("Invalid email or password.");
    err.status = 401;
    throw err;
  }

  const user = sanitizeUser(row);
  return { user, token: signToken(user) };
}

function getUserById(id) {
  return sanitizeUser(
    db.prepare("SELECT * FROM users WHERE id = ?").get(id)
  );
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return res.status(401).json({ error: "Authentication required." });
  }

  try {
    const payload = jwt.verify(match[1], JWT_SECRET);
    const user = getUserById(payload.sub);
    if (!user) {
      return res.status(401).json({ error: "User no longer exists." });
    }
    req.user = user;
    return next();
  } catch (_err) {
    return res.status(401).json({ error: "Invalid or expired token." });
  }
}

module.exports = {
  registerUser,
  loginUser,
  getUserById,
  requireAuth,
  JWT_SECRET,
};
