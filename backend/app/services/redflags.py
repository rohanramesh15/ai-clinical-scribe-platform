"""Clinical red-flag scan (pioneer feature).

A cheap Flash-Lite pass over the transcript BEFORE note generation that surfaces
can't-miss / urgent findings (e.g., cardiac chest pain, cauda equina, sepsis,
suicidal ideation). Advisory only — it never blocks generation, and on any
failure it degrades to an empty list (never a crash).
"""
from __future__ import annotations

import json

from ..config import Settings

_SYSTEM = """\
You are a clinical safety triage assistant. Read the encounter transcript and \
identify only genuine CLINICAL RED FLAGS — findings that suggest a can't-miss, \
time-sensitive, or emergent condition a clinician must not overlook (e.g., \
features of acute coronary syndrome, stroke, cauda equina, sepsis/meningitis, \
PE, ectopic pregnancy, suicidal/homicidal ideation, anaphylaxis).

Return ONLY a JSON array. Each element: {"flag": short label, "rationale": one \
sentence tying it to the transcript, "severity": "high" or "moderate"}. If there \
are no red flags, return []. Do not invent findings not supported by the text.\
"""


async def scan_red_flags(client, transcript: str, settings: Settings) -> list[dict]:
    transcript = (transcript or "").strip()
    if client is None or len(transcript) < 12:
        return []
    try:
        from google.genai import types

        resp = await client.aio.models.generate_content(
            model=settings.precheck_model,
            contents=transcript,
            config=types.GenerateContentConfig(
                system_instruction=_SYSTEM,
                response_mime_type="application/json",
                temperature=0.0,
            ),
        )
        data = json.loads((resp.text or "[]").strip())
        if not isinstance(data, list):
            return []
        flags: list[dict] = []
        for item in data[:8]:
            if not isinstance(item, dict) or "flag" not in item:
                continue
            sev = item.get("severity", "moderate")
            flags.append(
                {
                    "flag": str(item["flag"])[:120],
                    "rationale": str(item.get("rationale", ""))[:240],
                    "severity": "high" if sev == "high" else "moderate",
                }
            )
        return flags
    except Exception:  # noqa: BLE001 - advisory feature, never crash the request
        return []
