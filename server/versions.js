"use strict";
/**
 * Minecraft version listings.
 *  - vanilla: Mojang piston-meta version manifest (release versions)
 *  - paper:   PaperMC API v2
 * Results are cached in memory for 1 hour.
 */
const express = require("express");

const router = express.Router();

const CACHE_TTL = 60 * 60 * 1000;
let cache = { vanilla: null, paper: null, at: { vanilla: 0, paper: 0 } };

async function cached(type) {
  if (cache[type] && Date.now() - cache.at[type] < CACHE_TTL) return cache[type];
  const versions = type === "paper" ? await paperVersions() : await vanillaVersions();
  cache[type] = versions;
  cache.at[type] = Date.now();
  return versions;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": "MSOP-Panel/1.0" } });
  if (!res.ok) throw new Error(`version source returned ${res.status}`);
  return res.json();
}

async function vanillaVersions() {
  const manifest = await fetchJson("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json");
  return manifest.versions.filter((v) => v.type === "release").map((v) => v.id);
}

async function paperVersions() {
  const data = await fetchJson("https://fill.papermc.io/v3/projects/paper/versions");
  return data.versions.map((v) => v.version.id); // newest first already
}

async function paperLatestBuild(version) {
  const info = await fetchJson(
    `https://fill.papermc.io/v3/projects/paper/versions/${version}/builds/latest`
  );
  const dl = info.downloads["server:default"];
  if (!dl || !dl.url) throw new Error(`no Paper build found for ${version}`);
  return { build: info.id, jarName: dl.name, url: dl.url };
}

async function vanillaJarUrl(version) {
  const manifest = await fetchJson("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json");
  const entry = manifest.versions.find((v) => v.id === version);
  if (!entry) throw new Error(`unknown vanilla version: ${version}`);
  const meta = await fetchJson(entry.url);
  const url = meta.downloads && meta.downloads.server && meta.downloads.server.url;
  if (!url) throw new Error(`no server jar for vanilla ${version}`);
  return url;
}

router.get("/", async (req, res) => {
  try {
    const type = req.query.type === "paper" ? "paper" : "vanilla";
    res.json({ type, versions: await cached(type) });
  } catch (e) {
    res.status(502).json({ error: "Could not reach the version source: " + e.message });
  }
});

module.exports = { router, vanillaJarUrl, paperLatestBuild };
