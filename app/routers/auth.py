import hashlib
import logging
import secrets
from datetime import datetime, timedelta, timezone
from urllib.parse import quote
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.password_reset import PasswordResetToken
from app.models.user import User
from app.schemas.auth import (
    ForgotPasswordIn,
    OAuth2TokenRequest,
    ResetPasswordIn,
    Token,
    UserCreate,
    UserLogin,
    UserOut,
    UserUpdate,
)
from app.services.mailer import send_password_reset_email
from app.config import get_settings
from app.utils.auth import create_access_token, get_password_hash, verify_password
from app.utils.cache import cache_response, invalidate_user_endpoint_cache
from app.utils.deps import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])
settings = get_settings()
_AUTH_MOD = "app.routers.auth"


@router.post(
    "/register",
    response_model=UserOut,
    status_code=status.HTTP_201_CREATED,
    summary="Register user",
    description="Creates a new user account. (Yeni kullanici hesabi olusturur.)",
)
async def register(
    payload: Annotated[UserCreate, Depends(UserCreate.as_form)],
    db: AsyncSession = Depends(get_db),
) -> User:
    email_key = str(payload.email).strip().lower()
    exists = await db.scalar(
        select(User).where(or_(func.lower(User.email) == email_key, User.username == payload.username))
    )
    if exists:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="User already exists")

    user = User(
        username=payload.username,
        email=payload.email,
        hashed_password=get_password_hash(payload.password),
    )
    db.add(user)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="User already exists")
    await db.refresh(user)
    return user


@router.post(
    "/login",
    response_model=Token,
    summary="Login",
    description="Authenticates with email and password. (Email ve sifre ile giris yapar.)",
)
async def login(payload: Annotated[UserLogin, Depends(UserLogin.as_form)], db: AsyncSession = Depends(get_db)) -> Token:
    email_key = str(payload.email).strip().lower()
    user = await db.scalar(select(User).where(func.lower(User.email) == email_key))
    if not user or not verify_password(payload.password, user.hashed_password):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")
    return Token(access_token=create_access_token(str(user.id)))


@router.post(
    "/token",
    response_model=Token,
    summary="Get OAuth2 token",
    description="Returns access token with OAuth2 form data. (OAuth2 form verisi ile token verir.)",
)
async def login_with_form(
    form_data: Annotated[OAuth2TokenRequest, Depends(OAuth2TokenRequest.as_form)],
    db: AsyncSession = Depends(get_db),
) -> Token:
    email_key = str(form_data.username).strip().lower()
    user = await db.scalar(select(User).where(func.lower(User.email) == email_key))
    if not user or not verify_password(form_data.password, user.hashed_password):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")
    return Token(access_token=create_access_token(str(user.id)))


@router.post(
    "/forgot-password",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Request password reset",
    description="Sends a password reset email if account exists.",
)
async def forgot_password(
    payload: Annotated[ForgotPasswordIn, Depends(ForgotPasswordIn.as_form)],
    db: AsyncSession = Depends(get_db),
) -> dict[str, str]:
    email_key = str(payload.email).strip().lower()
    user = await db.scalar(select(User).where(func.lower(User.email) == email_key))
    if not user:
        return {"message": "If this email exists, reset instructions were sent."}

    # Snapshot before SMTP/DB ops: after rollback, ORM lazy-load on user.email can raise.
    reset_to_email = user.email

    raw_token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(minutes=settings.password_reset_expire_minutes)

    await db.execute(
        update(PasswordResetToken)
        .where(PasswordResetToken.user_id == user.id, PasswordResetToken.used_at.is_(None))
        .values(used_at=now)
    )
    db.add(
        PasswordResetToken(
            user_id=user.id,
            token_hash=token_hash,
            expires_at=expires_at,
        )
    )
    # Fragment avoids sending the token in the initial HTTP request path/query (server/access logs, Referer).
    base = settings.ui_base_url.rstrip("/")
    reset_link = f"{base}/#reset_token={quote(raw_token, safe='')}"
    try:
        await db.flush()
        send_password_reset_email(to_email=reset_to_email, reset_link=reset_link)
        await db.commit()
    except Exception as exc:
        await db.rollback()
        logger.exception("forgot-password email failed to=%s", reset_to_email)
        if isinstance(exc, OSError) and getattr(exc, "errno", None) == 101:
            logger.error(
                "SMTP connect failed with ENETUNREACH; many hosts (e.g. Railway) block outbound SMTP. "
                "Use an HTTPS email API (Resend, SendGrid, etc.) or a provider-specific relay."
            )
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Email service unavailable") from exc

    return {"message": "If this email exists, reset instructions were sent."}


@router.post(
    "/reset-password",
    summary="Reset password by token",
    description="Resets account password via valid reset token.",
)
async def reset_password(
    payload: Annotated[ResetPasswordIn, Depends(ResetPasswordIn.as_form)],
    db: AsyncSession = Depends(get_db),
) -> dict[str, str]:
    token_hash = hashlib.sha256(payload.token.encode("utf-8")).hexdigest()
    now = datetime.now(timezone.utc)
    consume_res = await db.execute(
        update(PasswordResetToken)
        .where(
            PasswordResetToken.token_hash == token_hash,
            PasswordResetToken.used_at.is_(None),
            PasswordResetToken.expires_at > now,
        )
        .values(used_at=now)
        .returning(PasswordResetToken.user_id)
    )
    consumed_user_id = consume_res.scalar_one_or_none()
    if not consumed_user_id:
        await db.rollback()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or expired reset token")

    new_hash = get_password_hash(payload.new_password)
    pwd_res = await db.execute(
        update(User).where(User.id == consumed_user_id).values(hashed_password=new_hash)
    )
    if pwd_res.rowcount != 1:
        await db.rollback()
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    await db.execute(
        update(PasswordResetToken)
        .where(
            PasswordResetToken.user_id == consumed_user_id,
            PasswordResetToken.used_at.is_(None),
        )
        .values(used_at=now)
    )
    await db.commit()
    return {"message": "Password reset successful"}


@router.get(
    "/me",
    response_model=UserOut,
    summary="Current user",
    description="Returns current authenticated user. (Giris yapmis kullaniciyi dondurur.)",
)
@cache_response("auth_me", ttl=60)
async def me(current_user: User = Depends(get_current_user)) -> UserOut:
    return UserOut.model_validate(current_user)


@router.patch(
    "/me",
    response_model=UserOut,
    summary="Update current user",
    description="Updates current user's profile fields. (Gecerli kullanicinin profil alanlarini gunceller.)",
)
async def update_me(
    payload: UserUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> User:
    data = payload.model_dump(exclude_unset=True)
    if not data:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No fields to update")

    if "username" in data:
        existing_username = await db.scalar(
            select(User).where(User.username == data["username"], User.id != current_user.id)
        )
        if existing_username:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Username already in use")
        current_user.username = data["username"]

    if "email" in data:
        existing_email = await db.scalar(select(User).where(User.email == data["email"], User.id != current_user.id))
        if existing_email:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email already in use")
        current_user.email = data["email"]

    if "avatar_url" in data:
        current_user.avatar_url = data["avatar_url"]

    if "bio" in data:
        current_user.bio = data["bio"]

    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Profile update conflicts with existing user") from exc

    await db.refresh(current_user)
    await invalidate_user_endpoint_cache(
        current_user.id,
        key_prefix="auth_me",
        module=_AUTH_MOD,
        function_name="me",
    )
    return current_user

