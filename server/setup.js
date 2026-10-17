"use strict";
/**
 * One-time setup: creates .env (if missing) and the first admin user.
 *
 *   node server/setup.js --username admin --password <secret> [--port 3000]
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

const username = arg("--username");
const password = arg("--password");
const port = arg("--port") || "3000";

if (!username || !password) {
  console.error("Usage: node server/setup.js --username <name> --password <secret> [--port 3000]");
  process.exit(1);
}
if (!/^[A-Za-z0-9_.-]{3,24}$/.test(username)) {
  console.error("Username: 3-24 chars, letters/numbers/._-");
  process.exit(1);
}
if (password.length < 6) {
  console.error("Password must be 6+ characters");
  process.exit(1);
}

// .env first (db.js reads DATA_DIR from env)
const envPath = path.join(__dirname, "..", ".env");
if (!fs.existsSync(envPath)) {
  const secret = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(
    envPath,
    `PORT=${port}\nSESSION_SECRET=${secret}\nDATA_DIR=./data\n`
  );
  console.log("[setup] wrote .env");
} else {
  console.log("[setup] .env already exists, keeping it");
}

const { stmts } = require("./db");

if (stmts.getUserByName.get(username)) {
  console.error(`[setup] user "${username}" already exists — nothing changed`);
  process.exit(1);
}
const hash = bcrypt.hashSync(password, 10);
const info = stmts.createUser.run(username, hash, "admin");
console.log(`[setup] admin user "${username}" created (id ${info.lastInsertRowid})`);
console.log("[setup] done — start the panel with: npm start");
