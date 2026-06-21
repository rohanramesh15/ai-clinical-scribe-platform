"""Encounter + draft endpoints (provider-scoped).

Provider isolation is enforced IN SQL here: every query filters
provider_id == current_provider.id. A non-owned encounter id returns 404 (we do
not reveal that it exists).

Draft lifecycle: transcript + working_note are overwrite-in-place via PATCH
(debounced autosave from the client), persisted to RDS so a refresh or a
different browser restores the exact in-progress state. Finalized versions are a
separate, append-only mechanism (M5).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..deps import get_current_provider, get_session
from ..models import Encounter, EncounterStatus, Patient, Provider
from ..schemas import (
    CreateEncounterRequest,
    EncounterDetail,
    EncounterListItem,
    EncounterPatch,
    PatientOut,
)
from ..services.patients import resolve_or_create_patient

router = APIRouter(prefix="/api/encounters", tags=["encounters"])


async def _get_owned(db: AsyncSession, encounter_id: int, provider: Provider) -> Encounter:
    enc = (
        await db.execute(
            select(Encounter).where(
                Encounter.id == encounter_id,
                Encounter.provider_id == provider.id,  # isolation in SQL
            )
        )
    ).scalar_one_or_none()
    if enc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="encounter_not_found")
    return enc


async def _to_detail(db: AsyncSession, enc: Encounter) -> EncounterDetail:
    patient = (
        await db.execute(select(Patient).where(Patient.id == enc.patient_id))
    ).scalar_one()
    # Clinic-wide finalized encounter count for this patient (excluding this one)
    # — powers the passive "N prior encounters found" badge. Note content is NOT
    # exposed to the frontend here; history injection happens server-side in M4.
    prior_count = (
        await db.execute(
            select(func.count(Encounter.id)).where(
                Encounter.patient_id == enc.patient_id,
                Encounter.id != enc.id,
                Encounter.status == EncounterStatus.finalized,
            )
        )
    ).scalar_one()
    return EncounterDetail(
        id=enc.id,
        public_id=str(enc.public_id),
        patient=PatientOut(
            id=patient.id,
            public_id=str(patient.public_id),
            first_name=patient.first_name,
            last_name=patient.last_name,
            dob=patient.dob,
        ),
        provider_id=enc.provider_id,
        template_id=enc.template_id,
        status=enc.status.value,
        transcript=enc.transcript,
        working_note=enc.working_note,
        current_note_version_id=enc.current_note_version_id,
        prior_encounter_count=int(prior_count),
        created_at=enc.created_at,
        updated_at=enc.updated_at,
    )


@router.post("", response_model=EncounterDetail, status_code=status.HTTP_201_CREATED)
async def create_encounter(
    body: CreateEncounterRequest,
    provider: Provider = Depends(get_current_provider),
    db: AsyncSession = Depends(get_session),
) -> EncounterDetail:
    patient = await resolve_or_create_patient(db, body.first_name, body.last_name, body.dob)
    enc = Encounter(
        patient_id=patient.id,
        provider_id=provider.id,
        template_id=body.template_id,
        status=EncounterStatus.draft,
    )
    db.add(enc)
    await db.flush()
    detail = await _to_detail(db, enc)
    await db.commit()
    return detail


@router.get("", response_model=list[EncounterListItem])
async def list_encounters(
    provider: Provider = Depends(get_current_provider),
    db: AsyncSession = Depends(get_session),
) -> list[EncounterListItem]:
    rows = (
        await db.execute(
            select(Encounter, Patient)
            .join(Patient, Patient.id == Encounter.patient_id)
            .where(Encounter.provider_id == provider.id)  # isolation in SQL
            .order_by(Encounter.created_at.desc())
        )
    ).all()
    return [
        EncounterListItem(
            id=enc.id,
            public_id=str(enc.public_id),
            patient_name=f"{pat.last_name}, {pat.first_name}",
            patient_dob=pat.dob,
            status=enc.status.value,
            has_working_note=bool(enc.working_note),
            created_at=enc.created_at,
            updated_at=enc.updated_at,
        )
        for enc, pat in rows
    ]


@router.get("/{encounter_id}", response_model=EncounterDetail)
async def get_encounter(
    encounter_id: int,
    provider: Provider = Depends(get_current_provider),
    db: AsyncSession = Depends(get_session),
) -> EncounterDetail:
    enc = await _get_owned(db, encounter_id, provider)
    return await _to_detail(db, enc)


@router.patch("/{encounter_id}", response_model=EncounterDetail)
async def autosave_encounter(
    encounter_id: int,
    body: EncounterPatch,
    provider: Provider = Depends(get_current_provider),
    db: AsyncSession = Depends(get_session),
) -> EncounterDetail:
    enc = await _get_owned(db, encounter_id, provider)

    # Partial, overwrite-in-place autosave. Only touch provided fields.
    fields = body.model_dump(exclude_unset=True)
    if "transcript" in fields:
        enc.transcript = body.transcript
    if "working_note" in fields:
        enc.working_note = body.working_note
    if "template_id" in fields:
        enc.template_id = body.template_id

    await db.flush()
    # updated_at has a server-side onupdate (now()); reload it through the async
    # path so building the response doesn't trigger a sync lazy-load.
    await db.refresh(enc)
    detail = await _to_detail(db, enc)
    await db.commit()
    return detail
