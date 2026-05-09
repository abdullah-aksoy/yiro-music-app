const STREAM_CACHE_NAME = "spotify-stream-cache-v1";
const META_CACHE_NAME = "spotify-stream-meta-v1";
const META_KEY = "/ui/__stream_cache_meta__";

const cachePolicy = {
  maxEntries: 1,
  maxBytes: 20 * 1024 * 1024,
};

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

function isStreamRequest(request) {
  if (request.method !== "GET") {
    return false;
  }
  const url = new URL(request.url);
  return url.pathname.includes("/api/stream/");
}

function canonicalStreamUrl(input) {
  const url = new URL(input, self.location.origin);
  url.searchParams.delete("token");
  return url.toString();
}

async function readMeta() {
  const cache = await caches.open(META_CACHE_NAME);
  const response = await cache.match(META_KEY);
  if (!response) {
    return {};
  }
  try {
    const parsed = await response.json();
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  } catch {
    // ignore malformed metadata and reset to empty
  }
  return {};
}

async function writeMeta(meta) {
  const cache = await caches.open(META_CACHE_NAME);
  await cache.put(
    META_KEY,
    new Response(JSON.stringify(meta), {
      headers: { "Content-Type": "application/json" },
    })
  );
}

async function responseSizeBytes(response) {
  const headerValue = response.headers.get("Content-Length");
  if (headerValue && /^\d+$/.test(headerValue)) {
    return Number(headerValue);
  }
  const blob = await response.clone().blob();
  return blob.size;
}

async function clearStreamCache(keepKey = null) {
  const cache = await caches.open(STREAM_CACHE_NAME);
  const requests = await cache.keys();
  for (const request of requests) {
    const key = canonicalStreamUrl(request.url);
    if (keepKey && key === keepKey) {
      continue;
    }
    await cache.delete(request);
  }
}

async function pruneStreamCache() {
  const cache = await caches.open(STREAM_CACHE_NAME);
  const meta = await readMeta();
  const entries = Object.entries(meta)
    .map(([url, info]) => ({
      url,
      size: Number(info?.size || 0),
      updatedAt: Number(info?.updatedAt || 0),
    }))
    .sort((left, right) => left.updatedAt - right.updatedAt);

  let totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  let totalEntries = entries.length;

  for (const entry of entries) {
    const overEntries = totalEntries > cachePolicy.maxEntries;
    const overBytes = totalBytes > cachePolicy.maxBytes;
    if (!overEntries && !overBytes) {
      break;
    }
    await cache.delete(entry.url);
    totalEntries -= 1;
    totalBytes -= entry.size;
    delete meta[entry.url];
  }

  await writeMeta(meta);
}

async function storeStreamResponse(sourceUrl, response) {
  if (!response || !response.ok || response.status !== 200) {
    return;
  }
  const cache = await caches.open(STREAM_CACHE_NAME);
  const key = canonicalStreamUrl(sourceUrl);
  const size = await responseSizeBytes(response);
  await cache.put(key, response.clone());
  const meta = await readMeta();
  meta[key] = {
    size,
    updatedAt: Date.now(),
  };
  await writeMeta(meta);
  await pruneStreamCache();
}

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "SET_CACHE_POLICY") {
    const maxEntries = Number(data.maxEntries);
    const maxBytes = Number(data.maxBytes);
    if (Number.isFinite(maxEntries) && maxEntries > 0) {
      cachePolicy.maxEntries = Math.floor(maxEntries);
    }
    if (Number.isFinite(maxBytes) && maxBytes > 0) {
      cachePolicy.maxBytes = Math.floor(maxBytes);
    }
    event.waitUntil(pruneStreamCache());
    return;
  }

  if (data.type === "CACHE_STREAM" && data.url) {
    event.waitUntil(
      fetch(String(data.url))
        .then((response) => storeStreamResponse(String(data.url), response))
        .catch(() => {})
    );
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (!isStreamRequest(request)) {
    return;
  }

  const hasRange = request.headers.has("Range");
  const cacheKey = canonicalStreamUrl(request.url);

  event.respondWith(
    (async () => {
      try {
        const networkResponse = await fetch(request);
        if (!hasRange) {
          await storeStreamResponse(request.url, networkResponse);
        }
        return networkResponse;
      } catch {
        const cache = await caches.open(STREAM_CACHE_NAME);
        const cached = await cache.match(cacheKey);
        if (cached) {
          return cached;
        }
        throw new Error("Network unavailable and no cached stream.");
      }
    })()
  );
});
