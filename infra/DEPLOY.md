# Deployment Runbook — Clinical Scribe

Steps marked **[HUMAN]** require your AWS account/credentials. Everything else is
scripted. Default topology: a single EC2 box (nginx + app) in a public subnet,
RDS in private subnets (not publicly accessible), TLS via Let's Encrypt, secrets
in AWS Secrets Manager read through an EC2 instance role.

```
Internet ─443/80─► EC2 (nginx ─► uvicorn@127.0.0.1:8000)  ──5432──► RDS (private)
                     │                                              SG: app SG only
                     └─► Gemini API (via Internet Gateway, no NAT)
```

## 0. Prerequisites
- An AWS account, the AWS CLI configured, Terraform >= 1.5, an EC2 key pair.
- A domain you control (for a real TLS cert — self-signed is not acceptable).
- A Gemini API key (https://aistudio.google.com/apikey).

## 1. Provision infrastructure — **[HUMAN]**
```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars   # fill in: key_name, admin_cidr,
                                               # db_password, gemini_api_key
terraform init
terraform apply
```
Recommended: configure an **encrypted S3 backend** for state first — `terraform
apply` writes the DB password and Gemini key into state. `terraform.tfvars` is
gitignored; never commit it.

Note the outputs: `app_public_ip`, `rds_endpoint`, `app_secret_name`.

Terraform creates: VPC, 1 public + 2 private subnets, IGW + route table, the app
and RDS security groups (RDS accepts 5432 from the **app SG only**), the RDS
PostgreSQL 16 instance (`publicly_accessible = false`), the Secrets Manager
secret `clinical-scribe/app` (populated with DB creds + Gemini key), the EC2
instance role (read access to **only** that secret), and the EC2 instance.

## 2. DNS — **[HUMAN]**
Create an A record for your domain pointing at `app_public_ip`. Wait for it to
resolve (certbot needs it).

## 3. Bootstrap the instance — **[HUMAN, on the box]**
```bash
ssh ubuntu@<app_public_ip>
sudo SCRIBE_DOMAIN=scribe.example.com \
     CERTBOT_EMAIL=you@example.com \
     REPO_URL=https://github.com/<you>/clinical-scribe.git \
     bash /opt/scribe/infra/bootstrap.sh
```
If the repo isn't already at `/opt/scribe`, clone it there first (or the script
clones it). `bootstrap.sh` installs nginx/Python 3.12/Node, creates the `scribe`
user, builds the SPA, installs the systemd unit, obtains a Let's Encrypt cert,
and starts everything.

## 4. Create the schema + seed — **[HUMAN, on the box, once]**
```bash
cd /opt/scribe/backend
sudo -u scribe env APP_ENV=production AWS_REGION=us-east-1 APP_SECRET_NAME=clinical-scribe/app \
  .venv/bin/alembic upgrade head
sudo -u scribe env APP_ENV=production AWS_REGION=us-east-1 APP_SECRET_NAME=clinical-scribe/app \
  SEED_DEMO_PASSWORD='choose-demo-pw' .venv/bin/python -m app.seed
```
The seed prints the demo credentials once. (Alembic/seed read DB creds from
Secrets Manager via the instance role — no creds on disk.)

## 5. Verify
- `https://scribe.example.com/` loads the SPA over valid TLS.
- `systemctl status scribe-api` is active; `curl -sk https://localhost/api/health`.
- The app process is bound to `127.0.0.1:8000` only (`ss -tlnp` shows nginx on
  443/80, uvicorn on loopback) — it is never directly on 80/443.

## Redeploys
```bash
ssh ubuntu@<ip>
sudo bash /opt/scribe/infra/deploy.sh   # git pull, rebuild SPA, migrate, restart
```

## Demonstrating the security posture (code walkthrough)
- **RDS not public:** `aws rds describe-db-instances` → `PubliclyAccessible: false`;
  the RDS SG ingress is `security_groups = [app_sg]`, not a CIDR. From your laptop
  `psql` to the RDS endpoint times out; from the EC2 box it connects.
- **Connection pooling:** one async engine/pool built once in `lifespan`
  (`backend/app/db.py` + `main.py`); requests borrow a session via a dependency.
  Total conns = workers × (pool_size + max_overflow). No per-request connections.
- **Secrets:** nothing in the repo. `grep -ri AIza .` and a check for committed
  `.env` come up empty. Creds live in Secrets Manager, fetched via the instance
  role; `.env` is local-dev-only and gitignored.
- **Reverse proxy:** nginx terminates TLS and is the only public process;
  `proxy_buffering off` on the `/api/encounters/{id}/generate` location keeps the
  SSE stream live (without it, streaming collapses to a single dump).

## Scale-up topology (not built here — production notes)
- EC2 in a **private** subnet behind an **ALB** (ACM cert), with a **NAT gateway**
  for egress and a **Secrets Manager VPC endpoint** (so secret reads stay on the
  AWS network).
- Frontend via **S3 + CloudFront** instead of nginx static serving.
- **RDS Proxy** / read replicas as load grows; Multi-AZ RDS for HA.
- For real PHI: switch Gemini calls to **Vertex AI** (same `google-genai` SDK,
  an auth/config change) to operate under a Google **BAA** — verify current
  Vertex config + HIPAA terms from Google's docs.
