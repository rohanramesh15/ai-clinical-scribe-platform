"""Runtime secret loading.

Called ONCE in `lifespan`, before the connection pool is built. In production
this pulls DB credentials and the Gemini key from AWS Secrets Manager via the
EC2 instance's IAM role (no keys on disk). Locally it falls back to the
gitignored .env values already on `Settings`.

The Secrets Manager payload is a JSON blob, e.g.:
    {
      "db_username": "...", "db_password": "...",
      "db_host": "...", "db_port": "5432", "db_name": "scribe",
      "gemini_api_key": "..."
    }
"""
from __future__ import annotations

import json
from dataclasses import dataclass

from .config import Settings


@dataclass(frozen=True)
class RuntimeSecrets:
    database_url: str  # SQLAlchemy asyncpg URL
    gemini_api_key: str


def _load_from_secrets_manager(settings: Settings) -> RuntimeSecrets:
    # boto3 is imported lazily so local dev never needs AWS libs configured.
    import boto3

    client = boto3.client("secretsmanager", region_name=settings.aws_region)
    raw = client.get_secret_value(SecretId=settings.app_secret_name)["SecretString"]
    data = json.loads(raw)

    user = data["db_username"]
    pwd = data["db_password"]
    host = data["db_host"]
    port = data.get("db_port", "5432")
    name = data.get("db_name", "scribe")
    url = f"postgresql+asyncpg://{user}:{pwd}@{host}:{port}/{name}"
    return RuntimeSecrets(database_url=url, gemini_api_key=data["gemini_api_key"])


def load_runtime_secrets(settings: Settings) -> RuntimeSecrets:
    if settings.app_env == "production":
        return _load_from_secrets_manager(settings)
    # local: values came from the gitignored .env via Settings
    return RuntimeSecrets(
        database_url=settings.database_url,
        gemini_api_key=settings.gemini_api_key,
    )
