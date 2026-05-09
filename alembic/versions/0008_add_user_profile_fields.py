"""add user profile fields

Revision ID: 0008_user_profile_fields
Revises: 0007_password_reset_tokens
Create Date: 2026-03-09 23:00:00
"""

from alembic import op
import sqlalchemy as sa


revision = "0008_user_profile_fields"
down_revision = "0007_password_reset_tokens"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("avatar_url", sa.Text(), nullable=True))
    op.add_column("users", sa.Column("bio", sa.String(length=1000), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "bio")
    op.drop_column("users", "avatar_url")
