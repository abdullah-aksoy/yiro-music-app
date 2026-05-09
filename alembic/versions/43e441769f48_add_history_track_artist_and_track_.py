"""Add history track_artist and track_title indexes

Revision ID: 43e441769f48
Revises: 0008_user_profile_fields
Create Date: 2026-03-28 12:44:50.276989
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import text


# revision identifiers, used by Alembic.
revision = "43e441769f48"
down_revision = "0008_user_profile_fields"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Idempotent: DB may already match this revision (manual changes / partial runs).
    op.execute(text("DROP TABLE IF EXISTS playing_with_neon"))

    # NOT NULL + DEFAULT so ADD COLUMN succeeds on non-empty tables; IF NOT EXISTS skips when present.
    op.execute(
        text(
            "ALTER TABLE audio_preferences ADD COLUMN IF NOT EXISTS "
            "crossfade_sec INTEGER NOT NULL DEFAULT 0"
        )
    )
    op.execute(
        text(
            "ALTER TABLE audio_preferences ADD COLUMN IF NOT EXISTS "
            "gapless_playback BOOLEAN NOT NULL DEFAULT false"
        )
    )

    op.execute(
        text("ALTER TABLE audio_preferences DROP CONSTRAINT IF EXISTS uq_audio_preferences_user_id")
    )
    op.execute(text("DROP INDEX IF EXISTS ix_audio_preferences_user_id"))
    op.execute(
        text(
            "CREATE UNIQUE INDEX IF NOT EXISTS ix_audio_preferences_user_id "
            "ON audio_preferences (user_id)"
        )
    )

    op.execute(
        text("DROP INDEX IF EXISTS ix_listening_history_user_id_source_type_listened_at")
    )
    op.execute(
        text(
            "CREATE INDEX IF NOT EXISTS ix_listening_history_track_artist "
            "ON listening_history (track_artist)"
        )
    )
    op.execute(
        text(
            "CREATE INDEX IF NOT EXISTS ix_listening_history_track_title "
            "ON listening_history (track_title)"
        )
    )

    op.execute(text("DROP INDEX IF EXISTS ix_password_reset_tokens_expires_at"))
    op.execute(text("DROP INDEX IF EXISTS ix_password_reset_tokens_user_id"))


def downgrade() -> None:
    op.create_index(
        op.f("ix_password_reset_tokens_user_id"),
        "password_reset_tokens",
        ["user_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_password_reset_tokens_expires_at"),
        "password_reset_tokens",
        ["expires_at"],
        unique=False,
    )
    op.drop_index(op.f("ix_listening_history_track_title"), table_name="listening_history")
    op.drop_index(op.f("ix_listening_history_track_artist"), table_name="listening_history")
    op.create_index(
        op.f("ix_listening_history_user_id_source_type_listened_at"),
        "listening_history",
        ["user_id", "source_type", "listened_at"],
        unique=False,
    )
    op.drop_index(op.f("ix_audio_preferences_user_id"), table_name="audio_preferences")
    op.create_index(
        op.f("ix_audio_preferences_user_id"),
        "audio_preferences",
        ["user_id"],
        unique=False,
    )
    op.create_unique_constraint(
        op.f("uq_audio_preferences_user_id"),
        "audio_preferences",
        ["user_id"],
        postgresql_nulls_not_distinct=False,
    )
    op.drop_column("audio_preferences", "gapless_playback")
    op.drop_column("audio_preferences", "crossfade_sec")
    op.create_table(
        "playing_with_neon",
        sa.Column("id", sa.INTEGER(), autoincrement=True, nullable=False),
        sa.Column("name", sa.TEXT(), autoincrement=False, nullable=False),
        sa.Column("value", sa.REAL(), autoincrement=False, nullable=True),
        sa.PrimaryKeyConstraint("id", name=op.f("playing_with_neon_pkey")),
    )
