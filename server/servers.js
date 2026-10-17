"use strict";
/**
 * /api/servers — create, list, inspect, update, delete, power, stats.
 */
const express = require("express");
const fs = require("fs");
const { stmts, publicServer, SERVERS_ROOT } = require("./db");
const { requireAuth } = require("./auth");
const mc = require("./minecraft");

const router = express.Router();
router.use(requireAuth);

function canAccess(req, server) {
  return req.user.role === "admin" || server.owner_id === req.user.id;
}

function withLive(row) {
  return publicServer(row, mc.liveStatus(row.id) || row.status);
}

function allocatePort() {
  const used = new Set(stmts.usedPorts.all().map((r) => r.port));
  const panelPort = Number(process.env.PORT) || 3000;
  let port = 25565;
  while (used.has(port) || port === panelPort) port++;
  if (port > 25965) throw new Error("No free game ports left in the 25565–25965 range");
  return port;
}

function validateCreate(body) {
  const name = String(body.name || "").trim();
  if (!/^[A-Za-z0-9 _-]{3,32}$/.test(name)) {
    throw new Error("Name must be 3–32 characters (letters, numbers, spaces, _ -).");
  }
  const type = body.type === "paper" ? "paper" : "vanilla";
  const version = String(body.version || "").trim();
  if (!version) throw new Error("Pick a Minecraft version.");
  const memoryMB = Math.max(512, Math.min(32768, parseInt(body.memoryMB, 10) || 2048));
  return { name, type, version, memoryMB };
}

// List servers (admin: all, user: own)
router.get("/", (req, res) => {
  const rows =
    req.user.role === "admin" ? stmts.listServers.all() : stmts.listServersByOwner.all(req.user.id);
  res.json({ servers: rows.map(withLive) });
});

// Create a server — jar download + install runs in the background
router.post("/", async (req, res) => {
  try {
    const { name, type, version, memoryMB } = validateCreate(req.body);
    const ownerId = req.user.role === "admin" && req.body.ownerId
      ? Number(req.body.ownerId)
      : req.user.id;
    const port = allocatePort();
    const info = stmts.createServer.run(name, type, version, memoryMB, port, ownerId);
    const server = stmts.getServer.get(info.lastInsertRowid);
    res.status(201).json({ server: withLive(server) });
    // install async — progress goes over socket.io
    const io = req.app.get("io");
    const result = await mc.installServer(io, server);
    if (!result.ok) {
      // leave the row so the user can see the failure + delete it
    }
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.param("id", (req, res, next, id) => {
  const server = stmts.getServer.get(Number(id));
  if (!server) return res.status(404).json({ error: "Server not found" });
  if (!canAccess(req, server)) return res.status(403).json({ error: "No access to this server" });
  req.server = server;
  next();
});

router.get("/:id", (req, res) => {
  res.json({ server: withLive(req.server) });
});

router.put("/:id", (req, res) => {
  if (mc.isRunning(req.server.id)) {
    return res.status(400).json({ error: "Stop the server before changing its settings" });
  }
  const name = String(req.body.name || req.server.name).trim();
  if (!/^[A-Za-z0-9 _-]{3,32}$/.test(name)) {
    return res.status(400).json({ error: "Name must be 3–32 characters (letters, numbers, spaces, _ -)." });
  }
  const memoryMB = Math.max(512, Math.min(32768, parseInt(req.body.memoryMB, 10) || req.server.memory_mb));
  const autostart = req.body.autostart ? 1 : 0;
  stmts.updateServer.run(name, memoryMB, autostart, req.server.id);
  res.json({ server: withLive(stmts.getServer.get(req.server.id)) });
});

router.delete("/:id", (req, res) => {
  const id = req.server.id;
  try { mc.stopServer(req.app.get("io"), id, { kill: true }); } catch {}
  stmts.deleteServer.run(id);
  if (req.query.deleteFiles !== "0") {
    fs.rmSync(mc.serverDir(id), { recursive: true, force: true });
  }
  res.json({ ok: true });
});

router.post("/:id/power", (req, res) => {
  const io = req.app.get("io");
  const action = req.body.action;
  try {
    if (action === "start") {
      const fresh = stmts.getServer.get(req.server.id);
      mc.startServer(io, fresh);
    } else if (action === "stop") {
      mc.stopServer(io, req.server.id);
    } else if (action === "restart") {
      mc.stopServer(io, req.server.id);
      setTimeout(() => {
        try {
          const fresh = stmts.getServer.get(req.server.id);
          if (fresh) mc.startServer(io, fresh);
        } catch (e) {
          mc.emit(io, req.server.id, "console", { t: Date.now(), line: "[MSOP] restart failed: " + e.message });
        }
      }, 6000);
    } else if (action === "kill") {
      mc.stopServer(io, req.server.id, { kill: true });
    } else {
      return res.status(400).json({ error: "Unknown power action" });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post("/:id/command", (req, res) => {
  try {
    mc.sendCommand(req.server.id, req.body.command);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get("/:id/stats", async (req, res) => {
  res.json(await mc.getStats(req.server.id));
});

router.get("/:id/console", (req, res) => {
  const lines = mc.getConsoleBacklog(req.server.id);
  const since = Number(req.query.since) || 0;
  res.json({ lines: since > 0 ? lines.filter((l) => l.t > since) : lines });
});

module.exports = router;
