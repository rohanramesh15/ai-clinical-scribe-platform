"""FastAPI application entrypoint.

`lifespan` is where the expensive, process-wide singletons are built ONCE:
  1. load runtime secrets (Secrets Manager in prod, .env locally)
  2. build the async engine + connection pool
  3. build the session factory
They're stored on `app.state` and shared by every request via dependencies.
Per-request code never builds engines or opens raw connections.
"""
from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from .config import get_settings
from .db import build_engine, build_sessionmaker
from .secrets import load_runtime_secrets


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    secrets = load_runtime_secrets(settings)

    engine = build_engine(secrets.database_url, settings)
    sessionmaker = build_sessionmaker(engine)

    # Stash the singletons for the whole process lifetime.
    app.state.settings = settings
    app.state.engine = engine
    app.state.sessionmaker = sessionmaker
    app.state.gemini_api_key = secrets.gemini_api_key

    try:
        yield
    finally:
        await engine.dispose()


def create_app() -> FastAPI:
    app = FastAPI(title="Clinical Scribe API", lifespan=lifespan)

    @app.get("/api/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/health/db")
    async def health_db() -> dict[str, str]:
        # Proves the pool is live end-to-end without per-request engine creation.
        sessionmaker: async_sessionmaker[AsyncSession] = app.state.sessionmaker
        async with sessionmaker() as session:
            await session.execute(text("SELECT 1"))
        return {"status": "ok", "db": "reachable"}

    return app


app = create_app()
