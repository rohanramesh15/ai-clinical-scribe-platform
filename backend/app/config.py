"""Single source of truth for configuration.

Non-secret knobs (model IDs, pool sizes, cookie policy) live here as typed
settings sourced from the environment. SECRETS (DB credentials, Gemini key) are
NOT read here directly in production — they are fetched in `lifespan` via
`app.secrets.load_runtime_secrets` from AWS Secrets Manager. Locally they come
from the gitignored .env. Keeping model IDs in one place satisfies the brief's
"never hardcode model IDs across the codebase" rule.
"""
from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    # local => secrets from env/.env ; production => secrets from Secrets Manager
    app_env: Literal["local", "production"] = "local"

    # Local-dev secret inputs (overridden by Secrets Manager in production).
    database_url: str = (
        "postgresql+asyncpg://scribe:scribe_local_dev@localhost:5432/scribe"
    )
    gemini_api_key: str = ""

    # Production secret source.
    aws_region: str = "us-east-1"
    app_secret_name: str = "clinical-scribe/app"

    # --- Gemini model IDs (verified against Google's model docs, 2026) ---
    # Flash-tier for SOAP generation; Flash-Lite-tier for the cheap pre-check.
    generation_model: str = "gemini-3.5-flash"
    precheck_model: str = "gemini-3.1-flash-lite"

    # --- Embeddings: local sentence-transformers MiniLM (384-dim), no API call ---
    embedding_model: str = "sentence-transformers/all-MiniLM-L6-v2"
    embedding_dim: int = 384

    # --- Connection pool ---
    # Total DB connections = (uvicorn workers) x (db_pool_size + db_max_overflow).
    # Size this against RDS max_connections. See app/db.py.
    db_pool_size: int = 5
    db_max_overflow: int = 5
    db_pool_timeout: int = 30
    db_pool_recycle: int = 1800  # recycle conns < RDS idle timeout

    # --- Session / cookie policy ---
    session_ttl_hours: int = 12
    session_cookie_name: str = "scribe_session"
    csrf_cookie_name: str = "scribe_csrf"
    cookie_secure: bool = True  # MUST be true in production (HTTPS only)
    cookie_samesite: Literal["lax", "strict", "none"] = "lax"


@lru_cache
def get_settings() -> Settings:
    return Settings()
