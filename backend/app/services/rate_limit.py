"""Per-provider, per-IP daily generation rate limit.

Opt-in per account via Provider.max_generations_per_ip_per_day (NULL for
everyone by default -> this is a no-op for the whole app unless an admin sets
it on a specific provider). When set, each distinct client IP that account is
used from gets its own budget of that many note generations per calendar day
(UTC), tracked in generation_rate_limits.

Concurrency: the (provider, ip, day) row is created via INSERT ... ON CONFLICT
DO NOTHING first (safe if two requests race to create it), then locked with
SELECT ... FOR UPDATE before the count is read/incremented — the same
row-lock pattern services/versions.py uses for version_no allocation.
"""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import GenerationRateLimit, Provider


async def check_and_increment_generation_limit(
    db: AsyncSession, provider: Provider, ip: str | None
) -> None:
    limit = provider.max_generations_per_ip_per_day
    if limit is None:
        return
    if not ip:
        # No client IP to key on (shouldn't happen behind nginx) — fail open
        # rather than block every generation on this account.
        return

    today = datetime.now(timezone.utc).date()

    await db.execute(
        pg_insert(GenerationRateLimit)
        .values(provider_id=provider.id, ip=ip, day=today, count=0)
        .on_conflict_do_nothing(
            index_elements=["provider_id", "ip", "day"],
        )
    )

    row = (
        await db.execute(
            select(GenerationRateLimit)
            .where(
                GenerationRateLimit.provider_id == provider.id,
                GenerationRateLimit.ip == ip,
                GenerationRateLimit.day == today,
            )
            .with_for_update()
        )
    ).scalar_one()

    if row.count >= limit:
        await db.commit()  # release the row lock cleanly before raising
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={
                "error": "generation_rate_limited",
                "message": (
                    f"This account can generate at most {limit} note"
                    f"{'s' if limit != 1 else ''} per day from this network. "
                    "Try again tomorrow."
                ),
            },
        )

    row.count += 1
    await db.commit()
