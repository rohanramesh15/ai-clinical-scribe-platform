"""Gemini generation pipeline: manual streaming function-calling loop.

Loop: stream a turn -> if the model emitted function-call parts, pause, run the
async DB work, append a function_response, and stream the next turn -> repeat
until the model returns the final note text. Only TEXT deltas are relayed to the
client (plus lightweight meta events); retrieval never touches the frontend.

Trust rules baked in:
- Each tool runs in try/except and returns a structured {"status": "unavailable"}
  on failure — an exception never crashes the stream.
- patient_id is SERVER-supplied (from the encounter), not taken from model args,
  so history retrieval can't be steered or leak across patients.
- A mid-stream failure emits a terminal `error` event; the client shows an
  explicit interrupted state (no infinite spinner).
"""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ..config import Settings
from ..embeddings import embed_text
from ..llm import INSUFFICIENT, build_system_instruction
from ..models import (
    Encounter,
    EncounterStatus,
    Icd10Code,
    NoteVersion,
    NoteVersionDiagnosis,
)

HISTORY_LIMIT = 5
ICD_TOPK = 8
# The model tends to issue one search_icd10 per problem across separate turns,
# so the bound must comfortably exceed the number of distinct problems.
MAX_TURNS = 14
MIN_CLINICAL_CHARS = 12


# --- Tool implementations ---------------------------------------------------

async def _get_patient_history(db: AsyncSession, patient_id: int) -> dict:
    rows = (
        await db.execute(
            select(NoteVersion, Encounter)
            .join(Encounter, Encounter.id == NoteVersion.encounter_id)
            .where(
                Encounter.patient_id == patient_id,
                Encounter.status == EncounterStatus.finalized,
                NoteVersion.id == Encounter.current_note_version_id,  # latest per encounter
            )
            .order_by(desc(NoteVersion.created_at))
            .limit(HISTORY_LIMIT)
        )
    ).all()

    prior = []
    for nv, enc in rows:
        codes = (
            await db.execute(
                select(Icd10Code.code, Icd10Code.description)
                .join(
                    NoteVersionDiagnosis,
                    NoteVersionDiagnosis.icd10_code_id == Icd10Code.id,
                )
                .where(NoteVersionDiagnosis.note_version_id == nv.id)
            )
        ).all()
        prior.append(
            {
                "date": enc.created_at.date().isoformat(),
                "subjective": nv.subjective,
                "objective": nv.objective,
                "assessment": nv.assessment,
                "plan": nv.plan,
                "diagnoses": [f"{c} {d}" for c, d in codes],
            }
        )
    return {"status": "ok", "prior_encounter_count": len(prior), "prior_encounters": prior}


async def _search_icd10(db: AsyncSession, query_text: str) -> dict:
    query_text = (query_text or "").strip()
    if not query_text:
        return {"status": "ok", "results": []}
    # Embedding is CPU-bound (torch) — offload so it doesn't block the event loop.
    vec = await asyncio.to_thread(embed_text, query_text)
    rows = (
        await db.execute(
            select(
                Icd10Code.code,
                Icd10Code.description,
                Icd10Code.embedding.cosine_distance(vec).label("d"),
            )
            .order_by("d")
            .limit(ICD_TOPK)
        )
    ).all()
    return {
        "status": "ok",
        "results": [{"code": c, "description": d} for c, d, _ in rows],
    }


async def _dispatch(name: str, args: dict, db: AsyncSession, patient_id: int) -> dict:
    """Run a tool. NEVER raises — failures degrade to a structured 'unavailable'."""
    try:
        if name == "get_patient_history":
            return await _get_patient_history(db, patient_id)  # ignores model args
        if name == "search_icd10":
            return await _search_icd10(db, args.get("query_text", ""))
        return {"status": "error", "detail": "unknown_function"}
    except Exception as exc:  # noqa: BLE001 - deliberately broad: tool must not crash stream
        return {"status": "unavailable", "detail": str(exc)[:200]}


def _tool_config(types):
    get_history = types.FunctionDeclaration(
        name="get_patient_history",
        description=(
            "Retrieve this patient's prior finalized encounter notes (subjective, "
            "objective, assessment, plan, and diagnoses). Call this first. Takes no "
            "arguments; the patient is determined by the current encounter."
        ),
        parameters_json_schema={"type": "object", "properties": {}},
    )
    search = types.FunctionDeclaration(
        name="search_icd10",
        description=(
            "Search the ICD-10 catalog for codes matching a plain-English condition "
            "or symptom. Returns grounded {code, description} results. Use ONLY these "
            "results when assigning codes; never invent codes."
        ),
        parameters_json_schema={
            "type": "object",
            "properties": {
                "query_text": {
                    "type": "string",
                    "description": "A condition or symptom, e.g. 'acute low back pain'.",
                }
            },
            "required": ["query_text"],
        },
    )
    return types.Tool(function_declarations=[get_history, search])


async def run_generation_stream(
    client,
    sessionmaker: async_sessionmaker[AsyncSession],
    *,
    patient_id: int,
    transcript: str,
    template_prompt: str | None,
    settings: Settings,
) -> AsyncIterator[dict]:
    """Yield event dicts: {type: meta|tool|delta|insufficient|done|error, ...}."""
    transcript = (transcript or "").strip()

    # Cheap guard: obviously empty/non-clinical input short-circuits before any
    # model call. The model also emits INSUFFICIENT for subtler gibberish.
    if len(transcript) < MIN_CLINICAL_CHARS:
        yield {"type": "insufficient"}
        yield {"type": "done"}
        return

    from google.genai import types  # lazy import

    config = types.GenerateContentConfig(
        system_instruction=build_system_instruction(template_prompt),
        tools=[_tool_config(types)],
        automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
        temperature=0.3,
    )
    contents = [types.Content(role="user", parts=[types.Part(text=transcript)])]

    produced_text = False
    completed = False
    try:
        async with sessionmaker() as db:
            for _turn in range(MAX_TURNS):
                pending = []
                model_parts = []
                stream = await client.aio.models.generate_content_stream(
                    model=settings.generation_model, contents=contents, config=config
                )
                async for chunk in stream:
                    cand = (chunk.candidates or [None])[0]
                    if not cand or not cand.content or not cand.content.parts:
                        continue
                    for part in cand.content.parts:
                        if getattr(part, "function_call", None):
                            pending.append(part.function_call)
                            model_parts.append(part)
                        elif getattr(part, "text", None):
                            model_parts.append(types.Part(text=part.text))
                            produced_text = True
                            yield {"type": "delta", "text": part.text}

                if not pending:
                    completed = True  # final text turn complete
                    break

                contents.append(types.Content(role="model", parts=model_parts))
                tool_parts = []
                for fc in pending:
                    yield {"type": "tool", "name": fc.name}
                    result = await _dispatch(fc.name, dict(fc.args or {}), db, patient_id)
                    tool_parts.append(
                        types.Part.from_function_response(name=fc.name, response=result)
                    )
                contents.append(types.Content(role="tool", parts=tool_parts))

        if completed:
            yield {"type": "done"}
        else:
            # Hit the turn cap still tool-calling — never produced the note. Treat
            # as incomplete rather than emitting a misleading empty success.
            yield {
                "type": "error",
                "message": "generation_incomplete",
                "detail": "Model exceeded the tool-call limit before producing the note.",
                "produced_text": produced_text,
            }
    except Exception as exc:  # noqa: BLE001 - terminal error event, never a crash
        yield {"type": "error", "message": "generation_failed", "detail": str(exc)[:300]}


__all__ = ["run_generation_stream", "INSUFFICIENT"]
