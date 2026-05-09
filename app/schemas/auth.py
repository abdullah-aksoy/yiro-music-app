from datetime import datetime
from urllib.parse import urlparse

from fastapi import Form
from pydantic import BaseModel, EmailStr, Field, field_validator

from app.utils.input_limits import EMAIL_INPUT_MAX, OAUTH2_CLIENT_FIELD_MAX


class UserCreate(BaseModel):
    username: str = Field(min_length=3, max_length=50, examples=["abdullah"])
    email: EmailStr = Field(examples=["abdullah@example.com"])
    password: str = Field(min_length=6, max_length=128, examples=["test1234"])

    @classmethod
    def as_form(
        cls,
        username: str = Form(
            ...,
            min_length=3,
            max_length=50,
            examples=["abdullah"],
            description="Username. (Kullanici adi.)",
        ),
        email: str = Form(
            ...,
            max_length=EMAIL_INPUT_MAX,
            examples=["abdullah@example.com"],
            description="Email address. (Email adresi.)",
        ),
        password: str = Form(
            ...,
            min_length=6,
            max_length=128,
            examples=["test1234"],
            description="Account password. (Hesap sifresi.)",
        ),
    ) -> "UserCreate":
        return cls(username=username, email=email, password=password)


class OAuth2TokenRequest(BaseModel):
    """OAuth2 password grant form; `username` holds the login email (same as UserLogin)."""

    username: str = Field(max_length=EMAIL_INPUT_MAX)
    password: str = Field(min_length=1, max_length=128)
    grant_type: str | None = None
    scope: str = Field(default="", max_length=512)
    client_id: str | None = Field(default=None, max_length=OAUTH2_CLIENT_FIELD_MAX)
    client_secret: str | None = Field(default=None, max_length=OAUTH2_CLIENT_FIELD_MAX)

    @classmethod
    def as_form(
        cls,
        username: str = Form(
            ...,
            max_length=EMAIL_INPUT_MAX,
            description="OAuth2 username (login email).",
        ),
        password: str = Form(
            ...,
            min_length=1,
            max_length=128,
            description="Account password.",
        ),
        grant_type: str | None = Form(default=None),
        scope: str = Form(default="", max_length=512),
        client_id: str | None = Form(default=None, max_length=OAUTH2_CLIENT_FIELD_MAX),
        client_secret: str | None = Form(default=None, max_length=OAUTH2_CLIENT_FIELD_MAX),
    ) -> "OAuth2TokenRequest":
        return cls(
            username=username,
            password=password,
            grant_type=grant_type,
            scope=scope,
            client_id=client_id,
            client_secret=client_secret,
        )


class UserLogin(BaseModel):
    email: EmailStr = Field(examples=["abdullah@example.com"])
    password: str = Field(min_length=6, max_length=128, examples=["test1234"])

    @classmethod
    def as_form(
        cls,
        email: str = Form(
            ...,
            max_length=EMAIL_INPUT_MAX,
            examples=["abdullah@example.com"],
            description="Login email. (Giris email'i.)",
        ),
        password: str = Form(
            ...,
            min_length=6,
            max_length=128,
            examples=["test1234"],
            description="Login password. (Giris sifresi.)",
        ),
    ) -> "UserLogin":
        return cls(email=email, password=password)


class ForgotPasswordIn(BaseModel):
    email: EmailStr = Field(examples=["abdullah@example.com"])

    @classmethod
    def as_form(
        cls,
        email: str = Form(
            ...,
            max_length=EMAIL_INPUT_MAX,
            examples=["abdullah@example.com"],
            description="Account email. (Hesap email'i.)",
        ),
    ) -> "ForgotPasswordIn":
        return cls(email=email)


class ResetPasswordIn(BaseModel):
    token: str = Field(min_length=10, max_length=512, examples=["reset-token-value"])
    new_password: str = Field(min_length=6, max_length=128, examples=["newStrongPass123"])

    @classmethod
    def as_form(
        cls,
        token: str = Form(..., min_length=10, max_length=512, description="Password reset token."),
        new_password: str = Form(..., min_length=6, max_length=128, description="New password."),
    ) -> "ResetPasswordIn":
        return cls(token=token, new_password=new_password)


class UserOut(BaseModel):
    id: int
    username: str
    email: EmailStr
    avatar_url: str | None = None
    bio: str | None = None
    created_at: datetime

    class Config:
        from_attributes = True


class UserUpdate(BaseModel):
    username: str | None = Field(default=None, min_length=3, max_length=50, examples=["abdullah_new"])
    email: EmailStr | None = Field(default=None, examples=["abdullah_new@example.com"])
    avatar_url: str | None = Field(default=None, max_length=500_000, examples=["https://cdn.example.com/a.png"])
    bio: str | None = Field(default=None, max_length=1000, examples=["Music lover."])

    @field_validator("avatar_url")
    @classmethod
    def avatar_url_safe(cls, v: str | None) -> str | None:
        if v is None:
            return None
        s = str(v).strip()
        if not s:
            return None
        low = s.lower()
        if low.startswith("https://"):
            return s
        if low.startswith("http://"):
            host = (urlparse(s).hostname or "").lower()
            if host in ("localhost", "127.0.0.1", "[::1]"):
                return s
            raise ValueError("avatar_url must use https except on localhost")
        if low.startswith("data:image/"):
            return s
        raise ValueError("avatar_url must be https://, data:image/..., or http:// on localhost")


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"

