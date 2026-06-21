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

import json

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import Settings
from ..deps import get_current_provider, get_session, get_settings_dep
from ..models import (
    Encounter,
    EncounterStatus,
    Icd10Code,
    NoteVersion,
    NoteVersionDiagnosis,
    Patient,
    Provider,
    Template,
)
from ..schemas import (
    CreateEncounterRequest,
    DiagnosisOut,
    EncounterDetail,
    EncounterListItem,
    EncounterPatch,
    GenerateRequest,
    PatientOut,
    RedFlag,
    RedFlagScanRequest,
    RedFlagScanResponse,
    SaveVersionRequest,
    SaveVersionResponse,
    VersionDetail,
    VersionListItem,
)
from ..services.generation import run_generation_stream
from ..services.patients import resolve_or_create_patient
from ..services.redflags import scan_red_flags
from ..services.versions import StaleEditError, save_version


def _sse(event: dict) -> str:
    # One SSE message per event; JSON payload avoids newline-encoding issues.
    return f"data: {json.dumps(event)}\n\n"

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

    current_version_no = None
    if enc.current_note_version_id is not None:
        current_version_no = (
            await db.execute(
                select(NoteVersion.version_no).where(
                    NoteVersion.id == enc.current_note_version_id
                )
            )
        ).scalar_one_or_none()

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
        current_version_no=current_version_no,
        prior_encounter_count=int(prior_count),
        created_at=enc.created_at,
        updated_at=enc.updated_at,
    )


async def _version_detail(db: AsyncSession, nv: NoteVersion) -> VersionDetail:
    created_by_email = (
        await db.execute(select(Provider.email).where(Provider.id == nv.created_by))
    ).scalar_one()
    diag_rows = (
        await db.execute(
            select(
                Icd10Code.code,
                Icd10Code.description,
                NoteVersionDiagnosis.is_primary,
                NoteVersionDiagnosis.source,
            )
            .join(Icd10Code, Icd10Code.id == NoteVersionDiagnosis.icd10_code_id)
            .where(NoteVersionDiagnosis.note_version_id == nv.id)
            .order_by(NoteVersionDiagnosis.is_primary.desc(), Icd10Code.code)
        )
    ).all()
    return VersionDetail(
        id=nv.id,
        version_no=nv.version_no,
        subjective=nv.subjective,
        objective=nv.objective,
        assessment=nv.assessment,
        plan=nv.plan,
        created_by_email=created_by_email,
        created_at=nv.created_at,
        diagnoses=[
            DiagnosisOut(code=c, description=d, is_primary=p, source=s.value)
            for c, d, p, s in diag_rows
        ],
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


@router.post("/{encounter_id}/generate")
async def generate_note(
    encounter_id: int,
    body: GenerateRequest,
    request: Request,
    provider: Provider = Depends(get_current_provider),
    db: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings_dep),
) -> StreamingResponse:
    """Stream a SOAP note over SSE via the manual function-calling loop.

    Ownership and the FRESH template body are resolved here (request session);
    the long-running generation opens its own session for tool calls so it isn't
    tied to the request-scoped session's lifetime.
    """
    enc = await _get_owned(db, encounter_id, provider)

    transcript = body.transcript if body.transcript is not None else (enc.transcript or "")
    template_id = body.template_id if body.template_id is not None else enc.template_id

    # Template body is read FRESH at generation time (not cached on the client),
    # so an admin's edit takes effect on the very next generation.
    template_prompt: str | None = None
    if template_id is not None:
        tmpl = (
            await db.execute(select(Template).where(Template.id == template_id))
        ).scalar_one_or_none()
        template_prompt = tmpl.system_prompt if tmpl else None

    patient_id = enc.patient_id
    prior_count = (
        await db.execute(
            select(func.count(Encounter.id)).where(
                Encounter.patient_id == patient_id,
                Encounter.id != enc.id,
                Encounter.status == EncounterStatus.finalized,
            )
        )
    ).scalar_one()

    client = request.app.state.genai_client
    sessionmaker = request.app.state.sessionmaker

    async def event_stream():
        # Badge first: whether history will be injected (server-side fact).
        yield _sse({"type": "meta", "prior_encounter_count": int(prior_count)})
        if client is None:
            yield _sse(
                {
                    "type": "error",
                    "message": "gemini_not_configured",
                    "detail": "GEMINI_API_KEY is not set on the server.",
                }
            )
            return
        async for event in run_generation_stream(
            client,
            sessionmaker,
            patient_id=patient_id,
            transcript=transcript,
            template_prompt=template_prompt,
            settings=settings,
        ):
            yield _sse(event)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            # Belt-and-suspenders with nginx `proxy_buffering off` — disables
            # buffering at proxies that honor this hint, so deltas flush live.
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/{encounter_id}/redflags", response_model=RedFlagScanResponse)
async def scan_encounter_red_flags(
    encounter_id: int,
    body: RedFlagScanRequest,
    request: Request,
    provider: Provider = Depends(get_current_provider),
    db: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings_dep),
) -> RedFlagScanResponse:
    enc = await _get_owned(db, encounter_id, provider)
    transcript = body.transcript or enc.transcript or ""
    flags = await scan_red_flags(request.app.state.genai_client, transcript, settings)
    return RedFlagScanResponse(flags=[RedFlag(**f) for f in flags])


@router.post("/{encounter_id}/versions", response_model=SaveVersionResponse, status_code=201)
async def save_note_version(
    encounter_id: int,
    body: SaveVersionRequest,
    provider: Provider = Depends(get_current_provider),
    db: AsyncSession = Depends(get_session),
) -> SaveVersionResponse:
    enc = await _get_owned(db, encounter_id, provider)
    try:
        nv, dropped = await save_version(db, enc, provider, body)
    except StaleEditError as exc:
        # 409: a newer version exists. Append-only means nothing is lost, but the
        # provider must not unknowingly overwrite. Client shows a conflict notice.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error": "stale_edit",
                "latest_version_no": exc.latest_version_no,
                "message": (
                    f"This note changed since you opened it (v{exc.latest_version_no} "
                    "now exists). Review the latest before saving."
                ),
            },
        )
    detail = await _version_detail(db, nv)
    await db.commit()  # single transaction: version + diagnoses + pointer + status
    return SaveVersionResponse(version=detail, dropped_codes=dropped)


@router.get("/{encounter_id}/versions", response_model=list[VersionListItem])
async def list_versions(
    encounter_id: int,
    provider: Provider = Depends(get_current_provider),
    db: AsyncSession = Depends(get_session),
) -> list[VersionListItem]:
    await _get_owned(db, encounter_id, provider)
    rows = (
        await db.execute(
            select(
                NoteVersion.id,
                NoteVersion.version_no,
                Provider.email,
                NoteVersion.created_at,
                func.count(NoteVersionDiagnosis.id),
            )
            .join(Provider, Provider.id == NoteVersion.created_by)
            .outerjoin(
                NoteVersionDiagnosis,
                NoteVersionDiagnosis.note_version_id == NoteVersion.id,
            )
            .where(NoteVersion.encounter_id == encounter_id)
            .group_by(NoteVersion.id, Provider.email)
            .order_by(NoteVersion.version_no.desc())
        )
    ).all()
    return [
        VersionListItem(
            id=vid,
            version_no=vno,
            created_by_email=email,
            created_at=created_at,
            diagnosis_count=int(dcount),
        )
        for vid, vno, email, created_at, dcount in rows
    ]


@router.get("/{encounter_id}/versions/{version_no}", response_model=VersionDetail)
async def get_version(
    encounter_id: int,
    version_no: int,
    provider: Provider = Depends(get_current_provider),
    db: AsyncSession = Depends(get_session),
) -> VersionDetail:
    await _get_owned(db, encounter_id, provider)
    nv = (
        await db.execute(
            select(NoteVersion).where(
                NoteVersion.encounter_id == encounter_id,
                NoteVersion.version_no == version_no,
            )
        )
    ).scalar_one_or_none()
    if nv is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="version_not_found")
    return await _version_detail(db, nv)
