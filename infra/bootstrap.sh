#!/usr/bin/env bash
# One-time host setup for the Clinical Scribe EC2 instance (Ubuntu 24.04, which
# ships Python 3.12). Run as root/sudo ON the instance after Terraform creates it.
# Idempotent where practical. See infra/DEPLOY.md for the full runbook.
set -euo pipefail

DOMAIN="${SCRIBE_DOMAIN:?set SCRIBE_DOMAIN, e.g. scribe.example.com}"
EMAIL="${CERTBOT_EMAIL:?set CERTBOT_EMAIL for Lets Encrypt}"
REPO_URL="${REPO_URL:?set REPO_URL to the git clone URL}"
APP_DIR=/opt/scribe
WEB_ROOT=/var/www/scribe

echo "==> Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y nginx git curl python3.12 python3.12-venv python3-pip \
    certbot python3-certbot-nginx

echo "==> Installing Node.js 20 (for the frontend build)"
if ! command -v node >/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "==> Creating service user + directories"
id scribe >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin scribe
mkdir -p "$APP_DIR" "$WEB_ROOT"

echo "==> Cloning the repo"
if [ ! -d "$APP_DIR/.git" ]; then
  git clone "$REPO_URL" "$APP_DIR"
fi
chown -R scribe:scribe "$APP_DIR"

echo "==> Python venv + backend deps"
sudo -u scribe python3.12 -m venv "$APP_DIR/backend/.venv"
sudo -u scribe "$APP_DIR/backend/.venv/bin/pip" install --upgrade pip
sudo -u scribe "$APP_DIR/backend/.venv/bin/pip" install -r "$APP_DIR/backend/requirements.txt"

echo "==> Installing systemd unit"
install -m 644 "$APP_DIR/infra/scribe-api.service" /etc/systemd/system/scribe-api.service
systemctl daemon-reload
systemctl enable scribe-api

echo "==> Installing nginx site (HTTP first; certbot adds TLS)"
sed "s/SCRIBE_DOMAIN/${DOMAIN}/g" "$APP_DIR/infra/nginx.conf" > /etc/nginx/sites-available/scribe
ln -sf /etc/nginx/sites-available/scribe /etc/nginx/sites-enabled/scribe
rm -f /etc/nginx/sites-enabled/default

echo "==> Obtaining a real TLS certificate (Lets Encrypt)"
# certbot needs port 80 reachable and DNS pointing at this instance first.
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect

echo "==> First build + start (delegates to deploy.sh)"
REPO_DIR="$APP_DIR" WEB_ROOT="$WEB_ROOT" bash "$APP_DIR/infra/deploy.sh"

nginx -t && systemctl reload nginx
echo "==> Bootstrap complete. App: https://${DOMAIN}/"
echo "    Run the seed once (see DEPLOY.md) to create demo accounts + ICD codes."
