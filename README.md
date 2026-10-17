# MSOP Panel

A **Pterodactyl-style Minecraft server panel** — built from scratch, no Pterodactyl
required. Create Vanilla or Paper servers from your browser, watch the live
console, send commands, manage files, and control power — all from one dark,
fast dashboard.

![MSOP Panel](https://img.shields.io/badge/panel-MSOP-blue) ![node](https://img.shields.io/badge/node-%3E%3D20-green) ![mc](https://img.shields.io/badge/minecraft-vanilla%20%2B%20paper-darkgreen)

## Features

- **One-click server creation** — Vanilla (Mojang) or Paper (PaperMC), any
  release version, jar downloads automatically, EULA + `server.properties`
  generated for you
- **Live console** — real-time log stream over WebSocket, command input
  (`say`, `op`, `stop`, …), install progress bar
- **Power controls** — Start / Stop / Restart / Kill
- **Live stats** — CPU, memory, players online, uptime
- **File manager** — browse, edit, upload, download, rename, delete, new folders
  (sandboxed to each server's directory)
- **Settings** — rename, RAM allocation, auto-start on panel boot, connection
  info, delete
- **Users** — admin + user roles; admins see everything, users see their own
  servers; admins can create/reset/delete accounts
- **Auto port allocation** — servers get 25565, 25566, … automatically

## Requirements (the VPS)

- Ubuntu 20.04+ or Debian 11+ (x86_64), root/sudo access
- 2 GB+ RAM recommended (4 GB+ if you run servers with 2 GB each)
- Ports: panel port (default **3000**) + one game port per server (25565+)

> This panel **cannot** run on Vercel/shared hosting — it spawns real Java
> processes, so it needs a VPS (Hetzner, Contabo, DigitalOcean, Oracle free
> tier, …).

## Install

**One-liner** (as root / with sudo):

```bash
curl -fsSL https://raw.githubusercontent.com/MeowSamOPDZN/msop-panel/main/install.sh | sudo bash
```

**Or clone first:**

```bash
git clone https://github.com/MeowSamOPDZN/msop-panel.git
cd msop-panel
sudo ./install.sh
```

The installer will:
1. Install Node.js 20 + Java 21 (if missing)
2. Clone/update the panel to `/opt/msop-panel` and `npm install`
3. Ask for an **admin username/password**
4. Create a systemd service (`msop-panel`) that starts on boot
5. Print your panel URL, e.g. `http://YOUR_VPS_IP:3000`

Customise with env vars: `PANEL_DIR`, `PANEL_PORT`, `REPO`,
`MSOP_ADMIN_USER`, `MSOP_ADMIN_PASS`
(e.g. `curl … | sudo MSOP_ADMIN_USER=sam MSOP_ADMIN_PASS=secret123 bash`).

## Usage

1. Open `http://YOUR_VPS_IP:3000` and sign in.
2. **Create Server** → name it, pick Vanilla/Paper + version + RAM → Create.
   The jar downloads (watch the progress bar on the console tab).
3. Press **Start**. Players join with `YOUR_VPS_IP:25565`
   (the port is shown on the server card and in Settings).
4. If players can't connect: `sudo ufw allow 25565:25965/tcp`
   (also open them in your provider's firewall panel, e.g. Hetzner/Contabo).

## Updating

```bash
cd /opt/msop-panel && sudo ./update.sh
```

## Uninstall

```bash
sudo systemctl disable --now msop-panel
sudo rm /etc/systemd/system/msop-panel.service
sudo rm -rf /opt/msop-panel
```

## Manual install (no script)

```bash
# needs: node >= 20, java 21+
git clone https://github.com/MeowSamOPDZN/msop-panel.git
cd msop-panel
npm install --omit=dev
node server/setup.js --username admin --password 'choose-a-strong-one' --port 3000
npm start   # or: PORT=3000 node server/index.js
```

## Project layout

```
install.sh / update.sh      VPS installer & updater
server/
  index.js                  express + socket.io bootstrap
  db.js                     SQLite (users, servers)
  auth.js                   login sessions + admin user management
  servers.js                server CRUD, power, stats, console API
  minecraft.js              java process manager + jar installer
  files.js                  sandboxed file manager API
  versions.js               Mojang / PaperMC version listings
  setup.js                  creates .env + first admin user
public/                     dashboard UI (login, dashboard, server page)
data/                       SQLite db + server files (created at runtime)
```

## Security notes

- Run the panel behind a firewall; only expose the panel port to yourself
  if possible (or put it behind basic-auth / Cloudflare Tunnel).
- Admin passwords are bcrypt-hashed; sessions are signed cookies.
- The file manager cannot escape a server's own directory; `server.jar`
  can't be deleted from the UI.

## License

MIT — do whatever you want with it.
