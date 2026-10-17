"use strict";
/**
 * Minecraft server lifecycle manager.
 *
 *  - installServer : downloads the server jar (Vanilla via Mojang, Paper via PaperMC),
 *                    writes eula.txt + server.properties
 *  - startServer   : spawns `java -jar server.jar nogui`, streams console over socket.io
 *  - stopServer    : sends "stop" to the console, SIGKILLs after a timeout
 *  - sendCommand   : writes a command to the server console
 *  - getStats      : live CPU / memory / players / uptime
 *
 * One child process per server id is kept in `procs`. Console history is kept
 * in a ring buffer so newly opened tabs get the backlog.
 */
const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const pidusage = require("pidusage");
const { SERVERS_ROOT, stmts } = require("./db");
const { vanillaJarUrl, paperLatestBuild } = require("./versions");

const LOG_CAP = 800;
const procs = new Map(); // id -> { child, status, log[], startedAt, players, maxPlayers }

let javaOk = null;
function checkJava() {
  if (javaOk !== null) return javaOk;
  try {
    execSync("java -version", { stdio: "ignore", timeout: 10000 });
    javaOk = true;
  } catch {
    javaOk = false;
  }
  return javaOk;
}

function serverDir(id) {
  return path.join(SERVERS_ROOT, String(id));
}

function emit(io, id, event, data) {
  if (io) io.to(`server:${id}`).emit(event, data);
}

function setStatus(db, io, id, status) {
  const p = procs.get(Number(id));
  if (p) p.status = status;
  try {
    stmts.updateServerStatus.run(status, id);
  } catch {}
  emit(io, id, "status", { status });
}

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;?]*[a-zA-Z]/g, "");
}

function pushLine(io, id, line) {
  const p = procs.get(Number(id));
  const clean = stripAnsi(line).replace(/\s+$/, "");
  if (!clean) return;
  const entry = { t: Date.now(), line: clean };
  if (p) {
    p.log.push(entry);
    if (p.log.length > LOG_CAP) p.log.splice(0, p.log.length - LOG_CAP);
    // online detection
    if (/Done \([0-9.]+s\)! For help, type "help"/.test(clean)) {
      p.status = "online";
      try { stmts.updateServerStatus.run("online", id); } catch {}
      emit(io, id, "status", { status: "online" });
    }
    // player tracking (vanilla + paper log format)
    let m = clean.match(/(\S+) joined the game/);
    if (m) p.players = Math.min(p.maxPlayers || 999, p.players + 1);
    m = clean.match(/(\S+) left the game/);
    if (m) p.players = Math.max(0, p.players - 1);
    m = clean.match(/There are (\d+) of a max of (\d+) players online/);
    if (m) {
      p.players = parseInt(m[1], 10);
      p.maxPlayers = parseInt(m[2], 10);
    }
  }
  emit(io, id, "console", entry);
}

const STALL_MS = 90000; // abort the jar download if no data arrives for 90s

async function download(url, dest, onProgress) {
  const res = await fetch(url, { headers: { "User-Agent": "MSOP-Panel/1.0" } });
  if (!res.ok || !res.body) throw new Error(`download failed (HTTP ${res.status})`);
  const total = Number(res.headers.get("content-length")) || 0;
  const file = fs.createWriteStream(dest);
  const reader = res.body.getReader();
  let done = 0;
  try {
    for (;;) {
      let chunk;
      const stall = new Promise((_, rej) => {
        const t = setTimeout(() => rej(new Error("stalled")), STALL_MS);
        if (t.unref) t.unref();
      });
      try {
        chunk = await Promise.race([reader.read(), stall]);
      } catch (e) {
        try { await reader.cancel(); } catch {}
        throw new Error("download stalled (no data for 90s) — check the connection and retry");
      }
      if (chunk.done) break;
      done += chunk.value.length;
      if (!file.write(chunk.value)) await new Promise((r) => file.once("drain", r));
      if (total && onProgress) onProgress(Math.min(99, Math.round((done / total) * 100)));
    }
  } finally {
    file.end();
    await new Promise((r) => {
      file.on("finish", r);
      file.on("error", r);
    });
  }
}

function writeServerFiles(server) {
  const dir = serverDir(server.id);
  fs.writeFileSync(path.join(dir, "eula.txt"), "# By creating this server you agree to the Minecraft EULA (https://aka.ms/MinecraftEULA)\neula=true\n");
  const props = [
    `# MSOP Panel — ${server.name}`,
    `server-port=${server.port}`,
    `motd=MSOP Panel \\u2022 ${server.name}`,
    "online-mode=true",
    "enable-command-block=true",
    "max-players=20",
    "view-distance=10",
    "difficulty=easy",
    "gamemode=survival",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "server.properties"), props);
}

async function installServer(io, server) {
  const id = server.id;
  const dir = serverDir(id);
  fs.mkdirSync(dir, { recursive: true });
  setStatus(null, io, id, "installing");
  const progress = (pct, note) => emit(io, id, "install", { progress: pct, note });
  try {
    progress(2, "Resolving download URL…");
    let jarUrl;
    if (server.type === "paper") {
      const b = await paperLatestBuild(server.version);
      jarUrl = b.url;
      progress(8, `Paper ${server.version} build ${b.build} found`);
    } else {
      jarUrl = await vanillaJarUrl(server.version);
      progress(8, `Vanilla ${server.version} found`);
    }
    progress(10, "Downloading server jar…");
    await download(jarUrl, path.join(dir, "server.jar"), (pct) =>
      progress(10 + Math.round(pct * 0.85), "Downloading server jar…")
    );
    progress(97, "Writing config…");
    writeServerFiles(server);
    progress(100, "Done");
    setStatus(null, io, id, "offline");
    return { ok: true };
  } catch (e) {
    setStatus(null, io, id, "install_failed");
    emit(io, id, "install", { progress: 0, note: "Failed: " + e.message, error: true });
    return { ok: false, error: e.message };
  }
}

function startServer(io, server) {
  const id = Number(server.id);
  if (procs.has(id)) throw new Error("Server is already running");
  if (!checkJava()) throw new Error("Java is not installed on this machine. Install a JRE (the install script does this).");
  const dir = serverDir(id);
  if (!fs.existsSync(path.join(dir, "server.jar"))) {
    throw new Error("server.jar is missing — the install did not finish. Delete and re-create the server.");
  }
  const mem = Math.max(512, Number(server.memory_mb) || 2048);
  const xms = Math.min(1024, mem);
  const child = spawn("java", [`-Xmx${mem}M`, `-Xms${xms}M`, "-jar", "server.jar", "nogui"], {
    cwd: dir,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const state = { child, status: "starting", log: [], startedAt: Date.now(), players: 0, maxPlayers: 20 };
  procs.set(id, state);
  setStatus(null, io, id, "starting");

  let buf = "";
  const onData = (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      pushLine(io, id, line);
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("error", (err) => {
    pushLine(io, id, `[MSOP] failed to start java: ${err.message}`);
    procs.delete(id);
    setStatus(null, io, id, "offline");
  });
  child.on("close", (code) => {
    if (buf.trim()) pushLine(io, id, buf);
    pushLine(io, id, `[MSOP] process exited (code ${code})`);
    procs.delete(id);
    setStatus(null, io, id, "offline");
  });
  return { ok: true };
}

function sendCommand(id, command) {
  const p = procs.get(Number(id));
  if (!p) throw new Error("Server is not running");
  const cmd = String(command || "").slice(0, 500);
  if (!cmd.trim()) return { ok: true };
  p.child.stdin.write(cmd.trim() + "\n");
  return { ok: true };
}

function stopServer(io, id, { kill = false } = {}) {
  id = Number(id);
  const p = procs.get(id);
  if (!p) return { ok: true, note: "already offline" };
  if (kill) {
    try { p.child.kill("SIGKILL"); } catch {}
    return { ok: true };
  }
  setStatus(null, io, id, "stopping");
  pushLine(io, id, "[MSOP] stopping server…");
  try {
    p.child.stdin.write("stop\n");
  } catch {}
  setTimeout(() => {
    const still = procs.get(id);
    if (still) {
      try { still.child.kill("SIGKILL"); } catch {}
    }
  }, 30000).unref();
  return { ok: true };
}

async function getStats(id) {
  id = Number(id);
  const p = procs.get(id);
  if (!p) return { status: "offline", cpu: 0, memory_mb: 0, players: 0, max_players: 20, uptime_s: 0 };
  let cpu = 0, mem = 0;
  try {
    const s = await pidusage(p.child.pid);
    cpu = Math.round((s.cpu || 0) * 10) / 10;
    mem = Math.round((s.memory || 0) / 1024 / 1024);
  } catch {}
  return {
    status: p.status,
    cpu,
    memory_mb: mem,
    players: p.players,
    max_players: p.maxPlayers,
    uptime_s: Math.floor((Date.now() - p.startedAt) / 1000),
  };
}

function getConsoleBacklog(id) {
  const p = procs.get(Number(id));
  return p ? p.log : [];
}

function liveStatus(id) {
  const p = procs.get(Number(id));
  return p ? p.status : null;
}

function isRunning(id) {
  return procs.has(Number(id));
}

function autostart(io) {
  let rows = [];
  try {
    rows = stmts.listServers.all().filter((s) => s.autostart && s.status !== "installing");
  } catch { return; }
  for (const s of rows) {
    try {
      // reset stale "online" flags from an unclean shutdown
      try { stmts.updateServerStatus.run("offline", s.id); } catch {}
      startServer(io, s);
      pushLine(io, s.id, "[MSOP] auto-started (autostart enabled)");
    } catch (e) {
      pushLine(io, s.id, "[MSOP] autostart failed: " + e.message);
    }
  }
}

module.exports = {
  checkJava,
  serverDir,
  installServer,
  startServer,
  stopServer,
  sendCommand,
  getStats,
  getConsoleBacklog,
  liveStatus,
  isRunning,
  autostart,
  emit,
};
