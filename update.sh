#!/usr/bin/env bash
# MSOP Panel updater — run on the VPS:  sudo ./update.sh   (from /opt/msop-panel)
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then echo "ERROR: run as root" >&2; exit 1; fi
cd "${PANEL_DIR:-/opt/msop-panel}"
echo "-> pulling latest code…"
git pull --ff-only
echo "-> installing dependencies…"
npm install --omit=dev --no-audit --no-fund
echo "-> restarting panel…"
systemctl restart msop-panel
echo "✓ MSOP Panel updated."
