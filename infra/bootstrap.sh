#!/usr/bin/env bash
# One-time host setup for the Clinical Scribe EC2 instance (Ubuntu 24.04, which
# ships Python 3.12 + nginx 1.24). Run as root/sudo ON the instance after
# Terraform creates it. Idempotent where practical. See infra/DEPLOY.md.
#
# Cert sequencing matters: nginx's 443 server block references the Let's Encrypt
# cert, which does not exist yet — so we obtain the cert FIRST (certbot
# standalone, which briefly binds port 80) and only THEN install the 443 config.
set -euo pipefail

DOMAIN="${SCRIBE_DOMAIN:?set SCRIBE_DOMAIN, e.g. scribe.example.com}"
EMAIL="${CERTBOT_EMAIL:?set CERTBOT_EMAIL for Lets Encrypt}"
REPO_URL="${REPO_URL:?set REPO_URL to the git clone URL}"
REPO_BRANCH="${REPO_BRANCH:-main}"
APP_DIR=/opt/scribe
WEB_ROOT=/var/www/scribe

echo "==> Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y nginx git curl python3.12 python3.12-venv python3-pip \
    certbot

echo "==> Installing Node.js 20 (for the frontend build)"
if ! command -v node >/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "==> Adding 2G swap (t3.small has only 2G; torch/npm need headroom)"
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> Creating service user + directories"
id scribe >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin scribe
mkdir -p "$APP_DIR" "$WEB_ROOT"

echo "==> Cloning the repo ($REPO_BRANCH)"
if [ ! -d "$APP_DIR/.git" ]; then
  git clone -b "$REPO_BRANCH" "$REPO_URL" "$APP_DIR"
fi
chown -R scribe:scribe "$APP_DIR"

echo "==> Python venv (backend deps installed by deploy.sh)"
sudo -u scribe python3.12 -m venv "$APP_DIR/backend/.venv"

echo "==> Installing systemd unit"
install -m 644 "$APP_DIR/infra/scribe-api.service" /etc/systemd/system/scribe-api.service
systemctl daemon-reload
systemctl enable scribe-api

echo "==> Obtaining a real TLS certificate (Lets Encrypt, standalone)"
# Port 80 must be free for the standalone challenge; nginx may already be up.
systemctl stop nginx || true
certbot certonly --standalone -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL"
# Renewal hooks so the scheduled `certbot renew` works with nginx normally running.
mkdir -p /etc/letsencrypt/renewal-hooks/pre /etc/letsencrypt/renewal-hooks/post
printf '#!/bin/sh\nsystemctl stop nginx\n' > /etc/letsencrypt/renewal-hooks/pre/stop-nginx.sh
printf '#!/bin/sh\nsystemctl start nginx\n' > /etc/letsencrypt/renewal-hooks/post/start-nginx.sh
chmod +x /etc/letsencrypt/renewal-hooks/pre/stop-nginx.sh /etc/letsencrypt/renewal-hooks/post/start-nginx.sh

echo "==> Installing nginx site (now that the cert exists)"
sed "s/SCRIBE_DOMAIN/${DOMAIN}/g" "$APP_DIR/infra/nginx.conf" > /etc/nginx/sites-available/scribe
ln -sf /etc/nginx/sites-available/scribe /etc/nginx/sites-enabled/scribe
rm -f /etc/nginx/sites-enabled/default

echo "==> Build + migrate + start the app (delegates to deploy.sh)"
REPO_DIR="$APP_DIR" WEB_ROOT="$WEB_ROOT" bash "$APP_DIR/infra/deploy.sh"

echo "==> Starting nginx"
nginx -t && systemctl start nginx

echo "==> Bootstrap complete. App: https://${DOMAIN}/"
echo "    Run the seed once (see DEPLOY.md) to create demo accounts + ICD codes."
