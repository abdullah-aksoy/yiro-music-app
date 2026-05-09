"""Discover clip comments (public, authenticated post).

Revision ID: 0014_discover_sample_comments
Revises: 0013_discover_sample_song_id
"""

import sqlalchemy as sa
from alembic import op

revision = "0014_discover_sample_comments"
down_revision = "0013_discover_sample_song_id"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "discover_sample_comments",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("sample_id", sa.Integer(), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["sample_id"], ["discover_samples.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_discover_sample_comments_sample_id", "discover_sample_comments", ["sample_id"], unique=False)
    op.create_index("ix_discover_sample_comments_created_at", "discover_sample_comments", ["created_at"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_discover_sample_comments_created_at", table_name="discover_sample_comments")
    op.drop_index("ix_discover_sample_comments_sample_id", table_name="discover_sample_comments")
    op.drop_table("discover_sample_comments")
