"""Discover comment replies (parent_id self-FK).

Revision ID: 0015_discover_comment_parent_id
Revises: 0014_discover_sample_comments
"""

import sqlalchemy as sa
from alembic import op

revision = "0015_discover_comment_parent_id"
down_revision = "0014_discover_sample_comments"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "discover_sample_comments",
        sa.Column("parent_id", sa.Integer(), nullable=True),
    )
    op.create_index(
        "ix_discover_sample_comments_parent_id",
        "discover_sample_comments",
        ["parent_id"],
        unique=False,
    )
    op.create_foreign_key(
        "fk_discover_sample_comments_parent_id",
        "discover_sample_comments",
        "discover_sample_comments",
        ["parent_id"],
        ["id"],
        ondelete="CASCADE",
    )


def downgrade() -> None:
    op.drop_constraint("fk_discover_sample_comments_parent_id", "discover_sample_comments", type_="foreignkey")
    op.drop_index("ix_discover_sample_comments_parent_id", table_name="discover_sample_comments")
    op.drop_column("discover_sample_comments", "parent_id")
