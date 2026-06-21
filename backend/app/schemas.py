"""Pydantic request/response schemas. Grows per milestone."""
from __future__ import annotations

from datetime import date, datetime

from pydantic import BaseModel, EmailStr, Field


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1)


class ProviderOut(BaseModel):
    id: int
    email: str
    role: str
    active: bool


class MeResponse(BaseModel):
    provider: ProviderOut
    csrf_token: str


# --- Encounters / drafts (M3) ---

class PatientOut(BaseModel):
    id: int
    public_id: str
    first_name: str
    last_name: str
    dob: date


class CreateEncounterRequest(BaseModel):
    first_name: str = Field(min_length=1, max_length=120)
    last_name: str = Field(min_length=1, max_length=120)
    dob: date
    template_id: int | None = None


class EncounterPatch(BaseModel):
    """Debounced autosave payload. All fields optional — partial update."""
    transcript: str | None = None
    working_note: dict | None = None
    template_id: int | None = None


class EncounterListItem(BaseModel):
    id: int
    public_id: str
    patient_name: str
    patient_dob: date
    status: str
    has_working_note: bool
    created_at: datetime
    updated_at: datetime


class EncounterDetail(BaseModel):
    id: int
    public_id: str
    patient: PatientOut
    provider_id: int
    template_id: int | None
    status: str
    transcript: str | None
    working_note: dict | None
    current_note_version_id: int | None
    prior_encounter_count: int  # finalized encounters for this patient (badge)
    created_at: datetime
    updated_at: datetime

