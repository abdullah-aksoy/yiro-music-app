import logging
import smtplib
from email.message import EmailMessage

import httpx

from app.config import get_settings

logger = logging.getLogger(__name__)

_RESEND_API = "https://api.resend.com/emails"


def _normalize_resend_from_address(raw: str) -> str:
    """Strip accidental newlines/spaces from env vars (e.g. Railway paste of 'onboarding@\\nresend.dev')."""
    s = "".join((raw or "").split())
    if not s or "@" not in s:
        raise RuntimeError("Invalid Resend From address; set RESEND_FROM_EMAIL (e.g. onboarding@resend.dev).")
    _local, _, domain = s.partition("@")
    if not domain or "." not in domain:
        raise RuntimeError(
            "Resend From address looks incomplete (e.g. 'onboarding@' without domain). "
            "Use RESEND_FROM_EMAIL=onboarding@resend.dev or your verified domain address."
        )
    return s


def _reset_email_content(*, reset_link: str) -> tuple[str, str]:
    subject = "Password reset request"
    body = (
        "You requested a password reset.\n\n"
        f"Open this link to reset your password:\n{reset_link}\n\n"
        "If you did not request this, you can ignore this message."
    )
    return subject, body


def _send_via_resend(*, to_email: str, reset_link: str) -> None:
    settings = get_settings()
    key = settings.resend_api_key.strip()
    if not key:
        raise RuntimeError("Resend API key is missing.")
    raw_from = (settings.resend_from_email or settings.smtp_from_email).strip()
    from_addr = _normalize_resend_from_address(raw_from)

    subject, text_body = _reset_email_content(reset_link=reset_link)
    with httpx.Client(timeout=30.0) as client:
        response = client.post(
            _RESEND_API,
            headers={
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
            },
            json={
                "from": from_addr,
                "to": [to_email],
                "subject": subject,
                "text": text_body,
            },
        )
    try:
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        logger.error(
            "Resend API error status=%s body=%s",
            response.status_code,
            response.text[:500],
        )
        raise RuntimeError("Resend API rejected the request") from exc


def _send_via_smtp(*, to_email: str, reset_link: str) -> None:
    settings = get_settings()
    if not settings.smtp_host or not settings.smtp_from_email:
        raise RuntimeError("SMTP is not configured.")

    subject, body = _reset_email_content(reset_link=reset_link)

    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = settings.smtp_from_email
    message["To"] = to_email
    message.set_content(body)

    with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=15) as server:
        if settings.smtp_use_tls:
            server.starttls()
        if settings.smtp_user:
            server.login(settings.smtp_user, settings.smtp_password)
        server.send_message(message)


def send_password_reset_email(*, to_email: str, reset_link: str) -> None:
    """Prefer Resend (HTTPS) when RESEND_API_KEY is set — works on Railway where SMTP is blocked."""
    settings = get_settings()
    if settings.resend_api_key.strip():
        _send_via_resend(to_email=to_email, reset_link=reset_link)
        return
    if settings.smtp_host and settings.smtp_from_email:
        _send_via_smtp(to_email=to_email, reset_link=reset_link)
        return
    raise RuntimeError("No email transport configured (set RESEND_API_KEY or SMTP_*).")
