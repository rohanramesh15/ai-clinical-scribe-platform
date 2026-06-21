"""Audit log writes. Every admin MUTATION calls this (reads do not).

The row is added to the caller's session and committed in the same transaction
as the mutation it records, so an audited action and its log entry are atomic.
"""
from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from ..models import AuditLog


async def write_audit(
    db: AsyncSession,
    *,
    actor_provider_id: int,
    action: str,
    entity_type: str,
    entity_id: int | None = None,
    extra: dict | None = None,
) -> None:
    db.add(
        AuditLog(
            actor_provider_id=actor_provider_id,
            action=action,
            entity_type=entity_type,
            entity_id=entity_id,
            extra=extra,
        )
    )
