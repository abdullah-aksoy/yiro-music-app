/**
 * Discover / full-player: optional HLS when hls_url is set, else progressive MP4.
 * Neighbor prefetch: hidden videos buffer upcoming reels while the current one plays (HTTP cache).
 */

import type Hls from "hls.js";

export type DiscoverMediaSlot = "reel" | "overlay" | "fpPrimary";

const instances: Partial<Record<DiscoverMediaSlot, Hls>> = {};

/** Off-DOM warm buffers for MP4 URLs (FIFO cap). */
const warmVideos = new Map<string, HTMLVideoElement>();
const WARM_MAX = 2;

function destroyHls(slot: DiscoverMediaSlot) {
  const h = instances[slot];
  if (h) {
    try {
      h.destroy();
    } catch {
      /* ignore */
    }
    delete instances[slot];
  }
}

export function teardownDiscoverMedia(slot: DiscoverMediaSlot) {
  destroyHls(slot);
}

export function teardownAllDiscoverMedia() {
  (["reel", "overlay", "fpPrimary"] as const).forEach(teardownDiscoverMedia);
}

export function clearDiscoverWarmCache(): void {
  for (const v of warmVideos.values()) {
    try {
      v.pause();
      v.removeAttribute("src");
      v.load();
    } catch {
      /* ignore */
    }
    try {
      v.remove();
    } catch {
      /* ignore */
    }
  }
  warmVideos.clear();
}

/**
 * Start loading neighbor clips in the background (MP4 only). Uses browser cache so the real reel `<video>` starts faster.
 */
export function warmDiscoverNeighboringClips(urls: (string | null | undefined)[]): void {
  for (const raw of urls) {
    const u = String(raw || "").trim();
    if (!u || warmVideos.has(u)) {
      continue;
    }
    if (/\.m3u8(\?|$)/i.test(u)) {
      continue;
    }
    while (warmVideos.size >= WARM_MAX) {
      const first = warmVideos.keys().next().value as string | undefined;
      if (first == null) {
        break;
      }
      const old = warmVideos.get(first);
      warmVideos.delete(first);
      if (old) {
        try {
          old.pause();
          old.removeAttribute("src");
          old.load();
        } catch {
          /* ignore */
        }
        try {
          old.remove();
        } catch {
          /* ignore */
        }
      }
    }
    const v = document.createElement("video");
    v.preload = "auto";
    v.muted = true;
    v.playsInline = true;
    v.setAttribute("playsinline", "");
    v.setAttribute("aria-hidden", "true");
    v.tabIndex = -1;
    v.style.cssText =
      "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;visibility:hidden";
    v.src = u;
    try {
      v.load();
    } catch {
      /* ignore */
    }
    document.body.appendChild(v);
    warmVideos.set(u, v);
  }
}

const HLS_OPTS = {
  maxBufferLength: 8,
  maxMaxBufferLength: 20,
  startFragPrefetch: true,
  capLevelToPlayerSize: true,
};

/**
 * Load HLS master URL if provided and supported; otherwise set MP4 src on video.
 */
export async function loadDiscoverMedia(
  slot: DiscoverMediaSlot,
  video: HTMLVideoElement,
  mp4Url: string,
  hlsUrl: string | null | undefined,
): Promise<void> {
  destroyHls(slot);
  video.pause();
  video.removeAttribute("src");
  try {
    video.load();
  } catch {
    /* ignore */
  }

  const hlsSrc = hlsUrl != null ? String(hlsUrl).trim() : "";
  if (hlsSrc) {
    const { default: HlsCtor } = await import("hls.js");
    if (HlsCtor.isSupported()) {
      const hls = new HlsCtor(HLS_OPTS);
      instances[slot] = hls;
      hls.loadSource(hlsSrc);
      hls.attachMedia(video);
      return;
    }
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = hlsSrc;
      try {
        video.load();
      } catch {
        /* ignore */
      }
      return;
    }
  }

  const mp4 = String(mp4Url || "").trim();
  if (!mp4) {
    return;
  }
  video.src = mp4;
  try {
    video.load();
  } catch {
    /* ignore */
  }
}
