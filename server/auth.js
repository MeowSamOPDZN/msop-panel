"use strict";
/**
 * Authentication: session login + admin user management + API token auth
 * (for the hosted MSOP Hosting panel, via Authorization: Bearer).
 */
const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { db, stmts, publicUser } = require("./db");

const router = express.Router();

// simple per-IP login throttle
const attempts = new Map();
function throttled(ip) {
  const now = Date.now();
  const rec = attempts.get(ip) || { n: 0, until: 0 };
  if (now < rec.until) return Math.ceil((rec.until - now) / 1000);
  return 0;
}
function recordFail(ip) {
  const rec = attempts.get(ip) || { n: 0, until: 0 };
  rec.n += 1;
  if (rec.n >= 5) {
    rec.until = Date.now() + 60 * 1000;
    rec.n = 0;
  }
  attempts.set(ip, rec);
}

function requireAuth(req, res, next) {
  if (req.tokenUser) {
    req.user = req.tokenUser;
    return next();
  }
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: "Not signed in" });
  }
  const user = stmts.getUserById.get(req.session.userId);
  if (!user) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: "Session expired" });
  }
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Admin only" });
  next();
}

/**
 * API token auth for the hosted MSOP Hosting panel.
 * Send `Authorization: Bearer <MSOP_API_TOKEN>`. Acts as the first admin
 * user so server ownership stays consistent with the local panel.
 */
function tokenAuth(req, res, next) {
  const expected = process.env.MSOP_API_TOKEN || "";
  const h = req.headers.authorization || "";
  if (expected && h.startsWith("Bearer ")) {
    const a = Buffer.from(h.slice(7).trim());
    const b = Buffer.from(expected);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      const admin = db
        .prepare("SELECT id, username, role, created_at FROM users WHERE role = 'admin' ORDER BY id LIMIT 1")
        .get();
      if (!admin) return res.status(401).json({ error: "No admin user on this node yet" });
      req.tokenUser = admin;
    }
  }
  next();
}

router.post("/login", async (req, res) => {
  const wait = throttled(req.ip);
  if (wait) return res.status(429).json({ error: `Too many attempts — try again in ${wait}s` });
  const { username, password } = req.body || {};
  const row = stmts.getUserByName.get(String(username || ""));
  const ok = row && (await bcrypt.compare(String(password || ""), row.password_hash));
  if (!ok) {
    recordFail(req.ip);
    return res.status(401).json({ error: "Invalid username or password" });
  }
  attempts.delete(req.ip);
  req.session.userId = row.id;
  res.json({ ok: true, user: publicUser(stmts.getUserById.get(row.id)) });
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get("/me", requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

// ---- admin: users ----
router.get("/users", requireAuth, requireAdmin, (req, res) => {
  res.json({ users: stmts.listUsers.all() });
});

router.post("/users", requireAuth, requireAdmin, async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const role = req.body.role === "admin" ? "admin" : "user";
  if (!/^[A-Za-z0-9_.-]{3,24}$/.test(username)) {
    return res.status(400).json({ error: "Username: 3–24 chars, letters/numbers/._-" });
  }
  if (password.length < 6) return res.status(400).json({ error: "Password must be 6+ characters" });
  if (stmts.getUserByName.get(username)) return res.status(400).json({ error: "Username taken" });
  const hash = await bcrypt.hash(password, 10);
  const info = stmts.createUser.run(username, hash, role);
  res.status(201).json({ user: stmts.getUserById.get(info.lastInsertRowid) });
});

router.post("/users/:id/password", requireAuth, requireAdmin, async (req, res) => {
  const password = String(req.body.password || "");
  if (password.length < 6) return res.status(400).json({ error: "Password must be 6+ characters" });
  const target = stmts.getUserById.get(Number(req.params.id));
  if (!target) return res.status(404).json({ error: "User not found" });
  stmts.updateUserPass.run(await bcrypt.hash(password, 10), target.id);
  res.json({ ok: true });
});

router.delete("/users/:id", requireAuth, requireAdmin, (req, res) => {
  const target = stmts.getUserById.get(Number(req.params.id));
  if (!target) return res.status(404).json({ error: "User not found" });
  if (target.id === req.user.id) return res.status(400).json({ error: "You cannot delete yourself" });
  stmts.deleteUser.run(target.id);
  res.json({ ok: true });
});

module.exports = { router, requireAuth, requireAdmin, tokenAuth };
