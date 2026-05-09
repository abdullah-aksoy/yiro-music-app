"""Discover sample videos (Reels) + likes/saves.

Revision ID: 0012_discover_samples
Revises: 0011_history_perf_idx
Create Date: 2026-04-02
"""

import sqlalchemy as sa
from alembic import op

revision = "0012_discover_samples"
down_revision = "0011_history_perf_idx"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "discover_samples",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("artist_name", sa.String(length=255), nullable=False),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("video_url", sa.Text(), nullable=False),
        sa.Column("itunes_track_id", sa.BigInteger(), nullable=True),
        sa.Column("sort_order", sa.Integer(), server_default="0", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_discover_samples_artist_sort", "discover_samples", ["artist_name", "sort_order"], unique=False)

    op.create_table(
        "discover_sample_likes",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("sample_id", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["sample_id"], ["discover_samples.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "sample_id", name="uq_discover_like_user_sample"),
    )
    op.create_index("ix_discover_sample_likes_sample_id", "discover_sample_likes", ["sample_id"], unique=False)

    op.create_table(
        "discover_sample_saves",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("sample_id", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["sample_id"], ["discover_samples.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "sample_id", name="uq_discover_save_user_sample"),
    )
    op.create_index("ix_discover_sample_saves_sample_id", "discover_sample_saves", ["sample_id"], unique=False)

    base = "https://aksoyshop.com"
    discover_samples = sa.table(
        "discover_samples",
        sa.column("id", sa.Integer),
        sa.column("artist_name", sa.String),
        sa.column("title", sa.String),
        sa.column("video_url", sa.Text),
        sa.column("itunes_track_id", sa.BigInteger),
        sa.column("sort_order", sa.Integer),
    )
    op.bulk_insert(
        discover_samples,
        [
            {"id": 1, "artist_name": "Manifest", "title": "Amatör", "video_url": f"{base}/manifest-amator.mp4", "itunes_track_id": None, "sort_order": 0},
            {"id": 2, "artist_name": "Manifest", "title": "Arıyo", "video_url": f"{base}/manifest-ariyo.mp4", "itunes_track_id": None, "sort_order": 1},
            {"id": 3, "artist_name": "Manifest", "title": "Başrol Sensin", "video_url": f"{base}/manifest-basrol-sensin.mp4", "itunes_track_id": None, "sort_order": 2},
            {"id": 4, "artist_name": "Manifest", "title": "KTS", "video_url": f"{base}/manifest-kts.mp4", "itunes_track_id": None, "sort_order": 3},
            {"id": 5, "artist_name": "Manifest", "title": "Rüya", "video_url": f"{base}/manifest-ruya.mp4", "itunes_track_id": None, "sort_order": 4},
            {"id": 6, "artist_name": "Manifest", "title": "Snap", "video_url": f"{base}/manifest-snap.mp4", "itunes_track_id": None, "sort_order": 5},
            {"id": 7, "artist_name": "Manifest", "title": "Yaşanacaksa", "video_url": f"{base}/manifest-yasanacaksa.mp4", "itunes_track_id": None, "sort_order": 6},
        ],
    )

    op.execute(sa.text("SELECT setval(pg_get_serial_sequence('discover_samples', 'id'), (SELECT MAX(id) FROM discover_samples))"))


def downgrade() -> None:
    op.drop_index("ix_discover_sample_saves_sample_id", table_name="discover_sample_saves")
    op.drop_table("discover_sample_saves")
    op.drop_index("ix_discover_sample_likes_sample_id", table_name="discover_sample_likes")
    op.drop_table("discover_sample_likes")
    op.drop_index("ix_discover_samples_artist_sort", table_name="discover_samples")
    op.drop_table("discover_samples")
