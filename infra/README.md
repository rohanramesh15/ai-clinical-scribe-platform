# infra/

Deployment artifacts are produced in **M11**. This folder will contain:

- `nginx.conf` — TLS termination, SPA web root at `/`, `/api` reverse proxy to
  `127.0.0.1:8000`, `proxy_buffering off` on the SSE/generation location.
- `scribe-api.service` — systemd unit running uvicorn/gunicorn on
  `127.0.0.1:8000` (auto-start, auto-restart). The app is never directly on
  80/443; nginx is the only network-facing process.
- `bootstrap.sh` — one-time host setup (nginx/Python/Node, systemd unit, certbot
  cert, web root).
- `deploy.sh` — repeat deploy (build frontend → copy `dist/` to web root;
  backend deps → `alembic upgrade head` → `systemctl restart scribe-api`).
- Terraform (or scripts) for VPC / subnets / security groups / RDS / EC2.
- `DEPLOY.md` — runbook, marking which steps the human runs with AWS creds.

Topology (default take-home): EC2 in a public subnet runs nginx + the app;
RDS in a private subnet (`publicly_accessible=false`), reachable only from the
app's security group; valid TLS via Let's Encrypt; secrets via Secrets Manager
read through an IAM instance role.
