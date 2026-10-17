#!/usr/bin/env bash
#
# MSOP Panel — one-command installer for Ubuntu 20.04+ / Debian 11+
#
#   One-liner:
#     curl -fsSL https://raw.githubusercontent.com/MeowSamOPDZN/msop-panel/main/install.sh | sudo bash
#
#   Or clone first:
#     git clone https://github.com/MeowSamOPDZN/msop-panel.git
#     cd msop-panel
#     sudo ./install.sh
#
# Env overrides: PANEL_DIR, PANEL_PORT, REPO, MSOP_ADMIN_USER, MSOP_ADMIN_PASS
#
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: please run as root (e.g.  sudo ./install.sh)" >&2
  exit 1
fi

PANEL_DIR="${PANEL_DIR:-/opt/msop-panel}"
PANEL_PORT="${PANEL_PORT:-3000}"
REPO="${REPO:-https://github.com/MeowSamOPDZN/msop-panel.git}"

echo "=========================================="
echo "  MSOP Panel installer"
echo "=========================================="

if [ -f /etc/os-release ]; then . /etc/os-release; fi
case "${ID:-unknown}" in
  ubuntu|debian) ;;
  *) echo "WARNING: untested distro (${ID:-unknown}) — continuing anyway" ;;
esac

export DEBIAN_FRONTEND=noninteractive
echo "-> updating packages…"
apt-get update -qq
apt-get install -y -qq curl git ca-certificates gnupg

# ---- Node.js 20 ----
if ! command -v node >/dev/null 2>&1 || ! node -v 2>/dev/null | grep -qE '^v(20|22|24)'; then
  echo "-> installing Node.js 20…"
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs
fi
echo "✓ node $(node -v)"

# ---- Java 21 (Minecraft needs it) ----
if ! command -v java >/dev/null 2>&1; then
  echo "-> installing Java 21…"
  apt-get install -y -qq openjdk-21-jre-headless
fi
echo "✓ $(java -version 2>&1 | head -n 1)"

# ---- panel code ----
if [ -d "$PANEL_DIR/.git" ]; then
  echo "-> updating existing install at $PANEL_DIR…"
  git -C "$PANEL_DIR" pull --ff-only
else
  echo "-> cloning MSOP Panel to $PANEL_DIR…"
  git clone "$REPO" "$PANEL_DIR"
fi
cd "$PANEL_DIR"
echo "-> installing dependencies…"
npm install --omit=dev --no-audit --no-fund

# ---- admin account (prompt on a TTY, env vars otherwise) ----
ADMIN_USER="${MSOP_ADMIN_USER:-}"
ADMIN_PASS="${MSOP_ADMIN_PASS:-}"
if [ -z "$ADMIN_USER" ]; then
  if [ -t 0 ]; then read -rp "Admin username [admin]: " ADMIN_USER; else read -rp "Admin username [admin]: " ADMIN_USER < /dev/tty 2>/dev/null || true; fi
  ADMIN_USER="${ADMIN_USER:-admin}"
fi
if [ -z "$ADMIN_PASS" ]; then
  if [ -t 0 ]; then read -rsp "Admin password (min 6 chars): " ADMIN_PASS && echo
  else read -rsp "Admin password (min 6 chars): " ADMIN_PASS < /dev/tty 2>/dev/null && echo || true; fi
fi
if [ -z "$ADMIN_PASS" ]; then
  ADMIN_PASS="$(tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 16)"
  echo "-> generated random admin password (no TTY available)"
fi
node server/setup.js --username "$ADMIN_USER" --password "$ADMIN_PASS" --port "$PANEL_PORT"

# ---- systemd service ----
echo "-> installing systemd service…"
cat > /etc/systemd/system/msop-panel.service <<EOF
[Unit]
Description=MSOP Panel - Minecraft server panel
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$PANEL_DIR
Environment=PORT=$PANEL_PORT
ExecStart=/usr/bin/node $PANEL_DIR/server/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now msop-panel >/dev/null
sleep 2

# ---- firewall hint ----
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "$PANEL_PORT"/tcp >/dev/null && echo "✓ opened panel port $PANEL_PORT in ufw"
  echo "  NOTE: open game ports too:  sudo ufw allow 25565:25965/tcp"
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo ""
echo "=========================================="
echo "  MSOP Panel is running!"
echo ""
echo "  Panel:    http://$IP:$PANEL_PORT"
echo "  Username: $ADMIN_USER"
if [ -n "${MSOP_ADMIN_PASS:-}" ]; then
  echo "  Password: (the one you set)"
else
  echo "  Password: $ADMIN_PASS"
fi
echo ""
echo "  Create a server in the panel, press Start,"
echo "  and join with  $IP:<port shown on the card>"
echo "=========================================="
