"""Authentication endpoints: login, logout, me."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import (
    clear_auth_cookies,
    create_session,
    issue_csrf_token,
    revoke_by_token,
    set_csrf_cookie,
    set_session_cookie,
)
from ..config import Settings
from ..deps import get_current_provider, get_session, get_settings_dep
from ..models import Provider
from ..schemas import LoginRequest, MeResponse, ProviderOut
from ..security import verify_password

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _provider_out(p: Provider) -> ProviderOut:
    return ProviderOut(id=p.id, email=p.email, role=p.role.value, active=p.active)


@router.post("/login", response_model=MeResponse)
async def login(
    body: LoginRequest,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings_dep),
) -> MeResponse:
    provider = (
        await db.execute(
            select(Provider).where(func.lower(Provider.email) == body.email.lower())
        )
    ).scalar_one_or_none()

    # Generic failure for unknown email OR bad password (no account enumeration).
    if provider is None or not verify_password(provider.password_hash, body.password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid_credentials"
        )
    if not provider.active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="account_deactivated"
        )

    raw_token = await create_session(
        db,
        provider.id,
        settings,
        ip=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
    )
    csrf_token = issue_csrf_token()
    await db.commit()

    set_session_cookie(response, raw_token, settings)
    set_csrf_cookie(response, csrf_token, settings)
    return MeResponse(provider=_provider_out(provider), csrf_token=csrf_token)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings_dep),
) -> Response:
    # Logout is best-effort and must succeed even without a valid session.
    raw_token = request.cookies.get(settings.session_cookie_name)
    if raw_token:
        await revoke_by_token(db, raw_token)
        await db.commit()
    clear_auth_cookies(response, settings)
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@router.get("/me", response_model=MeResponse)
async def me(
    request: Request,
    response: Response,
    provider: Provider = Depends(get_current_provider),
    settings: Settings = Depends(get_settings_dep),
) -> MeResponse:
    # Ensure the SPA always has a readable CSRF token paired with its session.
    csrf_token = request.cookies.get(settings.csrf_cookie_name)
    if not csrf_token:
        csrf_token = issue_csrf_token()
        set_csrf_cookie(response, csrf_token, settings)
    return MeResponse(provider=_provider_out(provider), csrf_token=csrf_token)
