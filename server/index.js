"use strict";
/**
 * MSOP Panel — entry point.
 * Serves the web UI + JSON API, and streams server consoles over socket.io.
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const session = require("express-session");
const { Server } = require("socket.io");

// ---- tiny .env loader (no extra dependency) ----
(function loadEnv() {
  const envPath = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) {
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      process.env[m[1]] = v;
    }
  }
})();

const { stmts } = require("./db");
const { router: authRouter, tokenAuth } = require("./auth");
const serversRouter = require("./servers");
const filesRouter = require("./files");
const { router: versionsRouter } = require("./versions");
const mc = require("./minecraft");

const PORT = Number(process.env.PORT) || 3000;
const SECRET = process.env.SESSION_SECRET || ("dev-" + Math.random().toString(36).slice(2));
if (!process.env.SESSION_SECRET) {
  console.warn("[MSOP] SESSION_SECRET not set — sessions will not survive restarts. Run setup.js.");
}

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, { maxHttpBufferSize: 2 * 1024 * 1024 });
app.set("io", io);
app.set("trust proxy", 1);

const sessionMiddleware = session({
  secret: SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", maxAge: 7 * 24 * 3600 * 1000 },
});
app.use(sessionMiddleware);
app.use(tokenAuth);
app.use(express.json({ limit: "1mb" }));

// API
app.use("/api/auth", authRouter);
app.use("/api/servers", serversRouter);
app.use("/api/servers/:id/files", filesRouter);
app.use("/api/versions", versionsRouter);
app.get("/api/health", (req, res) =>
  res.json({ ok: true, java: mc.checkJava(), panel: "MSOP Panel", version: "1.0.0" })
);

// Static UI
app.use(express.static(path.join(__dirname, "..", "public")));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/") || req.path.startsWith("/socket.io/")) return next();
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

// ---- socket.io: console streaming ----
io.engine.use(sessionMiddleware);
io.on("connection", (socket) => {
  const req = socket.request;
  socket.on("watch", ({ serverId }) => {
    const userId = req.session && req.session.userId;
    if (!userId) return socket.emit("denied", { error: "Not signed in" });
    const user = stmts.getUserById.get(userId);
    const server = stmts.getServer.get(Number(serverId));
    if (!user || !server) return socket.emit("denied", { error: "Not found" });
    if (!(user.role === "admin" || server.owner_id === user.id)) {
      return socket.emit("denied", { error: "No access" });
    }
    const room = `server:${server.id}`;
    socket.join(room);
    socket.emit("backlog", { lines: mc.getConsoleBacklog(server.id) });
    socket.emit("status", { status: mc.liveStatus(server.id) || server.status });
    mc.getStats(server.id).then((s) => socket.emit("stats", s));
  });

  socket.on("command", ({ serverId, command }) => {
    const userId = req.session && req.session.userId;
    if (!userId) return;
    const user = stmts.getUserById.get(userId);
    const server = stmts.getServer.get(Number(serverId));
    if (!user || !server) return;
    if (!(user.role === "admin" || server.owner_id === user.id)) return;
    try {
      mc.sendCommand(server.id, command);
    } catch (e) {
      socket.emit("console", { t: Date.now(), line: "[MSOP] " + e.message });
    }
  });
});

// live stats ticker — only for running servers
setInterval(async () => {
  for (const room of io.sockets.adapter.rooms.keys()) {
    if (!room.startsWith("server:")) continue;
    const id = Number(room.split(":")[1]);
    if (!mc.isRunning(id)) continue;
    const stats = await mc.getStats(id);
    io.to(room).emit("stats", stats);
  }
}, 3000);

// boot
const hasUsers = stmts.countUsers.get().c > 0;
httpServer.listen(PORT, () => {
  console.log(`[MSOP] MSOP Panel listening on http://0.0.0.0:${PORT}`);
  console.log(`[MSOP] Java detected: ${mc.checkJava() ? "yes" : "NO — game servers cannot start until a JRE is installed"}`);
  if (!hasUsers) {
    console.log("[MSOP] No users yet — run: node server/setup.js --username <name> --password <pass>");
  }
  // clear stale transient statuses left by an unclean shutdown
  try {
    const stale = stmts.listServers.all().filter((s) => ["installing", "starting", "stopping"].includes(s.status));
    for (const s of stale) {
      stmts.updateServerStatus.run("offline", s.id);
      console.log(`[MSOP] reset stale status for server #${s.id} (${s.name}) -> offline`);
    }
  } catch (e) {
    console.log("[MSOP] status reset skipped: " + e.message);
  }
  mc.autostart(io);
});
