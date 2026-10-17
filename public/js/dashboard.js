/* MSOP Panel — dashboard */
let ME = null;

(async function init() {
  ME = await requireAuth();
  if (!ME) return;
  paintUser(ME);
  if (ME.role === "admin") {
    document.getElementById("navUsers").style.display = "";
    loadUsers();
  }
  if (new URLSearchParams(location.search).get("tab") === "users" && ME.role === "admin") {
    showTab("users");
  }
  loadServers();
  setInterval(loadServers, 8000);
  wireCreate();
  wireUsers();
})();

function showTab(which) {
  document.getElementById("dashView").style.display = which === "dash" ? "" : "none";
  document.getElementById("usersView").style.display = which === "users" ? "" : "none";
  document.querySelectorAll(".nav a").forEach((a) => a.classList.remove("active"));
}
document.getElementById("navUsers").addEventListener("click", (e) => { e.preventDefault(); showTab("users"); });
document.querySelector('.nav a[href="/"]').addEventListener("click", (e) => { e.preventDefault(); showTab("dash"); });

async function loadServers() {
  const r = await api("/api/servers");
  if (!r.ok) return;
  const grid = document.getElementById("serverGrid");
  const list = r.data.servers;
  document.getElementById("emptyState").style.display = list.length ? "none" : "";
  grid.innerHTML = list.map((s) => `
    <div class="card">
      <div class="srv-top">
        <span class="srv-name">${esc(s.name)}</span>
        <span class="pill ${pillClass(s.status)}"><span class="dot"></span>${esc(s.status.replace("_", " "))}</span>
      </div>
      <div class="srv-meta">
        <span class="chip">${s.type === "paper" ? "Paper" : "Vanilla"} ${esc(s.version)}</span>
        <span>Port <b>${s.port}</b></span>
        <span><b>${(s.memory_mb / 1024).toFixed(s.memory_mb % 1024 ? 1 : 0)} GB</b> RAM</span>
      </div>
      <div class="srv-actions">
        <a class="btn btn-primary btn-sm" href="/server.html?id=${s.id}">Manage →</a>
      </div>
    </div>`).join("");
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------- create server ---------- */
let versionCache = { vanilla: null, paper: null };

async function loadVersions(type) {
  if (versionCache[type]) return versionCache[type];
  const r = await api("/api/versions?type=" + type);
  if (!r.ok) throw new Error(r.data.error || "Could not load versions");
  versionCache[type] = r.data.versions;
  return versionCache[type];
}

async function fillVersions() {
  const type = document.getElementById("fType").value;
  const sel = document.getElementById("fVersion");
  sel.innerHTML = "<option>Loading…</option>";
  try {
    const vs = await loadVersions(type);
    sel.innerHTML = vs.map((v, i) => `<option value="${esc(v)}"${i === 0 ? " selected" : ""}>${esc(v)}${i === 0 ? " (latest)" : ""}</option>`).join("");
  } catch (e) {
    sel.innerHTML = `<option value="">${esc(e.message)}</option>`;
  }
}

function wireCreate() {
  document.getElementById("createBtn").onclick = () => { fillVersions(); openModal("createModal"); };
  document.getElementById("fType").onchange = fillVersions;
  document.getElementById("doCreate").onclick = async () => {
    const btn = document.getElementById("doCreate");
    btn.disabled = true; btn.textContent = "Creating…";
    try {
      const r = await api("/api/servers", {
        method: "POST",
        body: JSON.stringify({
          name: document.getElementById("fName").value.trim(),
          type: document.getElementById("fType").value,
          version: document.getElementById("fVersion").value,
          memoryMB: parseInt(document.getElementById("fMem").value, 10),
        }),
      });
      if (!r.ok) throw new Error(r.data.error || "Create failed");
      closeModal("createModal");
      document.getElementById("fName").value = "";
      toast("Server created — installing the jar, watch the console.", "ok");
      location.href = "/server.html?id=" + r.data.server.id;
    } catch (e) {
      toast(e.message, "err");
    } finally {
      btn.disabled = false; btn.textContent = "Create Server";
    }
  };
}

/* ---------- users (admin) ---------- */
async function loadUsers() {
  const r = await api("/api/auth/users");
  if (!r.ok) return;
  document.getElementById("userRows").innerHTML = r.data.users.map((u) => `
    <tr>
      <td><b>${esc(u.username)}</b></td>
      <td><span class="chip">${esc(u.role)}</span></td>
      <td style="color:var(--muted)">${fmtDate(new Date(u.created_at).getTime())}</td>
      <td style="text-align:right">
        <button class="iconbtn" onclick="resetPass(${u.id}, '${esc(u.username)}')">Reset pass</button>
        <button class="iconbtn" onclick="delUser(${u.id}, '${esc(u.username)}')">Delete</button>
      </td>
    </tr>`).join("");
}

window.resetPass = async (id, name) => {
  const p = prompt(`New password for ${name}:`);
  if (!p) return;
  const r = await api(`/api/auth/users/${id}/password`, { method: "POST", body: JSON.stringify({ password: p }) });
  r.ok ? toast("Password updated", "ok") : toast(r.data.error || "Failed", "err");
};
window.delUser = async (id, name) => {
  if (!confirm(`Delete user ${name}? Their servers stay but become admin-visible.`)) return;
  const r = await api(`/api/auth/users/${id}`, { method: "DELETE" });
  r.ok ? (toast("User deleted", "ok"), loadUsers()) : toast(r.data.error || "Failed", "err");
};

function wireUsers() {
  document.getElementById("addUserBtn").onclick = () => openModal("userModal");
  document.getElementById("doAddUser").onclick = async () => {
    const r = await api("/api/auth/users", {
      method: "POST",
      body: JSON.stringify({
        username: document.getElementById("uName").value.trim(),
        password: document.getElementById("uPass").value,
        role: document.getElementById("uRole").value,
      }),
    });
    if (!r.ok) { toast(r.data.error || "Failed", "err"); return; }
    closeModal("userModal");
    document.getElementById("uName").value = "";
    document.getElementById("uPass").value = "";
    toast("User added", "ok");
    loadUsers();
  };
}
