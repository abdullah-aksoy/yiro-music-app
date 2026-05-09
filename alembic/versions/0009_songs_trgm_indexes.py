"""Add pg_trgm GIN indexes for song title and artist search

Revision ID: 0009_songs_trgm
Revises: 43e441769f48
Create Date: 2026-03-29 00:00:00
"""

from alembic import op


revision = "0009_songs_trgm"
down_revision = "43e441769f48"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    op.create_index(
        "ix_songs_title_trgm",
        "songs",
        ["title"],
        unique=False,
        postgresql_using="gin",
        postgresql_ops={"title": "gin_trgm_ops"},
    )
    op.create_index(
        "ix_songs_artist_trgm",
        "songs",
        ["artist"],
        unique=False,
        postgresql_using="gin",
        postgresql_ops={"artist": "gin_trgm_ops"},
    )


def downgrade() -> None:
    op.drop_index("ix_songs_artist_trgm", table_name="songs")
    op.drop_index("ix_songs_title_trgm", table_name="songs")
