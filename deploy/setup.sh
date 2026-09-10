#!/usr/bin/env bash
#
# One-time provisioning for a fresh Ubuntu 24.04 VPS.
#
# What this does, in order:
#   1. Adds 2GB swap (the box currently has none — cheap insurance against a
#      memory spike; the app itself measures well under that, see below).
#   2. Installs Node 20 LTS, nginx, and a firewall.
#   3. Creates a dedicated `torix` user — the app never needs to run as root.
#   4. Clones the repo and installs dependencies.
#   5. Installs the systemd service and nginx site from this same folder.
#
# Run as root (or with sudo) on the VPS:
#   sudo bash deploy/setup.sh
#
# Measured resource use (national NPPES scan, the heaviest operation this
# tool does): 468 MB peak RSS, ~13 GB disk for the source file + database.
# A 2 vCPU / 5.8 GB / 46 GB box has several times that headroom.

set -euo pipefail

REPO_URL="https://github.com/zeeshan-aslam-dev/Torix-Tool.git"
APP_USER="torix"
APP_DIR="/opt/torix-tool"
NPPES_DIR="/opt/nppes-data"
DOMAIN_OR_IP="45.131.64.102"

echo "== 1/6  swap =="
if [ "$(swapon --show | wc -l)" -eq 0 ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "2GB swap added."
else
  echo "swap already present, skipping."
fi

echo "== 2/6  packages =="
apt-get update -y
apt-get install -y curl git nginx ufw

# Node 20 LTS via NodeSource — Next.js 14 needs 18.18+ or 20+.
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node -v
npm -v

echo "== 3/6  firewall =="
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

echo "== 4/6  app user + directories =="
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash "$APP_USER"
mkdir -p "$NPPES_DIR"
chown -R "$APP_USER":"$APP_USER" "$NPPES_DIR"

echo "== 5/6  clone + build =="
if [ ! -d "$APP_DIR/.git" ]; then
  git clone "$REPO_URL" "$APP_DIR"
else
  echo "$APP_DIR already exists, pulling latest instead of cloning."
  cd "$APP_DIR" && sudo -u "$APP_USER" git pull
fi
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"

if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  sed -i "s#NPPES_DATA_DIR=\"\"#NPPES_DATA_DIR=\"$NPPES_DIR\"#" "$APP_DIR/.env"
  echo ""
  echo "  !! $APP_DIR/.env created from the template — SERPAPI_KEY etc. are"
  echo "     still blank. Edit it now (or copy your local .env's values in)"
  echo "     before starting the service, or Step 3 will fall back to free"
  echo "     sources only."
  echo ""
fi

cd "$APP_DIR"
sudo -u "$APP_USER" npm ci
sudo -u "$APP_USER" npx prisma generate
sudo -u "$APP_USER" npx prisma db push
sudo -u "$APP_USER" npm run build

echo "== 6/6  service + nginx =="
cp "$APP_DIR/deploy/torix-tool.service" /etc/systemd/system/torix-tool.service
systemctl daemon-reload
systemctl enable torix-tool
systemctl restart torix-tool

sed "s/DOMAIN_OR_IP/$DOMAIN_OR_IP/" "$APP_DIR/deploy/nginx.conf" > /etc/nginx/sites-available/torix-tool
ln -sf /etc/nginx/sites-available/torix-tool /etc/nginx/sites-enabled/torix-tool
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl restart nginx

echo ""
echo "Done. Next steps:"
echo "  1. Upload the 11GB NPPES file into $NPPES_DIR (scp/rsync from your machine)."
echo "  2. Fill in $APP_DIR/.env with your API keys, then:"
echo "       systemctl restart torix-tool"
echo "  3. Open http://$DOMAIN_OR_IP/pipeline in a browser."
echo "  4. Check logs any time with: journalctl -u torix-tool -f"
