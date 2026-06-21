"""Local sentence-transformers embeddings (MiniLM, 384-dim).

Used at seed time to embed every ICD-10 description, and at runtime to embed a
provider's plain-English ICD search query. No external API — the model runs in
process. The model is loaded once and cached.

Embeddings are L2-normalized so cosine distance (pgvector `vector_cosine_ops`)
behaves well for nearest-neighbour ranking.
"""
from __future__ import annotations

from functools import lru_cache

from .config import get_settings


@lru_cache(maxsize=1)
def _get_model():
    # Imported lazily so the heavy torch import only happens when embeddings are
    # actually needed (seed, ICD search), not on every app import.
    from sentence_transformers import SentenceTransformer

    return SentenceTransformer(get_settings().embedding_model)


def embed_texts(texts: list[str]) -> list[list[float]]:
    model = _get_model()
    vectors = model.encode(texts, normalize_embeddings=True, convert_to_numpy=True)
    return [v.tolist() for v in vectors]


def embed_text(text: str) -> list[float]:
    return embed_texts([text])[0]
