"""Finalized-version save logic (append-only, immutable).

Two concurrency problems handled here (distinct, per the brief):
1. version_no race (double-click / two tabs): allocate under a row lock
   (SELECT ... FOR UPDATE on the encounter) so concurrent saves serialize and
   never collide on unique(encounter_id, version_no). Invisible to the user.
2. stale-edit / lost update: optimistic concurrency — the client passes the
   version_no it edited from; if a newer version exists we REJECT (409) so the
   physician never unknowingly overwrites. Append-only means nothing is lost.

Code grounding: every submitted code is validated against icd10_codes. Unmatched
codes are dropped (and reported), never written (would break the FK) and never
shown as authoritative.

The whole write (note_versions + note_version_diagnoses + current pointer +
status) happens in ONE transaction (the caller commits) — all-or-nothing.
"""
from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import (
    DiagnosisSource,
    Encounter,
    EncounterStatus,
    Icd10Code,
    NoteVersion,
    NoteVersionDiagnosis,
    Provider,
)
from ..schemas import SaveVersionRequest


class StaleEditError(Exception):
    """Raised when the save is based on a stale version (a newer one exists)."""

    def __init__(self, latest_version_no: int):
        self.latest_version_no = latest_version_no
        super().__init__(f"stale edit; latest is v{latest_version_no}")


async def save_version(
    db: AsyncSession,
    encounter: Encounter,
    provider: Provider,
    payload: SaveVersionRequest,
) -> tuple[NoteVersion, list[str]]:
    # Lock the encounter row: serializes concurrent saves for version_no safety.
    locked = (
        await db.execute(
            select(Encounter).where(Encounter.id == encounter.id).with_for_update()
        )
    ).scalar_one()

    current_max = (
        await db.execute(
            select(func.max(NoteVersion.version_no)).where(
                NoteVersion.encounter_id == encounter.id
            )
        )
    ).scalar() or 0

    # Optimistic concurrency: reject if the client edited from a stale version.
    if payload.based_on_version_no != current_max:
        raise StaleEditError(current_max)

    new_no = current_max + 1
    nv = NoteVersion(
        encounter_id=encounter.id,
        version_no=new_no,
        subjective=payload.subjective,
        objective=payload.objective,
        assessment=payload.assessment,
        plan=payload.plan,
        model_name=payload.model_name,
        system_prompt_snapshot=payload.system_prompt_snapshot,
        created_by=provider.id,
    )
    db.add(nv)
    await db.flush()  # get nv.id

    # Validate & attach codes. Drop anything not in the catalog (de-duplicated).
    dropped: list[str] = []
    seen: set[str] = set()
    for d in payload.codes:
        code = d.code.strip()
        if not code or code in seen:
            continue
        seen.add(code)
        code_id = (
            await db.execute(select(Icd10Code.id).where(Icd10Code.code == code))
        ).scalar_one_or_none()
        if code_id is None:
            dropped.append(code)  # unverified -> omitted, never written
            continue
        db.add(
            NoteVersionDiagnosis(
                note_version_id=nv.id,
                icd10_code_id=code_id,
                is_primary=d.is_primary,
                source=DiagnosisSource(d.source),
            )
        )

    # Advance the latest-version pointer and finalize the encounter.
    locked.current_note_version_id = nv.id
    locked.status = EncounterStatus.finalized
    await db.flush()
    return nv, dropped
