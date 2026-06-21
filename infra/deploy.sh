#!/usr/bin/env bash
# Repeat deploy: pull, build the SPA into the web root, install backend deps,
# migrate, restart the API. The two cd'd sections below are the entire
# monorepo deploy "complication". Run as root/sudo on the instance.
set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/scribe}"
WEB_ROOT="${WEB_ROOT:-/var/www/scribe}"

echo "==> git pull"
git -C "$REPO_DIR" pull --ff-only

echo "==> [frontend] build SPA -> $WEB_ROOT"
cd "$REPO_DIR/frontend"
npm ci
npm run build
rm -rf "${WEB_ROOT:?}/"*
cp -r dist/* "$WEB_ROOT/"
chown -R www-data:www-data "$WEB_ROOT"

echo "==> [backend] deps + migrate + restart"
cd "$REPO_DIR/backend"
sudo -u scribe "$REPO_DIR/backend/.venv/bin/pip" install -r requirements.txt
# Alembic reads DB creds from Secrets Manager (APP_ENV=production) via env.py.
sudo -u scribe \
  env APP_ENV=production AWS_REGION="${AWS_REGION:-us-east-1}" APP_SECRET_NAME="${APP_SECRET_NAME:-clinical-scribe/app}" \
  "$REPO_DIR/backend/.venv/bin/alembic" upgrade head

systemctl restart scribe-api
echo "==> Deploy complete."
