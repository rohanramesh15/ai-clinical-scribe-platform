"""Generation pipeline tests.

The function-calling loop is exercised with a SCRIPTED FAKE client (no Gemini
call), so these run offline. The ICD tool is tested against the real seeded DB.
"""
import pytest

from app.config import get_settings
from app.services import generation as gen


# --- Fake google-genai client that replays scripted turns ----------------

async def _aiter(items):
    for it in items:
        yield it


class _FakeModels:
    def __init__(self, turns):
        self.turns = turns
        self.calls = 0

    async def generate_content_stream(self, model, contents, config):
        chunks = self.turns[self.calls]
        self.calls += 1
        return _aiter(chunks)


class _FakeAio:
    def __init__(self, turns):
        self.models = _FakeModels(turns)


class _FakeClient:
    def __init__(self, turns):
        self.aio = _FakeAio(turns)


def _chunk(parts):
    from google.genai import types

    cand = types.Candidate(content=types.Content(role="model", parts=parts))
    return types.GenerateContentResponse(candidates=[cand])


async def _collect(agen):
    return [e async for e in agen]


@pytest.mark.asyncio
async def test_insufficient_short_circuit(sessionmaker):
    # Tiny input never calls the model (client unused), emits insufficient+done.
    events = await _collect(
        gen.run_generation_stream(
            client=None,
            sessionmaker=sessionmaker,
            patient_id=1,
            transcript="hi",
            template_prompt=None,
            settings=get_settings(),
        )
    )
    assert [e["type"] for e in events] == ["insufficient", "done"]


@pytest.mark.asyncio
async def test_search_icd10_tool_is_grounded(sessionmaker):
    async with sessionmaker() as db:
        result = await gen._search_icd10(db, "chest pain")
    assert result["status"] == "ok"
    assert result["results"], "expected ICD matches"
    # Every returned code is a real catalog entry (string codes, non-empty desc).
    for r in result["results"]:
        assert r["code"] and r["description"]


@pytest.mark.asyncio
async def test_loop_dispatches_tool_then_streams_text(sessionmaker):
    from google.genai import types

    # Turn 1: model asks for search_icd10. Turn 2: model emits note text.
    turn1 = [
        _chunk([
            types.Part(function_call=types.FunctionCall(name="search_icd10", args={"query_text": "cough"}))
        ])
    ]
    turn2 = [_chunk([types.Part(text="‹SUBJECTIVE›cough x3d‹/SUBJECTIVE›")])]
    client = _FakeClient([turn1, turn2])

    events = await _collect(
        gen.run_generation_stream(
            client=client,
            sessionmaker=sessionmaker,
            patient_id=1,
            transcript="Patient reports a productive cough for three days with low fever.",
            template_prompt=None,
            settings=get_settings(),
        )
    )
    types_seen = [e["type"] for e in events]
    assert "tool" in types_seen
    assert any(e["type"] == "tool" and e["name"] == "search_icd10" for e in events)
    deltas = "".join(e["text"] for e in events if e["type"] == "delta")
    assert "SUBJECTIVE" in deltas
    assert types_seen[-1] == "done"
