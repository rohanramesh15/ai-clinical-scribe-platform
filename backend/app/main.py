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

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from .config import get_settings
from .db import build_engine, build_sessionmaker
from .routers import admin as admin_router
from .routers import auth as auth_router
from .routers import encounters as encounters_router
from .routers import icd as icd_router
from .routers import templates as templates_router
from .secrets import load_runtime_secrets

# Unsafe methods require a matching CSRF token (double-submit cookie). Login is
# exempt because it establishes the session and is protected by credentials.
_CSRF_EXEMPT_PATHS = {"/api/auth/login"}
_UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


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

    # Build the Gemini client once (or None if the key isn't configured yet —
    # the generate endpoint surfaces a clear error rather than crashing boot).
    app.state.genai_client = None
    if secrets.gemini_api_key:
        from .llm import build_genai_client

        app.state.genai_client = build_genai_client(secrets.gemini_api_key)

    try:
        yield
    finally:
        await engine.dispose()


def create_app() -> FastAPI:
    app = FastAPI(title="Clinical Scribe API", lifespan=lifespan)

    @app.middleware("http")
    async def csrf_protect(request: Request, call_next):
        if request.method in _UNSAFE_METHODS and request.url.path not in _CSRF_EXEMPT_PATHS:
            settings = request.app.state.settings
            header_token = request.headers.get("x-csrf-token")
            cookie_token = request.cookies.get(settings.csrf_cookie_name)
            if not header_token or not cookie_token or header_token != cookie_token:
                return JSONResponse(status_code=403, content={"detail": "csrf_failed"})
        return await call_next(request)

    app.include_router(auth_router.router)
    app.include_router(encounters_router.router)
    app.include_router(icd_router.router)
    app.include_router(templates_router.router)
    app.include_router(admin_router.router)

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
