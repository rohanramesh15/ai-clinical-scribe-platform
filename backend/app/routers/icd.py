"""Standalone ICD-10 semantic search widget (provider workspace).

Plain-English symptom/condition -> embed query (local MiniLM) -> pgvector cosine
nearest-neighbour over the HNSW index -> top-k {code, description, score}. No
external ICD-10 API. Clicking a result in the UI appends it to the open note's
Assessment and is saved as a `provider_added` diagnosis (M5 save path).
"""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..deps import get_current_provider, get_session
from ..embeddings import embed_text
from ..models import Icd10Code, Provider
from ..schemas import IcdSearchResult

router = APIRouter(prefix="/api/icd10", tags=["icd10"])


@router.get("/search", response_model=list[IcdSearchResult])
async def search_icd10(
    q: str = Query(min_length=1, max_length=200),
    limit: int = Query(default=10, ge=1, le=25),
    _provider: Provider = Depends(get_current_provider),
    db: AsyncSession = Depends(get_session),
) -> list[IcdSearchResult]:
    # Embedding is CPU-bound — offload off the event loop.
    vec = await asyncio.to_thread(embed_text, q.strip())
    distance = Icd10Code.embedding.cosine_distance(vec)
    rows = (
        await db.execute(
            select(Icd10Code.code, Icd10Code.description, distance.label("d"))
            .order_by("d")
            .limit(limit)
        )
    ).all()
    return [
        IcdSearchResult(code=code, description=desc, score=round(1.0 - float(d), 4))
        for code, desc, d in rows
    ]
