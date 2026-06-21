"""Shared FastAPI dependencies.

- get_session: one pooled AsyncSession per request (from the lifespan pool).
- get_current_provider: cookie -> live session -> active provider, else 401/403.
- require_admin: layers a role check on top.

Provider isolation is NOT enforced here — it is enforced in SQL in each
provider-scoped query (filter provider_id = current.id). This dependency only
authenticates; it does not authorize row access.
"""
from __future__ import annotations

from collections.abc import AsyncIterator

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from .auth import resolve_session
from .config import Settings
from .models import Provider, Role


def get_settings_dep(request: Request) -> Settings:
    return request.app.state.settings


async def get_session(request: Request) -> AsyncIterator[AsyncSession]:
    sessionmaker: async_sessionmaker[AsyncSession] = request.app.state.sessionmaker
    async with sessionmaker() as session:
        yield session


async def get_current_provider(
    request: Request,
    db: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings_dep),
) -> Provider:
    raw_token = request.cookies.get(settings.session_cookie_name)
    if not raw_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="not_authenticated")

    resolved = await resolve_session(db, raw_token)
    if resolved is None:
        # No session, expired, or revoked. The client should re-authenticate.
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="session_invalid")

    _session_row, provider = resolved
    if not provider.active:
        # Valid session but the account was deactivated (admin action). Distinct
        # 403 so the client can show the deactivation state and log out cleanly.
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="account_deactivated")

    return provider


async def require_admin(
    provider: Provider = Depends(get_current_provider),
) -> Provider:
    if provider.role != Role.admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="admin_required")
    return provider
