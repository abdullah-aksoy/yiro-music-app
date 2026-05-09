/**
 * Client-side URL safety: API base, deep links, media src, Listen Together join ids.
 */

const API_BASE_MAX_LEN = 512;

/** Sync session id (UUID + future ids) — no slash/query chars that could break paths. */
const LISTEN_JOIN_ID_PATTERN = /^[a-zA-Z0-9_.-]{4,128}$/;

const DANGEROUS_URL_SCHEME = /^\s*(javascript|data:text\/html|vbscript|file):/i;

export function normalizeApiBaseUrl(raw: unknown): string | null {
  let s = String(raw ?? "").trim();
  if (!s) {
    return null;
  }
  if (s.length > API_BASE_MAX_LEN || /[\s\r\n\x00-\x1f]/.test(s)) {
    return null;
  }
  if (DANGEROUS_URL_SCHEME.test(s)) {
    return null;
  }
  let candidate = s.replace(/\/+$/, "");
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(candidate)) {
    candidate = `https://${candidate}`;
  }
  let u: URL;
  try {
    u = new URL(candidate);
  } catch {
    return null;
  }
  if (u.username || u.password) {
    return null;
  }
  const proto = u.protocol.toLowerCase();
  const path = u.pathname.replace(/\/+$/, "") || "";
  const base = `${u.origin}${path}`;

  if (proto === "https:") {
    if (!u.hostname) {
      return null;
    }
    return base;
  }
  if (proto === "http:") {
    const h = u.hostname.toLowerCase();
    if (h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".localhost")) {
      return base;
    }
    return null;
  }
  return null;
}

/** Absolute URL allowed as video/audio/image src (Discover HLS/MP4, remote artwork). */
export function isSafeHttpMediaUrl(raw: unknown): boolean {
  const s = String(raw ?? "").trim();
  if (!s || DANGEROUS_URL_SCHEME.test(s)) {
    return false;
  }
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  const proto = u.protocol.toLowerCase();
  if (proto === "https:") {
    return Boolean(u.hostname);
  }
  if (proto === "http:") {
    const h = u.hostname.toLowerCase();
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".localhost");
  }
  return false;
}

export function isSafeArtworkUrl(raw: unknown): boolean {
  const s = String(raw ?? "").trim();
  if (!s) {
    return false;
  }
  if (DANGEROUS_URL_SCHEME.test(s)) {
    return false;
  }
  if (/^blob:/i.test(s)) {
    return true;
  }
  if (/^data:image\//i.test(s)) {
    return s.length <= 500_000;
  }
  return isSafeHttpMediaUrl(s);
}

export function sanitizeListenTogetherJoinId(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s || !LISTEN_JOIN_ID_PATTERN.test(s)) {
    return null;
  }
  return s;
}

/** Positive integer for #song/, #playlist/, #album/ (no leading zeros, bounded). */
export function sanitizeShareNumericId(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!/^[1-9]\d{0,14}$/.test(s)) {
    return null;
  }
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < 1) {
    return null;
  }
  return s;
}

/** Username segment for #user/ (backend allows 3–50 chars; block control chars and hash/path separators). */
export function normalizeUsernameForShare(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (s.length < 3 || s.length > 50) {
    return null;
  }
  if (/[\u0000-\u001f\u007f]/.test(s) || /[#/?]/.test(s)) {
    return null;
  }
  return s;
}

export type DeepLinkKind = "song" | "playlist" | "artist" | "user" | "album" | "discover";

/**
 * Parse #type/id deep links. Discover: `#discover/123` opens clip 123 (numeric id, same rules as #song/).
 */
export function parseDeepLinkHash(hashWithoutPound: string): { kind: DeepLinkKind; rawId: string } | null {
  const h = String(hashWithoutPound || "").trim();
  if (!h || h.includes("reset_token=")) {
    return null;
  }
  const slash = h.indexOf("/");
  if (slash <= 0) {
    return null;
  }
  const kind = h.slice(0, slash);
  const rawId = h.slice(slash + 1);
  if (!rawId) {
    return null;
  }
  const allowed = new Set(["song", "playlist", "artist", "user", "album", "discover"]);
  if (!allowed.has(kind)) {
    return null;
  }
  if (kind === "song" || kind === "playlist" || kind === "album" || kind === "discover") {
    const sid = sanitizeShareNumericId(rawId);
    if (!sid) {
      return null;
    }
    return { kind: kind as DeepLinkKind, rawId: sid };
  }
  if (rawId.length > 4000) {
    return null;
  }
  return { kind: kind as DeepLinkKind, rawId };
}
