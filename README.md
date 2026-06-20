# Clinical Scribe Platform

Provider-facing AI clinical documentation tool. A physician pastes an encounter
transcript (or types observations); the app streams back a structured SOAP note
(Subjective / Objective / Assessment / Plan) with grounded ICD-10 codes, supports
inline editing with full immutable version history, and provides an admin
dashboard. FastAPI + Gemini + PostgreSQL/pgvector + React, behind nginx with TLS.

## Layout

```
clinical-scribe/
  backend/    FastAPI app, SQLAlchemy models, Alembic migrations, seed script
  frontend/   React + Vite + TypeScript SPA (built static, served by nginx)
  infra/      nginx.conf, systemd unit, bootstrap/deploy scripts, Terraform, runbook
  docker-compose.yml   local Postgres + pgvector
```

## Stack

- **Backend:** Python 3.12, FastAPI, async SQLAlchemy 2.0 + asyncpg, Alembic.
- **AI:** Google Gemini via `google-genai` (async). Generation `gemini-3.5-flash`,
  pre-check `gemini-3.1-flash-lite` (configurable in `backend/app/config.py`).
- **DB:** PostgreSQL 16 + pgvector. ICD-10 embeddings via local
  `sentence-transformers/all-MiniLM-L6-v2` (384-dim).
- **Frontend:** React + Vite + TypeScript + Tailwind. React state/hooks only.
- **Serving:** nginx terminates TLS, serves the built SPA, reverse-proxies `/api`
  to uvicorn on `127.0.0.1:8000` (managed by systemd).

## Local dev

```bash
# 1. Start Postgres + pgvector
docker compose up -d

# 2. Backend
cd backend
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
cp .env.example .env          # then put your Gemini key in backend/.env (M4+)
alembic upgrade head          # (M1) create schema
python -m app.seed            # (M1) seed providers, ICD-10 codes, templates
uvicorn app.main:app --reload --port 8000

# 3. Frontend (separate terminal)
cd frontend
npm install
npm run dev                   # proxies /api -> 127.0.0.1:8000
```

Health check: `curl http://localhost:8000/api/health`.

## Secrets

No credentials are committed. Local secrets live in the gitignored `backend/.env`
(copy from `backend/.env.example`). In deployment, DB credentials and the Gemini
key are read from **AWS Secrets Manager** via the EC2 instance's IAM role —
see `infra/DEPLOY.md` (produced in M11).

## Build status

Built in milestones M0–M11; see the development notes / commit history. Current:
**M0 scaffold** complete (monorepo, docker-compose, FastAPI skeleton with
config/secrets loader, single async connection pool in `lifespan`, `/api/health`).
