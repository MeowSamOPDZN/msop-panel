/* MSOP Panel — server management page */
const SERVER_ID = new URLSearchParams(location.search).get("id");
let ME = null, SERVER = null, socket = null;
let curPath = "/";

(async function init() {
  if (!SERVER_ID) { location.href = "/"; return; }
  ME = await requireAuth();
  if (!ME) return;
  paintUser(ME);
  await refreshServer();
  wireTabs(); wirePower(); wireConsole(); wireFiles(); wireSettings();
  connectSocket();
  setInterval(refreshServer, 10000);
})();

async function refreshServer() {
  const r = await api(`/api/servers/${SERVER_ID}`);
  if (!r.ok) { toast(r.data.error || "Server not found", "err"); setTimeout(() => location.href = "/", 1200); return; }
  SERVER = r.data.server;
  document.title = `${SERVER.name} — MSOP Panel`;
  document.getElementById("srvName").textContent = SERVER.name;
  document.getElementById("srvSub").textContent =
    `${SERVER.type === "paper" ? "Paper" : "Vanilla"} ${SERVER.version} · port ${SERVER.port} · ${(SERVER.memory_mb / 1024).toFixed(SERVER.memory_mb % 1024 ? 1 : 0)} GB RAM`;
  paintStatus(SERVER.status);
  document.getElementById("sName").value = SERVER.name;
  document.getElementById("sMem").value = String(SERVER.memory_mb);
  document.getElementById("sAutostart").checked = SERVER.autostart;
  document.getElementById("sAddr").value = `${location.hostname}:${SERVER.port}`;
}

function paintStatus(status) {
  const pill = document.getElementById("srvPill");
  pill.className = "pill " + pillClass(status);
  document.getElementById("srvPillText").textContent = status.replace("_", " ");
  document.getElementById("stStatus").textContent = status.replace("_", " ");
  const running = status === "online" || status === "starting";
  document.querySelector('[data-power="start"]').disabled = running || status === "installing";
}

function wireTabs() {
  document.querySelectorAll(".tabs button").forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll(".tabs button").forEach((x) => x.classList.remove("active"));
      document.querySelectorAll(".tabpane").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      document.getElementById("tab-" + b.dataset.tab).classList.add("active");
      if (b.dataset.tab === "files") loadFiles(curPath);
    };
  });
}

function wirePower() {
  document.querySelectorAll("[data-power]").forEach((b) => {
    b.onclick = async () => {
      const action = b.dataset.power;
      if ((action === "stop" || action === "kill" || action === "restart") && !confirm(`${action[0].toUpperCase() + action.slice(1)} the server?`)) return;
      b.disabled = true;
      const r = await api(`/api/servers/${SERVER_ID}/power`, { method: "POST", body: JSON.stringify({ action }) });
      if (!r.ok) toast(r.data.error || "Failed", "err");
      else { toast(`Server ${action}…`, "ok"); refreshServer(); }
      b.disabled = false;
    };
  });
}

/* ---------- console ---------- */
const term = document.getElementById("terminal");
function addLine(entry) {
  const div = document.createElement("div");
  if (String(entry.line).startsWith("[MSOP]")) div.className = "sys";
  div.textContent = entry.line;
  const stick = term.scrollHeight - term.scrollTop - term.clientHeight < 60;
  term.appendChild(div);
  while (term.children.length > 1000) term.firstChild.remove();
  if (stick) term.scrollTop = term.scrollHeight;
}

function wireConsole() {
  const input = document.getElementById("cmdInput");
  input.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    const cmd = input.value;
    input.value = "";
    if (!cmd.trim()) return;
    addLine({ line: "> " + cmd });
    await api(`/api/servers/${SERVER_ID}/command`, { method: "POST", body: JSON.stringify({ command: cmd }) });
  });
}

function connectSocket() {
  socket = io();
  socket.on("connect", () => socket.emit("watch", { serverId: SERVER_ID }));
  socket.on("denied", (d) => toast(d.error || "Access denied", "err"));
  socket.on("backlog", ({ lines }) => { term.innerHTML = ""; (lines || []).forEach(addLine); });
  socket.on("console", addLine);
  socket.on("status", ({ status }) => { paintStatus(status); if (SERVER) SERVER.status = status; });
  socket.on("install", ({ progress, note, error }) => {
    const banner = document.getElementById("installBanner");
    banner.classList.add("show");
    document.getElementById("installNote").textContent = note || "";
    document.getElementById("installBar").style.width = (progress || 0) + "%";
    if (error) toast(note, "err");
    if (progress >= 100 && !error) {
      setTimeout(() => banner.classList.remove("show"), 2500);
      toast("Install complete — hit Start!", "ok");
      refreshServer();
    }
  });
  socket.on("stats", (s) => {
    paintStatus(s.status);
    document.getElementById("stCpu").textContent = s.cpu;
    document.getElementById("barCpu").style.width = Math.min(100, s.cpu) + "%";
    document.getElementById("stMem").textContent = s.memory_mb;
    document.getElementById("barMem").style.width = SERVER ? Math.min(100, (s.memory_mb / SERVER.memory_mb) * 100) + "%" : "0%";
    document.getElementById("stPlayers").textContent = s.players;
    document.getElementById("stMaxPlayers").textContent = " / " + (s.max_players || 20);
    document.getElementById("stUptime").textContent = fmtUptime(s.uptime_s);
  });
}

/* ---------- files ---------- */
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function joinPath(a, b) { return (a === "/" ? "" : a) + "/" + b; }

async function loadFiles(p) {
  curPath = p;
  const r = await api(`/api/servers/${SERVER_ID}/files?path=${encodeURIComponent(p)}`);
  if (!r.ok) { toast(r.data.error || "Could not list files", "err"); return; }
  const parts = p.split("/").filter(Boolean);
  let crumbs = `<button data-p="/">root</button>`;
  let acc = "";
  for (const part of parts) { acc += "/" + part; crumbs += ` / <button data-p="${esc(acc)}">${esc(part)}</button>`; }
  document.getElementById("crumbs").innerHTML = crumbs;
  document.querySelectorAll("#crumbs button").forEach((b) => (b.onclick = () => loadFiles(b.dataset.p)));
  const rows = document.getElementById("fileRows");
  rows.innerHTML = r.data.entries.map((e) => {
    const full = joinPath(p, e.name);
    return `<tr>
      <td><span class="fname" data-open="${esc(full)}" data-type="${e.type}">
        <span class="ico">${e.type === "dir" ? "📁" : "📄"}</span>${esc(e.name)}</span></td>
      <td class="fsize">${e.type === "dir" ? "—" : fmtBytes(e.size)}</td>
      <td class="fmod">${fmtDate(e.modified)}</td>
      <td><div class="frow-actions">
        ${e.type === "file" ? `<button class="iconbtn" data-dl="${esc(full)}">Download</button>` : ""}
        ${e.type === "file" && e.editable ? `<button class="iconbtn" data-edit="${esc(full)}">Edit</button>` : ""}
        <button class="iconbtn" data-ren="${esc(full)}">Rename</button>
        <button class="iconbtn" data-del="${esc(full)}">Delete</button>
      </div></td>
    </tr>`;
  }).join("") || `<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:26px">Empty folder</td></tr>`;

  rows.querySelectorAll("[data-open]").forEach((el) => {
    el.onclick = () => {
      if (el.dataset.type === "dir") loadFiles(el.dataset.open);
      else openEditor(el.dataset.open);
    };
  });
  rows.querySelectorAll("[data-dl]").forEach((b) => (b.onclick = () => {
    location.href = `/api/servers/${SERVER_ID}/files/download?path=${encodeURIComponent(b.dataset.dl)}`;
  }));
  rows.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => openEditor(b.dataset.edit)));
  rows.querySelectorAll("[data-ren]").forEach((b) => (b.onclick = async () => {
    const name = prompt("New name:", b.dataset.ren.split("/").pop());
    if (!name) return;
    const rr = await api(`/api/servers/${SERVER_ID}/files/rename`, { method: "POST", body: JSON.stringify({ path: b.dataset.ren, name }) });
    rr.ok ? loadFiles(curPath) : toast(rr.data.error || "Rename failed", "err");
  }));
  rows.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => {
    if (!confirm(`Delete ${b.dataset.del}?`)) return;
    const rr = await api(`/api/servers/${SERVER_ID}/files/delete`, { method: "POST", body: JSON.stringify({ path: b.dataset.del }) });
    rr.ok ? (toast("Deleted", "ok"), loadFiles(curPath)) : toast(rr.data.error || "Delete failed", "err");
  }));
}

let editingPath = null;
async function openEditor(p) {
  const r = await api(`/api/servers/${SERVER_ID}/files/view?path=${encodeURIComponent(p)}`);
  if (!r.ok) { toast(r.data.error || "Cannot open file", "err"); return; }
  editingPath = p;
  document.getElementById("editorTitle").textContent = "Edit " + p.split("/").pop();
  document.getElementById("editorPath").textContent = p;
  document.getElementById("editorArea").value = r.data.content;
  openModal("editorModal");
}

function wireFiles() {
  document.getElementById("btnRefresh").onclick = () => loadFiles(curPath);
  document.getElementById("btnMkdir").onclick = async () => {
    const name = prompt("Folder name:");
    if (!name) return;
    const r = await api(`/api/servers/${SERVER_ID}/files/mkdir`, { method: "POST", body: JSON.stringify({ path: curPath, name }) });
    r.ok ? loadFiles(curPath) : toast(r.data.error || "Failed", "err");
  };
  document.getElementById("btnUpload").onclick = () => document.getElementById("fileInput").click();
  document.getElementById("fileInput").onchange = async (e) => {
    const files = e.target.files;
    if (!files.length) return;
    const fd = new FormData();
    for (const f of files) fd.append("files", f);
    toast("Uploading…");
    const res = await fetch(`/api/servers/${SERVER_ID}/files/upload?path=${encodeURIComponent(curPath)}`, { method: "POST", body: fd, credentials: "same-origin" });
    const data = await res.json().catch(() => ({}));
    res.ok ? (toast("Upload complete", "ok"), loadFiles(curPath)) : toast(data.error || "Upload failed", "err");
    e.target.value = "";
  };
  document.getElementById("editorSave").onclick = async () => {
    const r = await api(`/api/servers/${SERVER_ID}/files/save`, {
      method: "POST",
      body: JSON.stringify({ path: editingPath, content: document.getElementById("editorArea").value }),
    });
    r.ok ? (toast("Saved", "ok"), closeModal("editorModal"), loadFiles(curPath)) : toast(r.data.error || "Save failed", "err");
  };
}

/* ---------- settings ---------- */
function wireSettings() {
  document.getElementById("saveSettings").onclick = async () => {
    const r = await api(`/api/servers/${SERVER_ID}`, {
      method: "PUT",
      body: JSON.stringify({
        name: document.getElementById("sName").value.trim(),
        memoryMB: parseInt(document.getElementById("sMem").value, 10),
        autostart: document.getElementById("sAutostart").checked,
      }),
    });
    r.ok ? (toast("Settings saved", "ok"), refreshServer()) : toast(r.data.error || "Save failed", "err");
  };
  document.getElementById("deleteServer").onclick = async () => {
    const name = prompt(`Type the server name ("${SERVER.name}") to confirm deletion:`);
    if (name !== SERVER.name) { toast("Name did not match — cancelled", "err"); return; }
    const r = await api(`/api/servers/${SERVER_ID}?deleteFiles=1`, { method: "DELETE" });
    if (r.ok) { toast("Server deleted", "ok"); setTimeout(() => (location.href = "/"), 800); }
    else toast(r.data.error || "Delete failed", "err");
  };
}
