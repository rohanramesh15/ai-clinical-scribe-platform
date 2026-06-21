"""Provider-facing template list (active only) for the workspace dropdown.

The client holds only the template id; the body is read fresh at generation time
(M4), so an admin edit takes effect on the provider's next generation.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..deps import get_current_provider, get_session
from ..models import Provider, Template, TemplateStatus
from ..schemas import TemplateSummary

router = APIRouter(prefix="/api/templates", tags=["templates"])


@router.get("", response_model=list[TemplateSummary])
async def list_active_templates(
    _provider: Provider = Depends(get_current_provider),
    db: AsyncSession = Depends(get_session),
) -> list[TemplateSummary]:
    rows = (
        await db.execute(
            select(Template.id, Template.name, Template.encounter_type)
            .where(Template.status == TemplateStatus.active)
            .order_by(Template.name)
        )
    ).all()
    return [TemplateSummary(id=i, name=n, encounter_type=t) for i, n, t in rows]
