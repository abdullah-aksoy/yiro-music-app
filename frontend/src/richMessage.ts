/** Hostnames allowed for inline GIF/sticker images (keep in sync with app/utils/safe_media_url.py). */

const ALLOWED_HOST_SUFFIXES = [
  "giphy.com",
  "tenor.com",
  "discordapp.com",
  "discordapp.net",
  "discord.com",
];

export function isTrustedStickerUrl(raw: string): boolean {
  const s = String(raw || "").trim();
  if (!s || s.length > 2048) {
    return false;
  }
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") {
    return false;
  }
  const host = u.hostname.toLowerCase();
  return ALLOWED_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/** Renders text with line breaks; whole lines that are trusted HTTPS GIF/image URLs become <img>. */
export function appendRichMessageContent(container: HTMLElement, text: string) {
  const lines = String(text || "").split("\n");
  lines.forEach((line, i) => {
    if (i > 0) {
      container.appendChild(document.createElement("br"));
    }
    const t = line.trim();
    if (!t) {
      return;
    }
    if (isTrustedStickerUrl(t)) {
      const wrap = document.createElement("span");
      wrap.className = "rich-msg-sticker-wrap";
      const img = document.createElement("img");
      img.className = "rich-msg-sticker";
      img.src = t;
      img.alt = "GIF";
      img.loading = "lazy";
      img.referrerPolicy = "no-referrer";
      wrap.appendChild(img);
      container.appendChild(wrap);
    } else {
      const span = document.createElement("span");
      span.className = "rich-msg-text-line";
      span.textContent = line;
      container.appendChild(span);
    }
  });
}
