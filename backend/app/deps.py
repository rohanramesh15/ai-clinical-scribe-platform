"""Shared FastAPI dependencies.

`get_session` hands out one pooled `AsyncSession` per request, sourced from the
single process-wide sessionmaker built in `lifespan` and stored on
`app.state`. Auth dependencies (get_current_provider / require_admin) are added
in M2 and will build on this.
"""
from __future__ import annotations

from collections.abc import AsyncIterator

from fastapi import Request
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from .config import Settings


def get_settings_dep(request: Request) -> Settings:
    return request.app.state.settings


async def get_session(request: Request) -> AsyncIterator[AsyncSession]:
    sessionmaker: async_sessionmaker[AsyncSession] = request.app.state.sessionmaker
    async with sessionmaker() as session:
        yield session
