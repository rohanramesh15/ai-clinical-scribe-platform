"""Patient resolution.

Patients are matched by (lower(first), lower(last), dob) — the spec's identity
rule (documented as production-unsafe in models.py). This is also what drives the
new-vs-returning-patient behavior: a returning patient resolves to an existing
row that already has finalized encounters.
"""
from __future__ import annotations

from datetime import date

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Patient


async def _find(db: AsyncSession, first: str, last: str, dob: date) -> Patient | None:
    return (
        await db.execute(
            select(Patient).where(
                func.lower(Patient.first_name) == first.lower(),
                func.lower(Patient.last_name) == last.lower(),
                Patient.dob == dob,
            )
        )
    ).scalar_one_or_none()


async def resolve_or_create_patient(
    db: AsyncSession, first_name: str, last_name: str, dob: date
) -> Patient:
    first, last = first_name.strip(), last_name.strip()

    existing = await _find(db, first, last, dob)
    if existing is not None:
        return existing

    # Insert in a savepoint so a concurrent insert (unique-constraint race) is
    # caught and we fall back to re-selecting the now-existing row.
    try:
        async with db.begin_nested():
            patient = Patient(first_name=first, last_name=last, dob=dob)
            db.add(patient)
            await db.flush()
        return patient
    except IntegrityError:
        found = await _find(db, first, last, dob)
        if found is None:  # pragma: no cover - shouldn't happen
            raise
        return found
