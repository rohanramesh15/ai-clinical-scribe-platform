"""Pydantic request/response schemas. Grows per milestone."""
from __future__ import annotations

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
