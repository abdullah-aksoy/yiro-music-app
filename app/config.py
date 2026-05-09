from functools import lru_cache
from pathlib import Path
from urllib.parse import urlparse

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


PROJECT_ROOT = Path(__file__).resolve().parents[1]


class Settings(BaseSettings):
    app_name: str = "Spotify Backend API"
    api_prefix: str = "/api"
    debug: bool = False
    secret_key: str
    algorithm: str = "HS256"
    access_token_expire_minutes: int = 1440
    database_url: str
    redis_url: str | None = None
    # Parallel UI refresh opens many concurrent DB sessions; defaults were too low for burst load.
    db_pool_size: int = 15
    db_max_overflow: int = 25
    db_pool_recycle: int = 1800
    db_pool_pre_ping: bool = True
    search_redis_ttl_seconds: int = 300
    # Log lines slower than this (ms) as WARNING "slow_request". Raise in prod to reduce noise.
    slow_request_ms: int = 500

    itunes_base_url: str = "https://itunes.apple.com"
    itunes_country: str = "tr"
    music_dir: str = "music"
    allow_stream_query_token: bool = True
    ui_base_url: str = "https://yiro.aaksoy.com"
    # Discover clips: DISCOVER_VIDEO_BASE_URL (e.g. https://aksoyshop.com or https://cdn.example.com/videos).
    # Empty => same-origin /ui/videos/<file> from app/static/videos/.
    discover_video_base_url: str = ""
    # Comma-separated extra browser origins for CORS (e.g. https://preview--app.netlify.app).
    cors_extra_origins: str = ""
    # Allow any https://*.netlify.app origin (deploy previews). Set false to lock to explicit origins only.
    cors_allow_netlify_previews: bool = True
    password_reset_expire_minutes: int = 30
    # Password reset on Railway: use HTTPS email (Resend). Outbound SMTP is often blocked (ENETUNREACH).
    resend_api_key: str = ""
    # Verified sender in Resend (e.g. onboarding@resend.dev or your domain). Falls back to SMTP_FROM_EMAIL.
    resend_from_email: str = ""
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_from_email: str = ""
    smtp_use_tls: bool = True

    model_config = SettingsConfigDict(
        env_file=str(PROJECT_ROOT / ".env"),
        env_file_encoding="utf-8",
    )

    @model_validator(mode="after")
    def validate_security_defaults(self) -> "Settings":
        insecure = {
            "change-this-secret-key",
            "replace-with-strong-secret-key",
            "dev-secret-key",
            "CHANGE_ME_TO_A_LONG_RANDOM_SECRET_KEY",
        }
        if not self.secret_key:
            raise ValueError("SECRET_KEY must be provided")
        if not self.database_url:
            raise ValueError("DATABASE_URL must be provided")
        if not self.debug and self.secret_key in insecure:
            raise ValueError("SECRET_KEY must be set to a strong value when DEBUG is false")
        if self.smtp_host and not self.smtp_from_email:
            raise ValueError("SMTP_FROM_EMAIL must be provided when SMTP_HOST is set")
        has_smtp_user = bool(self.smtp_user.strip())
        has_smtp_password = bool(self.smtp_password.strip())
        if has_smtp_user ^ has_smtp_password:
            raise ValueError("SMTP_USER and SMTP_PASSWORD must be provided together")
        if self.resend_api_key.strip() and not (
            self.resend_from_email.strip() or self.smtp_from_email.strip()
        ):
            raise ValueError(
                "RESEND_FROM_EMAIL or SMTP_FROM_EMAIL is required when RESEND_API_KEY is set"
            )
        return self

    def cors_allowed_origins(self) -> list[str]:
        origins: list[str] = [
            "http://localhost:8010",
            "http://127.0.0.1:8010",
        ]
        parsed = urlparse(self.ui_base_url.strip())
        if parsed.scheme and parsed.netloc:
            origins.append(f"{parsed.scheme}://{parsed.netloc}")
            if parsed.scheme == "https":
                origins.append(f"http://{parsed.netloc}")
        else:
            origins.append(self.ui_base_url.rstrip("/"))
        for raw in self.cors_extra_origins.split(","):
            o = raw.strip()
            if o:
                origins.append(o)
        # Dedupe while preserving order
        seen: set[str] = set()
        out: list[str] = []
        for o in origins:
            if o not in seen:
                seen.add(o)
                out.append(o)
        return out


@lru_cache
def get_settings() -> Settings:
    return Settings()

