"""Per-provider, per-IP daily generation rate limit.

Two layers, matching services/rate_limit.py's own design:
  1. Direct service-level tests (real DB session, no HTTP/Gemini) — exact
     counting, threshold, per-IP isolation, per-day reset, and the "no limit
     configured" no-op default.
  2. One HTTP integration test confirming the router actually wires the check
     in (429 on the 3rd request from the same IP for a rate-limited account;
     an unlimited account is unaffected). The real Gemini client is patched
     out so this stays fast and hermetic, like the rest of the suite.

Run: pytest tests/test_rate_limit.py  (docker Postgres up + seed run)
"""
from __future__ import annotations

from datetime import date, timedelta

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.main import app
from app.models import GenerationRateLimit, Provider
from app.services.rate_limit import check_and_increment_generation_limit

RATE_LIMITED_EMAIL = "dr.santos@northclinic.com"  # seeded with limit=2, see app/seed.py
UNLIMITED_EMAIL = "dr.reed@northclinic.com"
PASSWORD = "ScribeDemo2026!"


async def _provider(sessionmaker, email: str) -> Provider:
    async with sessionmaker() as db:
        return (
            await db.execute(select(Provider).where(Provider.email == email))
        ).scalar_one()


@pytest.mark.asyncio
async def test_noop_when_provider_has_no_limit_configured(sessionmaker):
    provider = await _provider(sessionmaker, UNLIMITED_EMAIL)
    assert provider.max_generations_per_ip_per_day is None
    async with sessionmaker() as db:
        # Should never raise and never write a row, regardless of call count.
        for _ in range(5):
            await check_and_increment_generation_limit(db, provider, "203.0.113.9")
        rows = (
            await db.execute(
                select(GenerationRateLimit).where(
                    GenerationRateLimit.provider_id == provider.id
                )
            )
        ).scalars().all()
        assert rows == []


@pytest.mark.asyncio
async def test_blocks_after_the_configured_count_for_that_ip(sessionmaker):
    provider = await _provider(sessionmaker, RATE_LIMITED_EMAIL)
    assert provider.max_generations_per_ip_per_day == 2
    ip = "198.51.100.1"

    async with sessionmaker() as db:
        # Clean slate for this IP/day so the test is order-independent.
        await db.execute(
            GenerationRateLimit.__table__.delete().where(
                GenerationRateLimit.provider_id == provider.id,
                GenerationRateLimit.ip == ip,
            )
        )
        await db.commit()

        await check_and_increment_generation_limit(db, provider, ip)  # 1st: ok
        await check_and_increment_generation_limit(db, provider, ip)  # 2nd: ok

        with pytest.raises(HTTPException) as exc_info:
            await check_and_increment_generation_limit(db, provider, ip)  # 3rd: blocked
        assert exc_info.value.status_code == 429
        assert exc_info.value.detail["error"] == "generation_rate_limited"

        # Still blocked, and the count doesn't run away unboundedly.
        with pytest.raises(HTTPException):
            await check_and_increment_generation_limit(db, provider, ip)

        row = (
            await db.execute(
                select(GenerationRateLimit).where(
                    GenerationRateLimit.provider_id == provider.id,
                    GenerationRateLimit.ip == ip,
                )
            )
        ).scalar_one()
        assert row.count == 2


@pytest.mark.asyncio
async def test_limit_is_per_ip_not_per_account(sessionmaker):
    provider = await _provider(sessionmaker, RATE_LIMITED_EMAIL)
    ip_a, ip_b = "198.51.100.2", "198.51.100.3"

    async with sessionmaker() as db:
        await db.execute(
            GenerationRateLimit.__table__.delete().where(
                GenerationRateLimit.provider_id == provider.id,
                GenerationRateLimit.ip.in_([ip_a, ip_b]),
            )
        )
        await db.commit()

        # Exhaust ip_a...
        await check_and_increment_generation_limit(db, provider, ip_a)
        await check_and_increment_generation_limit(db, provider, ip_a)
        with pytest.raises(HTTPException):
            await check_and_increment_generation_limit(db, provider, ip_a)

        # ...ip_b is a completely separate budget.
        await check_and_increment_generation_limit(db, provider, ip_b)
        await check_and_increment_generation_limit(db, provider, ip_b)
        with pytest.raises(HTTPException):
            await check_and_increment_generation_limit(db, provider, ip_b)


@pytest.mark.asyncio
async def test_limit_resets_on_a_new_day(sessionmaker):
    provider = await _provider(sessionmaker, RATE_LIMITED_EMAIL)
    ip = "198.51.100.4"
    yesterday = date.today() - timedelta(days=1)

    async with sessionmaker() as db:
        await db.execute(
            GenerationRateLimit.__table__.delete().where(
                GenerationRateLimit.provider_id == provider.id,
                GenerationRateLimit.ip == ip,
            )
        )
        # Simulate yesterday's usage already at the cap.
        db.add(
            GenerationRateLimit(
                provider_id=provider.id, ip=ip, day=yesterday, count=2
            )
        )
        await db.commit()

        # Today is a fresh budget — yesterday's row is untouched.
        await check_and_increment_generation_limit(db, provider, ip)
        await check_and_increment_generation_limit(db, provider, ip)
        with pytest.raises(HTTPException):
            await check_and_increment_generation_limit(db, provider, ip)

        old_row = (
            await db.execute(
                select(GenerationRateLimit).where(
                    GenerationRateLimit.provider_id == provider.id,
                    GenerationRateLimit.ip == ip,
                    GenerationRateLimit.day == yesterday,
                )
            )
        ).scalar_one()
        assert old_row.count == 2  # untouched by today's checks


def _login(client: TestClient, email: str) -> dict[str, str]:
    r = client.post("/api/auth/login", json={"email": email, "password": PASSWORD})
    assert r.status_code == 200, r.text
    return {"X-CSRF-Token": client.cookies.get("scribe_csrf")}


def _new_encounter(client: TestClient, headers: dict, last_name: str) -> int:
    r = client.post(
        "/api/encounters",
        headers=headers,
        json={"first_name": "Rate", "last_name": last_name, "dob": "1990-01-01"},
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


@pytest.mark.asyncio
async def test_generate_endpoint_returns_429_on_the_third_request_same_ip(sessionmaker):
    # Clean slate for today, any IP — the test doesn't depend on what
    # TestClient reports as request.client.host, only that it's consistent
    # across requests within this test run.
    provider = await _provider(sessionmaker, RATE_LIMITED_EMAIL)
    async with sessionmaker() as db:
        await db.execute(
            GenerationRateLimit.__table__.delete().where(
                GenerationRateLimit.provider_id == provider.id,
                GenerationRateLimit.day == date.today(),
            )
        )
        await db.commit()

    with TestClient(app) as client:
        # No real Gemini call needed to prove the rate-limit gate — it runs
        # before the client-configured check in the router.
        client.app.state.genai_client = None

        headers = _login(client, RATE_LIMITED_EMAIL)
        transcript = "Patient reports mild headache for two days, no red flags."

        statuses = []
        for i in range(3):
            eid = _new_encounter(client, headers, f"Limit{i}")
            r = client.post(
                f"/api/encounters/{eid}/generate",
                headers=headers,
                json={"transcript": transcript, "template_id": None},
            )
            statuses.append(r.status_code)
        assert statuses == [200, 200, 429], statuses
        assert client.request(
            "POST",
            f"/api/encounters/{_new_encounter(client, headers, 'LimitCheck')}/generate",
            headers=headers,
            json={"transcript": transcript, "template_id": None},
        ).json()["detail"]["error"] == "generation_rate_limited"

        # A different (unlimited) account, same IP, same TestClient — unaffected.
        headers2 = _login(client, UNLIMITED_EMAIL)
        eid2 = _new_encounter(client, headers2, "Unlimited")
        r = client.post(
            f"/api/encounters/{eid2}/generate",
            headers=headers2,
            json={"transcript": transcript, "template_id": None},
        )
        assert r.status_code == 200
