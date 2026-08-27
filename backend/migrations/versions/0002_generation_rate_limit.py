"""per-provider, per-ip daily generation rate limit

Revision ID: 0002_generation_rate_limit
Revises: 0001_initial
Create Date: 2026-08-27

Adds providers.max_generations_per_ip_per_day (nullable; NULL = unlimited,
the default for every existing/new account) and generation_rate_limits, a
(provider_id, ip, day) counter table checked only when that column is set.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0002_generation_rate_limit"
down_revision: Union[str, None] = "0001_initial"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TS = sa.DateTime(timezone=True)
NOW = sa.text("now()")


def _id() -> sa.Column:
    return sa.Column("id", sa.BigInteger, sa.Identity(), primary_key=True)


def upgrade() -> None:
    op.add_column(
        "providers",
        sa.Column("max_generations_per_ip_per_day", sa.Integer, nullable=True),
    )

    op.create_table(
        "generation_rate_limits",
        _id(),
        sa.Column("provider_id", sa.BigInteger, sa.ForeignKey("providers.id"), nullable=False),
        sa.Column("ip", sa.Text, nullable=False),
        sa.Column("day", sa.Date, nullable=False),
        sa.Column("count", sa.Integer, nullable=False, server_default="0"),
        sa.Column("created_at", TS, nullable=False, server_default=NOW),
        sa.Column("updated_at", TS, nullable=False, server_default=NOW),
        sa.UniqueConstraint("provider_id", "ip", "day", name="uq_gen_rate_limit_provider_ip_day"),
    )


def downgrade() -> None:
    op.drop_table("generation_rate_limits")
    op.drop_column("providers", "max_generations_per_ip_per_day")
