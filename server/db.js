"use strict";
/**
 * SQLite database layer (better-sqlite3).
 * Tables: users, servers.
 */
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const SERVERS_ROOT = path.join(DATA_DIR, "servers");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(SERVERS_ROOT, { recursive: true });

const db = new Database(path.join(DATA_DIR, "msop.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'vanilla',
  version TEXT NOT NULL,
  memory_mb INTEGER NOT NULL DEFAULT 2048,
  port INTEGER NOT NULL UNIQUE,
  owner_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'offline',
  autostart INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE CASCADE
);
`);

const stmts = {
  createUser: db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)"),
  getUserByName: db.prepare("SELECT * FROM users WHERE username = ?"),
  getUserById: db.prepare("SELECT id, username, role, created_at FROM users WHERE id = ?"),
  listUsers: db.prepare("SELECT id, username, role, created_at FROM users ORDER BY id ASC"),
  deleteUser: db.prepare("DELETE FROM users WHERE id = ?"),
  updateUserRole: db.prepare("UPDATE users SET role = ? WHERE id = ?"),
  updateUserPass: db.prepare("UPDATE users SET password_hash = ? WHERE id = ?"),

  createServer: db.prepare(
    "INSERT INTO servers (name, type, version, memory_mb, port, owner_id, status) VALUES (?, ?, ?, ?, ?, ?, 'installing')"
  ),
  getServer: db.prepare("SELECT * FROM servers WHERE id = ?"),
  listServers: db.prepare("SELECT * FROM servers ORDER BY id ASC"),
  listServersByOwner: db.prepare("SELECT * FROM servers WHERE owner_id = ? ORDER BY id ASC"),
  updateServer: db.prepare("UPDATE servers SET name = ?, memory_mb = ?, autostart = ? WHERE id = ?"),
  updateServerStatus: db.prepare("UPDATE servers SET status = ? WHERE id = ?"),
  deleteServer: db.prepare("DELETE FROM servers WHERE id = ?"),
  usedPorts: db.prepare("SELECT port FROM servers"),
  countUsers: db.prepare("SELECT COUNT(*) AS c FROM users"),
};

function publicUser(u) {
  if (!u) return null;
  return { id: u.id, username: u.username, role: u.role, created_at: u.created_at };
}

function publicServer(s, liveStatus) {
  if (!s) return null;
  return {
    id: s.id,
    name: s.name,
    type: s.type,
    version: s.version,
    memory_mb: s.memory_mb,
    port: s.port,
    owner_id: s.owner_id,
    status: liveStatus || s.status,
    autostart: !!s.autostart,
    created_at: s.created_at,
  };
}

module.exports = { db, stmts, publicUser, publicServer, DATA_DIR, SERVERS_ROOT };
