"use strict";
/**
 * /api/servers/:id/files — sandboxed file manager.
 * Every path is resolved inside the server's own directory; anything
 * escaping it is rejected.
 */
const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");
const multer = require("multer");
const { stmts } = require("./db");
const { requireAuth } = require("./auth");
const { serverDir } = require("./minecraft");

const router = express.Router({ mergeParams: true });
router.use(requireAuth);

// NOTE: router.param("id") does NOT fire for params that only exist in the
// parent mount path, so the server is loaded with a plain middleware.
router.use((req, res, next) => {
  const server = stmts.getServer.get(Number(req.params.id));
  if (!server) return res.status(404).json({ error: "Server not found" });
  if (!(req.user.role === "admin" || server.owner_id === req.user.id)) {
    return res.status(403).json({ error: "No access to this server" });
  }
  req.server = server;
  next();
});

function resolveSafe(serverId, rel) {
  const root = serverDir(serverId);
  const target = path.resolve(root, "." + path.sep + String(rel || ""));
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    throw new Error("Invalid path");
  }
  return target;
}

const TEXT_EXT = new Set([
  ".txt", ".properties", ".yml", ".yaml", ".json", ".log", ".mcfunction",
  ".md", ".toml", ".cfg", ".conf", ".xml", ".sh",
]);

// List directory
router.get("/", (req, res) => {
  try {
    const dir = resolveSafe(req.server.id, req.query.path || "/");
    if (!fs.existsSync(dir)) return res.json({ path: req.query.path || "/", entries: [] });
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) return res.status(400).json({ error: "Not a directory" });
    const entries = fs.readdirSync(dir).map((name) => {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      return {
        name,
        type: st.isDirectory() ? "dir" : "file",
        size: st.isDirectory() ? 0 : st.size,
        modified: st.mtimeMs,
        editable:
          !st.isDirectory() &&
          st.size < 2 * 1024 * 1024 &&
          (TEXT_EXT.has(path.extname(name).toLowerCase()) || st.size < 200 * 1024),
      };
    });
    entries.sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1
    );
    res.json({ path: req.query.path || "/", entries });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Read a text file
router.get("/view", (req, res) => {
  try {
    const file = resolveSafe(req.server.id, req.query.path);
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 2 * 1024 * 1024) {
      return res.status(400).json({ error: "File is not readable as text" });
    }
    res.json({ path: req.query.path, content: fs.readFileSync(file, "utf8") });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Save a text file
router.post("/save", express.json({ limit: "2mb" }), (req, res) => {
  try {
    const file = resolveSafe(req.server.id, req.body.path);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return res.status(400).json({ error: "File does not exist" });
    }
    fs.writeFileSync(file, String(req.body.content ?? ""));
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Create folder
router.post("/mkdir", express.json(), (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    if (!/^[\w.\- ]{1,64}$/.test(name)) return res.status(400).json({ error: "Bad folder name" });
    fs.mkdirSync(resolveSafe(req.server.id, path.join(req.body.path || "/", name)), { recursive: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Rename
router.post("/rename", express.json(), (req, res) => {
  try {
    const from = resolveSafe(req.server.id, req.body.path);
    const name = String(req.body.name || "").trim();
    if (!/^[\w.\- ]{1,64}$/.test(name)) return res.status(400).json({ error: "Bad name" });
    const to = path.join(path.dirname(from), name);
    // keep it inside the server root
    resolveSafe(req.server.id, path.relative(serverDir(req.server.id), to));
    fs.renameSync(from, to);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Delete file / folder
router.post("/delete", express.json(), (req, res) => {
  try {
    const target = resolveSafe(req.server.id, req.body.path);
    const root = serverDir(req.server.id);
    if (target === root) return res.status(400).json({ error: "Cannot delete the server root" });
    if (path.basename(target) === "server.jar") {
      return res.status(400).json({ error: "server.jar cannot be deleted from here" });
    }
    fs.rmSync(target, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Upload
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 500 * 1024 * 1024, files: 5 } });
router.post("/upload", upload.array("files", 5), (req, res) => {
  try {
    const dir = resolveSafe(req.server.id, req.query.path || "/");
    if (!fs.statSync(dir).isDirectory()) return res.status(400).json({ error: "Not a directory" });
    for (const f of req.files || []) {
      const name = path.basename(f.originalname).replace(/[^\w.\- ]/g, "_").slice(0, 128) || "upload";
      const dest = path.join(dir, name);
      resolveSafe(req.server.id, path.relative(serverDir(req.server.id), dest));
      fs.copyFileSync(f.path, dest); // copy (not rename) — /tmp may be another filesystem
      fs.rmSync(f.path, { force: true });
    }
    res.json({ ok: true });
  } catch (e) {
    for (const f of req.files || []) fs.rmSync(f.path, { force: true });
    res.status(400).json({ error: e.message });
  }
});

// Download
router.get("/download", (req, res) => {
  try {
    const file = resolveSafe(req.server.id, req.query.path);
    if (!fs.statSync(file).isFile()) return res.status(400).json({ error: "Not a file" });
    res.download(file, path.basename(file));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
