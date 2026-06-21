"""Shared test fixtures (integration against the local docker DB)."""
import pytest_asyncio

from app.config import get_settings
from app.db import build_engine, build_sessionmaker
from app.secrets import load_runtime_secrets


@pytest_asyncio.fixture
async def sessionmaker():
    settings = get_settings()
    secrets = load_runtime_secrets(settings)
    engine = build_engine(secrets.database_url, settings)
    sm = build_sessionmaker(engine)
    try:
        yield sm
    finally:
        await engine.dispose()
