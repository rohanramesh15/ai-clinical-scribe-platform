"""Async SQLAlchemy engine + connection pool.

ONE pool, created ONCE in `lifespan` (see app/main.py) and stored on
`app.state`. Requests acquire/release a session via the `get_session`
dependency. We NEVER open a connection per request.

Connection math (call it out for the reviewer): with N uvicorn workers each
process holds its own pool, so total server-side connections =
    N x (db_pool_size + db_max_overflow)
Size that sum below RDS `max_connections`.
"""
from __future__ import annotations

from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from .config import Settings


def build_engine(database_url: str, settings: Settings) -> AsyncEngine:
    """Create the async engine with a bounded pool. Called once at startup."""
    return create_async_engine(
        database_url,
        pool_size=settings.db_pool_size,
        max_overflow=settings.db_max_overflow,
        pool_timeout=settings.db_pool_timeout,
        pool_recycle=settings.db_pool_recycle,
        pool_pre_ping=True,  # transparently drop dead conns (RDS failover/idle cull)
        echo=False,
    )


def build_sessionmaker(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(
        engine, expire_on_commit=False, autoflush=False, class_=AsyncSession
    )


async def session_dependency(
    sessionmaker: async_sessionmaker[AsyncSession],
) -> AsyncIterator[AsyncSession]:
    """Yield a session from the shared pool; always closed (returned to pool)."""
    async with sessionmaker() as session:
        yield session
