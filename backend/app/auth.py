"""Server-side session auth.

Why sessions (not stateless JWT): two required scenarios — session-expiry on save
and admin-deactivation mid-draft — need *instant* revocation. A JWT is valid
until it expires; a DB-backed session can be killed on the next request.

Token handling: the cookie carries a high-entropy RAW token; the DB stores only
its sha256 hash. A DB leak therefore yields no usable sessions (you can't reverse
the hash back into a cookie value).
"""
from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import Response
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from .config import Settings
from .models import Provider, Session as SessionModel


def _hash_token(raw_token: str) -> str:
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


async def create_session(
    db: AsyncSession,
    provider_id: int,
    settings: Settings,
    *,
    ip: str | None,
    user_agent: str | None,
) -> str:
    """Create a session row and return the RAW token (to put in the cookie)."""
    raw_token = secrets.token_urlsafe(32)
    row = SessionModel(
        provider_id=provider_id,
        token_hash=_hash_token(raw_token),
        expires_at=_now() + timedelta(hours=settings.session_ttl_hours),
        last_seen_at=_now(),
    )
    row.ip = ip
    row.user_agent = user_agent
    db.add(row)
    await db.flush()
    return raw_token


async def resolve_session(
    db: AsyncSession, raw_token: str
) -> tuple[SessionModel, Provider] | None:
    """Look up a live session by raw token. Returns (session, provider) or None.

    'Live' = exists, not expired, not revoked. The provider's `active` flag is
    NOT checked here — the caller distinguishes 401 (no/invalid session) from
    403 (valid session but deactivated account) for the deactivation scenario.
    """
    token_hash = _hash_token(raw_token)
    result = await db.execute(
        select(SessionModel, Provider)
        .join(Provider, Provider.id == SessionModel.provider_id)
        .where(SessionModel.token_hash == token_hash)
    )
    row = result.first()
    if row is None:
        return None
    session_row, provider = row
    if session_row.revoked_at is not None:
        return None
    if session_row.expires_at <= _now():
        return None
    return session_row, provider


async def touch_session(db: AsyncSession, session_id: int) -> None:
    await db.execute(
        update(SessionModel)
        .where(SessionModel.id == session_id)
        .values(last_seen_at=_now())
    )


async def revoke_by_token(db: AsyncSession, raw_token: str) -> None:
    await db.execute(
        update(SessionModel)
        .where(SessionModel.token_hash == _hash_token(raw_token))
        .where(SessionModel.revoked_at.is_(None))
        .values(revoked_at=_now())
    )


async def revoke_all_for_provider(db: AsyncSession, provider_id: int) -> int:
    """Revoke every live session for a provider (used on admin deactivation)."""
    result = await db.execute(
        update(SessionModel)
        .where(SessionModel.provider_id == provider_id)
        .where(SessionModel.revoked_at.is_(None))
        .values(revoked_at=_now())
    )
    return result.rowcount or 0


# --- Cookie helpers ---------------------------------------------------------

def set_session_cookie(response: Response, raw_token: str, settings: Settings) -> None:
    response.set_cookie(
        key=settings.session_cookie_name,
        value=raw_token,
        max_age=settings.session_ttl_hours * 3600,
        httponly=True,  # JS cannot read the session token
        secure=settings.cookie_secure,
        samesite=settings.cookie_samesite,
        path="/",
    )


def issue_csrf_token() -> str:
    return secrets.token_urlsafe(24)


def set_csrf_cookie(response: Response, csrf_token: str, settings: Settings) -> None:
    # NOT httponly: the SPA reads this and echoes it in the X-CSRF-Token header
    # (double-submit pattern). Cross-site pages can't read it (SameSite + no CORS).
    response.set_cookie(
        key=settings.csrf_cookie_name,
        value=csrf_token,
        max_age=settings.session_ttl_hours * 3600,
        httponly=False,
        secure=settings.cookie_secure,
        samesite=settings.cookie_samesite,
        path="/",
    )


def clear_auth_cookies(response: Response, settings: Settings) -> None:
    response.delete_cookie(settings.session_cookie_name, path="/")
    response.delete_cookie(settings.csrf_cookie_name, path="/")
