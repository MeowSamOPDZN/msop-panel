/* MSOP Panel — shared helpers */
async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  let data = {};
  try { data = await res.json(); } catch {}
  return { ok: res.ok, status: res.status, data };
}

async function requireAuth() {
  const r = await api("/api/auth/me");
  if (!r.ok) { location.href = "/login.html"; return null; }
  return r.data.user;
}

function paintUser(user) {
  const n = document.getElementById("chipName");
  const a = document.getElementById("chipAvatar");
  if (n) n.textContent = user.username + (user.role === "admin" ? " (admin)" : "");
  if (a) a.textContent = user.username[0].toUpperCase();
  const lb = document.getElementById("logoutBtn");
  if (lb) lb.onclick = async () => { await api("/api/auth/logout", { method: "POST" }); location.href = "/login.html"; };
}

function toast(msg, kind = "") {
  const box = document.getElementById("toasts");
  if (!box) return;
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; setTimeout(() => el.remove(), 300); }, 3400);
}

function openModal(id) { document.getElementById(id).classList.add("open"); }
function closeModal(id) { document.getElementById(id).classList.remove("open"); }
document.addEventListener("click", (e) => {
  if (e.target.hasAttribute("data-close")) closeModal(e.target.closest(".modal-back").id);
  if (e.target.classList && e.target.classList.contains("modal-back")) e.target.classList.remove("open");
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") document.querySelectorAll(".modal-back.open").forEach((m) => m.classList.remove("open"));
});

function fmtBytes(n) {
  if (!n) return "—";
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
  return (n / 1073741824).toFixed(2) + " GB";
}
function fmtDate(ms) {
  return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function fmtUptime(s) {
  if (!s || s < 5) return "—";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
function pillClass(status) {
  return { online: "online", offline: "offline", starting: "starting", stopping: "stopping", installing: "installing", install_failed: "install_failed" }[status] || "offline";
}
