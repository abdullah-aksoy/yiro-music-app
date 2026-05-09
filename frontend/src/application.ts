// @ts-nocheck
// Spliced from app/static/app.js — re-run: npm run splice (after restoring a full legacy app.js snapshot if needed)
import { state } from "./state";
import { el, elNew } from "./dom";
import { perfMark, perfMeasure, initPerfFromUrl } from "./perf";
import { isAbortError } from "./http";
import {
  loadDiscoverMedia,
  teardownDiscoverMedia,
  warmDiscoverNeighboringClips,
  clearDiscoverWarmCache,
} from "./discoverMedia";
import { appendRichMessageContent, isTrustedStickerUrl } from "./richMessage";
import {
  normalizeArtistQueryParam,
  normalizeAuthPassword,
  normalizeDiscoverCommentBody,
  normalizeGenreQueryParam,
  normalizePlaylistDescription,
  normalizePlaylistName,
  normalizeProfileAvatarUrl,
  normalizeProfileBio,
  normalizeProfileEmail,
  normalizeProfileUsername,
  normalizeResetToken,
  normalizeSearchQuery,
  normalizeSyncChatStickerUrl,
  normalizeSyncChatText,
} from "./queryLimits";
import {
  isSafeArtworkUrl,
  isSafeHttpMediaUrl,
  normalizeApiBaseUrl,
  normalizeUsernameForShare,
  parseDeepLinkHash,
  sanitizeListenTogetherJoinId,
  sanitizeShareNumericId,
} from "./urlSafe";

/** Pinch zoom (çoklu parmak / gesture) — Android’de sayfa kayması–zoom için. */
if (typeof document !== "undefined") {
  document.addEventListener(
    "touchmove",
    function (event) {
      const multi = event.touches && event.touches.length > 1;
      const scale = event.scale;
      const pinch = typeof scale === "number" && scale !== 1;
      if (multi || pinch) {
        event.preventDefault();
      }
    },
    { passive: false },
  );
}


let discoverCommentReplyParentId = null;
/** Parent comment ids whose direct replies are shown in the Discover comments list */
const discoverExpandedReplyThreadIds = new Set();

function clearDiscoverCommentReply() {
  discoverCommentReplyParentId = null;
  if (el.discoverCommentReplyLabel) {
    el.discoverCommentReplyLabel.textContent = "";
  }
  el.discoverCommentReplyBar?.classList.add("hidden");
}

function setDiscoverCommentReply(commentId, username) {
  discoverCommentReplyParentId = Number(commentId);
  if (el.discoverCommentReplyLabel) {
    el.discoverCommentReplyLabel.textContent = username || "user";
  }
  el.discoverCommentReplyBar?.classList.remove("hidden");
  el.discoverCommentInput?.focus();
}

const HISTORY_DEFAULT_MIN_DELTA_MS = 5000;
const STREAM_CACHE_POLICY = {
  maxEntries: 1,
  maxBytes: 20 * 1024 * 1024,
};

/** Browse Trending: how far back to count plays, and max cards shown. Not tied to Analytics "days". */
const TRENDING_HISTORY_DAYS = 90;
const TRENDING_TRACK_LIMIT = 5;

/** Background light poll (playlists, queue, favorites, rails). */
const DATA_REFRESH_INTERVAL_MS = 90_000;
/** Less frequent poll for heavier endpoints (history, library collections, analytics). */
const DATA_HEAVY_REFRESH_INTERVAL_MS = 300_000;
/** Stagger parallel refresh job starts to reduce connection spikes (delay i * ms before job i runs). */
const DATA_REFRESH_JOB_STAGGER_MS = 55;
const DATA_REFRESH_LIGHT_STAGGER_MS = 28;
/** After tab hidden this long, run one silent refresh when visible again. */
const VISIBILITY_REFRESH_MIN_HIDDEN_MS = 45_000;

const PLAYBACK_SNAPSHOT_STORAGE_KEY = "spotify_playback_snapshot";
/** Min interval between automatic /social/following polls (follow/unfollow uses force). */
const SOCIAL_FOLLOWING_POLL_MIN_MS = 600_000;
let lastSocialFollowingFetchMs = 0;

function savePlaybackSnapshot() {
  try {
    if (!state.token || !state.currentPlayingSong) {
      return;
    }
    const payload = {
      v: 1,
      savedAt: Date.now(),
      currentPlayingSong: state.currentPlayingSong,
      queue: state.queue,
      queueIndex: state.queueIndex,
    };
    localStorage.setItem(PLAYBACK_SNAPSHOT_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* ignore */
  }
}

function clearPlaybackSnapshot() {
  try {
    localStorage.removeItem(PLAYBACK_SNAPSHOT_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

async function restorePlaybackFromStorage() {
  try {
    const raw = localStorage.getItem(PLAYBACK_SNAPSHOT_STORAGE_KEY);
    if (!raw) {
      return;
    }
    const data = JSON.parse(raw);
    const song = data?.currentPlayingSong;
    if (!song || typeof song !== "object") {
      return;
    }
    const queue = Array.isArray(data.queue) ? data.queue : [];
    let qIdx = Number.isFinite(Number(data.queueIndex)) ? Number(data.queueIndex) : -1;
    if (queue.length === 0) {
      state.queue = [];
      state.queueIndex = -1;
    } else {
      state.queue = queue;
      if (qIdx < 0 || qIdx >= state.queue.length) {
        qIdx = 0;
      }
      state.queueIndex = qIdx;
    }
    renderQueue();
    await playSong(song, { fromQueue: queue.length > 0 });
  } catch (err) {
    console.warn("restorePlaybackFromStorage:", err);
  }
}

/** Views where top-bar library metrics should be refetched (between heavy poll intervals). */
const VIEW_IDS_REFRESH_LIBRARY_METRICS = new Set([
  "forYouView",
  "favoritesView",
  "historyView",
  "libraryAlbumsView",
  "libraryArtistsView",
  "playlistsView",
]);

/** Initial DOM rows for song search; also increment step for "Load more". */
const SEARCH_SONGS_INITIAL_RENDER_CAP = 100;
const SEARCH_SONGS_PAGE_INCREMENT = 100;

let syncVendorScriptsPromise = null;
/** Coalesces concurrent `refreshAllData` (login + boot). */
let refreshAllDataPromise = null;
/**
 * Preserve full-player video continuity across close/open.
 * Some devices pause hidden <video>; we restore mode/time/play state on reopen.
 */
let fullPlayerVideoResumeState = {
  pending: false,
  wasVideoMode: false,
  wasPlaying: false,
  time: 0,
  songId: null,
  videoUrl: "",
  hlsUrl: null,
};

/** QRCode + jsQR (Listen Together); loaded on demand to speed initial page load. */
function loadSyncVendorScripts() {
  if (typeof window === "undefined") {
    return Promise.resolve();
  }
  if (window.QRCode && window.jsQR) {
    return Promise.resolve();
  }
  if (syncVendorScriptsPromise) {
    return syncVendorScriptsPromise;
  }
  const append = (src) =>
    new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(s);
    });
  syncVendorScriptsPromise = Promise.all([
    window.QRCode ? Promise.resolve() : append("https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js"),
    window.jsQR ? Promise.resolve() : append("https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js"),
  ]).catch((err) => {
    syncVendorScriptsPromise = null;
    throw err;
  });
  return syncVendorScriptsPromise;
}

function resetHistoryPlaybackTracking() {
  state.playedAccumulatedMs = 0;
  state.lastPlayStartedAtMs = null;
}

function startPlaybackClock() {
  if (!state.currentPlayingSong) {
    return;
  }
  if (state.lastPlayStartedAtMs !== null) {
    return;
  }
  state.lastPlayStartedAtMs = Date.now();
}

function pausePlaybackClock() {
  if (state.lastPlayStartedAtMs !== null) {
    const elapsed = Math.max(0, Date.now() - state.lastPlayStartedAtMs);
    state.playedAccumulatedMs += elapsed;
    state.lastPlayStartedAtMs = null;
  }
  return Math.round(state.playedAccumulatedMs);
}

function showFlash(message, isError = false) {
  el.flash.textContent = message;
  el.flash.classList.remove("hidden", "error");
  if (isError) {
    el.flash.classList.add("error");
  }
  window.setTimeout(() => {
    el.flash.classList.add("hidden");
    el.flash.classList.remove("error");
  }, 3000);
}

async function shareSong(song) {
  const songId = song.id;
  if (!songId) {
    showFlash("Only saved songs can be shared.", true);
    return;
  }
  const idStr = sanitizeShareNumericId(songId);
  if (!idStr) {
    showFlash("This song cannot be shared.", true);
    return;
  }
  const shareData = {
    title: `Listen to ${song.title} by ${song.artist}`,
    text: `Check out this song on Yiro: ${song.title} by ${song.artist}`,
    url: `${window.location.origin}${window.location.pathname}#song/${idStr}`,
  };

  try {
    if (navigator.share && isTouchLikeDevice()) {
      await navigator.share(shareData);
      showFlash("Song link shared.");
    } else {
      await navigator.clipboard.writeText(shareData.url);
      showFlash("Song link copied to clipboard.");
    }
  } catch (err) {
    if (err.name === "AbortError") {
      return;
    }
    try {
      await navigator.clipboard.writeText(shareData.url);
      showFlash("Song link copied to clipboard.");
    } catch {
      showFlash("Could not share or copy the link.", true);
    }
  }
}

async function sharePlaylist(playlist) {
  const playlistId = playlist.id;
  if (!playlistId) {
    showFlash("Invalid playlist.", true);
    return;
  }
  const idStr = sanitizeShareNumericId(playlistId);
  if (!idStr) {
    showFlash("This playlist cannot be shared.", true);
    return;
  }
  const shareData = {
    title: `Listen to ${playlist.name} playlist`,
    text: `Check out this playlist on Yiro: ${playlist.name}`,
    url: `${window.location.origin}${window.location.pathname}#playlist/${idStr}`,
  };

  try {
    if (navigator.share && isTouchLikeDevice()) {
      await navigator.share(shareData);
      showFlash("Playlist link shared.");
    } else {
      await navigator.clipboard.writeText(shareData.url);
      showFlash("Playlist link copied to clipboard.");
    }
  } catch (err) {
    if (err.name === "AbortError") {
      return;
    }
    try {
      await navigator.clipboard.writeText(shareData.url);
      showFlash("Playlist link copied to clipboard.");
    } catch {
      showFlash("Could not share or copy the link.", true);
    }
  }
}

async function shareArtist(artistName) {
  const safeName = normalizeArtistQueryParam(artistName);
  if (!safeName) return;
  const shareData = {
    title: `Check out ${safeName}`,
    text: `Listen to songs by ${safeName} on Yiro`,
    url: `${window.location.origin}${window.location.pathname}#artist/${encodeURIComponent(safeName)}`,
  };

  try {
    if (navigator.share && isTouchLikeDevice()) {
      await navigator.share(shareData);
      showFlash("Artist link shared.");
    } else {
      await navigator.clipboard.writeText(shareData.url);
      showFlash("Artist link copied to clipboard.");
    }
  } catch (err) {
    if (err.name === "AbortError") {
      return;
    }
    try {
      await navigator.clipboard.writeText(shareData.url);
      showFlash("Artist link copied to clipboard.");
    } catch {
      showFlash("Could not share or copy the link.", true);
    }
  }
}

async function shareAlbum(album) {
  const cid = album?.collection_id;
  const idStr = sanitizeShareNumericId(cid);
  if (!idStr || !album?.title) {
    showFlash("This album cannot be shared.", true);
    return;
  }
  const title = String(album.title || "Album");
  const artist = String(album.artist || "");
  const shareData = {
    title: `${title}${artist ? ` — ${artist}` : ""}`,
    text: `Listen to ${title} on Yiro`,
    url: `${window.location.origin}${window.location.pathname}#album/${idStr}`,
  };

  try {
    if (navigator.share && isTouchLikeDevice()) {
      await navigator.share(shareData);
      showFlash("Album link shared.");
    } else {
      await navigator.clipboard.writeText(shareData.url);
      showFlash("Album link copied to clipboard.");
    }
  } catch (err) {
    if (err.name === "AbortError") {
      return;
    }
    try {
      await navigator.clipboard.writeText(shareData.url);
      showFlash("Album link copied to clipboard.");
    } catch {
      showFlash("Could not share or copy the link.", true);
    }
  }
}

async function shareUserProfile(username) {
  const safeName = normalizeUsernameForShare(username);
  if (!safeName) {
    showFlash("Profile cannot be shared.", true);
    return;
  }
  const shareData = {
    title: `${safeName} on Yiro`,
    text: `Check out ${safeName}'s music profile on Yiro`,
    url: `${window.location.origin}${window.location.pathname}#user/${encodeURIComponent(safeName)}`,
  };

  try {
    if (navigator.share && isTouchLikeDevice()) {
      await navigator.share(shareData);
      showFlash("Profile link shared.");
    } else {
      await navigator.clipboard.writeText(shareData.url);
      showFlash("Profile link copied to clipboard.");
    }
  } catch (err) {
    if (err.name === "AbortError") {
      return;
    }
    try {
      await navigator.clipboard.writeText(shareData.url);
      showFlash("Profile link copied to clipboard.");
    } catch {
      showFlash("Could not share or copy the link.", true);
    }
  }
}



function safeAsyncAction(action, options = {}) {
  return async () => {
    const button = options.button || null;
    if (button && button.disabled) {
      return;
    }
    if (button) {
      button.disabled = true;
    }
    try {
      await action();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showFlash(message, true);
    } finally {
      if (button) {
        button.disabled = false;
      }
    }
  };
}

async function withActionLock(lockKey, action) {
  if (state.actionLocks.has(lockKey)) {
    return;
  }
  state.actionLocks.add(lockKey);
  try {
    await action();
  } finally {
    state.actionLocks.delete(lockKey);
  }
}

function toUrlEncoded(payload) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(payload)) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      params.append(key, String(value));
    }
  }
  return params;
}

function saveSession() {
  const n = normalizeApiBaseUrl(state.baseUrl);
  if (n) {
    state.baseUrl = n;
    localStorage.setItem("spotify_api_base_url", n);
  } else {
    localStorage.removeItem("spotify_api_base_url");
  }
  localStorage.setItem("spotify_api_token", state.token);
}

function savePlayerPrefs() {
  localStorage.setItem("spotify_audio_prefs", JSON.stringify(state.audioPrefs));
}

function saveUiPrefs() {
  localStorage.setItem("spotify_ui_prefs", JSON.stringify(state.uiPrefs));
}

function saveProfilePrefs() {
  // Profile data is now persisted on backend via /auth/me.
  // Keep this function as a no-op to avoid breaking call sites.
}

function loadProfilePrefs() {
  state.profilePrefs.avatarUrl = normalizeProfileAvatarUrl(state.user?.avatar_url || "");
  state.profilePrefs.bio = normalizeProfileBio(state.user?.bio || "");
}

/** Drop JWT and user only; keep API base URL (login/register/reset must not wipe server field). */
function clearAccessTokenOnly() {
  state.token = "";
  state.user = null;
  localStorage.removeItem("spotify_api_token");
}

function isCredentialEntryPath(path) {
  const normalized = String(path || "").split("?")[0];
  return (
    normalized === "/auth/login" ||
    normalized === "/auth/token" ||
    normalized === "/auth/register" ||
    normalized === "/auth/forgot-password" ||
    normalized === "/auth/reset-password"
  );
}

function errorDetailFromPayload(payload) {
  const d = payload?.detail;
  if (typeof d === "string") {
    return d;
  }
  if (Array.isArray(d)) {
    return d
      .map((item) => (typeof item?.msg === "string" ? item.msg : JSON.stringify(item)))
      .join("; ");
  }
  if (d != null && typeof d === "object") {
    return JSON.stringify(d);
  }
  return "";
}

function clearSession() {
  if (state.searchDebounceTimer) {
    window.clearTimeout(state.searchDebounceTimer);
    state.searchDebounceTimer = null;
  }
  if (state.searchAbortController) {
    state.searchAbortController.abort();
    state.searchAbortController = null;
  }
  state.searchSongVisibleLimit = SEARCH_SONGS_INITIAL_RENDER_CAP;
  state.token = "";
  state.user = null;
  state.hasSearched = false;
  state.lastSearchQuery = "";
  state.searchRequestSeq = 0;
  state.searchProfilesMode = "listeners";
  state.selfProfilePlaylists = [];
  state.profilePrefs.avatarUrl = "";
  state.profilePrefs.bio = "";
  state.browseGenreName = "";
  state.browseGenreTracks = [];
  state.browseGenreTracksLimit = 0;
  state.browseGenreLoading = false;
  state.analytics.topTracks = [];
  state.analytics.topGenres = [];
  state.analytics.initialFetchComplete = false;
  state.trendingTracks = [];
  state.trendingFetchComplete = false;
  state.dataRefreshBulkInFlight = false;
  refreshAllDataPromise = null;
  localStorage.removeItem("spotify_api_token");
  localStorage.removeItem("spotify_api_base_url"); // <-- BU SATIRI EKLE
  state.queue = [];
  state.queueIndex = -1;
  state.playerHiddenBeforeDiscover = null;
  clearPlaybackSnapshot();
}

const DEFAULT_API_BASE = "https://spofity-app-production.up.railway.app/api";

function applyApiBaseUrlFromForm() {
  const n = normalizeApiBaseUrl(el.baseUrl.value);
  if (!n) {
    showFlash("Invalid API URL. Use https://host/api or http://127.0.0.1:PORT/api for local dev.", true);
    return false;
  }
  state.baseUrl = n;
  el.baseUrl.value = n;
  return true;
}

function loadSession() {
  const storedBase = localStorage.getItem("spotify_api_base_url");
  const normalizedBase = normalizeApiBaseUrl(storedBase);
  if (storedBase && !normalizedBase) {
    localStorage.removeItem("spotify_api_base_url");
  }
  state.baseUrl = normalizedBase || DEFAULT_API_BASE;
  state.token = localStorage.getItem("spotify_api_token") || "";
  el.baseUrl.value = state.baseUrl;

  try {
    const storedAudioPrefs = JSON.parse(localStorage.getItem("spotify_audio_prefs") || "{}");
    if (Number.isFinite(storedAudioPrefs.volume)) {
      state.audioPrefs.volume = Math.max(0, Math.min(1, Number(storedAudioPrefs.volume)));
    }
  } catch {
    // keep defaults
  }

  try {
    const storedUiPrefs = JSON.parse(localStorage.getItem("spotify_ui_prefs") || "{}");
    state.uiPrefs.sidebarCollapsed = Boolean(storedUiPrefs.sidebarCollapsed);
    state.uiPrefs.playerHidden = Boolean(storedUiPrefs.playerHidden);
  } catch {
    // keep defaults
  }
}

function showLogin() {
  clearSocialSyncTimer();
  clearDataRefreshTimer();
  state.activeViewId = "__login__";
  state.docHiddenAtMs = null;
  stopPlayback();
  el.loginScreen.classList.remove("hidden");
  el.appShell.classList.add("hidden");
  el.playerBar.classList.add("hidden");
  el.playerShowBtn?.classList.add("hidden");
  el.sidebarShowBtn?.classList.add("hidden");
  const mobileNav = document.getElementById("mobileBottomNav");
  if (mobileNav) mobileNav.style.display = "none";
}

function showApp() {
  el.loginScreen.classList.add("hidden");
  el.appShell.classList.remove("hidden");
  syncSidebarViewportMode();
  applySidebarVisibility();
  applyPlayerBarVisibility();
  // Restore mobile bottom nav visibility (CSS controls display via media query)
  const mobileNav = document.getElementById("mobileBottomNav");
  if (mobileNav) mobileNav.style.display = "";
}

function isCompactViewport() {
  return window.matchMedia("(max-width: 980px)").matches;
}

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function isTouchLikeDevice() {
  return window.matchMedia("(hover: none), (pointer: coarse)").matches;
}

function syncSidebarViewportMode() {
  const nextMode = isCompactViewport() ? "compact" : "desktop";
  if (state.responsiveViewportMode === nextMode) {
    return;
  }
  state.responsiveViewportMode = nextMode;
  applySidebarVisibility();
  saveUiPrefs();
}

function applySidebarVisibility() {
  const compactViewport = isCompactViewport();
  const shouldCollapse = Boolean(state.uiPrefs.sidebarCollapsed);
  el.appShell?.classList.toggle("sidebar-collapsed", shouldCollapse);
  const shouldShowSidebarOpen = Boolean(!compactViewport && shouldCollapse && state.token);
  el.sidebarShowBtn?.classList.toggle("hidden", !shouldShowSidebarOpen);
  if (compactViewport) {
    el.sidebarShowBtn?.classList.add("hidden");
  }
}

function ensureActiveMenuButtonVisible() {
  if (!isCompactViewport()) {
    return;
  }
  const activeButton = el.menuButtons.find((button) => button.classList.contains("active"));
  if (!(activeButton instanceof HTMLElement)) {
    return;
  }
  window.requestAnimationFrame(() => {
    activeButton.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  });
}

function applyPlayerBarVisibility() {
  const onDiscover = state.activeViewId === "discoverView";
  const barHidden = onDiscover || Boolean(state.uiPrefs.playerHidden);
  el.playerBar?.classList.toggle("hidden", barHidden);
  const showRevealBtn =
    Boolean(state.token) && Boolean(state.uiPrefs.playerHidden) && !onDiscover;
  el.playerShowBtn?.classList.toggle("hidden", !showRevealBtn);
  el.appShell?.classList.toggle("player-bar-hidden", barHidden);
}

function setDiscoverShortsMode(on) {
  const v = Boolean(on);
  el.appShell?.classList.toggle("discover-shorts-mode", v);
  if (typeof document !== "undefined") {
    document.body.style.overflow = v ? "hidden" : "";
  }
}

function suppressPlayerBarForDiscover() {
  if (state.playerHiddenBeforeDiscover === null) {
    state.playerHiddenBeforeDiscover = Boolean(state.uiPrefs.playerHidden);
  }
  state.uiPrefs.playerHidden = true;
  applyPlayerBarVisibility();
  setDiscoverShortsMode(true);
  try {
    if (el.audioPlayer && !el.audioPlayer.paused) {
      el.audioPlayer.pause();
    }
  } catch {
    /* ignore */
  }
  try {
    if (el.fullPlayerVideo && !el.fullPlayerVideo.paused) {
      el.fullPlayerVideo.pause();
    }
  } catch {
    /* ignore */
  }
}

function restorePlayerBarAfterDiscover() {
  setDiscoverShortsMode(false);
  if (state.playerHiddenBeforeDiscover !== null) {
    state.uiPrefs.playerHidden = state.playerHiddenBeforeDiscover;
    state.playerHiddenBeforeDiscover = null;
    applyPlayerBarVisibility();
  }
}

function stopPlayback() {
  // Prevent pause event from trying to post history during logout/session reset.
  clearPlaybackSnapshot();
  clearPlaybackVideoPrimary();
  state.currentPlayingSong = null;
  state.lastHistorySentMs = 0;
  resetHistoryPlaybackTracking();
  if (el.audioPlayer) {
    try {
      el.audioPlayer.pause();
      el.audioPlayer.currentTime = 0;
    } catch {
      /* ignore */
    }
    el.audioPlayer.removeAttribute("src");
    try {
      el.audioPlayer.load();
    } catch {
      /* ignore */
    }
  }
  if (el.fullPlayerVideo) {
    try {
      el.fullPlayerVideo.pause();
      el.fullPlayerVideo.currentTime = 0;
    } catch {
      /* ignore */
    }
    el.fullPlayerVideo.removeAttribute("src");
    try {
      el.fullPlayerVideo.load();
    } catch {
      /* ignore */
    }
  }
  closeFullPlayer();
  el.nowPlayingTitle.textContent = "Nothing playing";
  el.nowPlayingArtist.textContent = "Pick a song to start";
  if (el.playerToggleBtn) {
    el.playerToggleBtn.innerHTML = '<i class="material-icons">play_arrow</i>';
  }
  if (el.fullPlayerPlayIcon) el.fullPlayerPlayIcon.textContent = "play_arrow";
  if (el.fullPlayerTitle) el.fullPlayerTitle.textContent = "Nothing playing";
  if (el.fullPlayerArtist) el.fullPlayerArtist.textContent = "Pick a song to start";
  updateNowPlayingArtwork(null);
  updatePlayerProgressUI();
}

let discoverGesturesBound = false;
let discoverEnterGeneration = 0;
let discoverReelSlideAnimating = false;
let artistFullCatalogTimerId = null;

function clearArtistFullCatalogSchedule() {
  if (artistFullCatalogTimerId != null) {
    window.clearTimeout(artistFullCatalogTimerId);
    artistFullCatalogTimerId = null;
  }
}

function resetDiscoverReelStageMotion() {
  discoverReelSlideAnimating = false;
  el.discoverReelStage?.classList.remove(
    "discover-reel-leave-up",
    "discover-reel-leave-down",
    "discover-reel-enter-from-below",
    "discover-reel-enter-from-above",
  );
}

function prefersDiscoverReelReducedMotion() {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function teardownDiscoverPlayback() {
  state.discoverReelMuted = false;
  resetDiscoverReelStageMotion();
  clearDiscoverWarmCache();
  teardownDiscoverMedia("reel");
  teardownDiscoverMedia("overlay");
  if (el.discoverMainVideo) {
    el.discoverMainVideo.oncanplay = null;
    el.discoverMainVideo.ontimeupdate = null;
    el.discoverMainVideo.onended = null;
    el.discoverMainVideo.pause();
    el.discoverMainVideo.removeAttribute("src");
    try {
      el.discoverMainVideo.load();
    } catch (_) {
      /* ignore */
    }
  }
  if (el.discoverFullVideo) {
    el.discoverFullVideo.pause();
    el.discoverFullVideo.removeAttribute("src");
    try {
      el.discoverFullVideo.load();
    } catch (_) {
      /* ignore */
    }
  }
  if (el.discoverFullOverlay) {
    el.discoverFullOverlay.classList.add("hidden");
    el.discoverFullOverlay.setAttribute("aria-hidden", "true");
  }
}

function finalizeSwitchViewChrome(viewId) {
  state.activeViewId = viewId;
  let activeMenuView = viewId;
  if (viewId === "artistDetailView") {
    activeMenuView = "searchView";
  } else if (viewId === "userProfileView") {
    activeMenuView = state.userProfileBackView === "searchView" ? "searchView" : "followingUsersView";
  }
  for (const view of el.views) {
    view.classList.toggle("active", view.id === viewId);
  }
  for (const button of el.menuButtons) {
    button.classList.toggle("active", button.dataset.view === activeMenuView);
  }
  const mobileNavBtns = document.querySelectorAll(".mobile-nav-btn[data-view]");
  for (const btn of mobileNavBtns) {
    btn.classList.toggle("active", btn.dataset.view === activeMenuView);
  }

  const mobileMenuItems = document.querySelectorAll(".mobile-menu-item[data-view]");
  for (const item of mobileMenuItems) {
    item.classList.toggle("active", item.dataset.view === activeMenuView);
  }
  ensureActiveMenuButtonVisible();

  if (viewId === "profilesView") {
    renderProfileView();
  }

  maybeRefreshLibraryMetricsForView(viewId);
}

function switchView(viewId) {
  const prevId = state.activeViewId;
  if (prevId === "artistDetailView" && viewId !== "artistDetailView") {
    clearArtistFullCatalogSchedule();
    const base = `${window.location.pathname}${window.location.search || ""}`;
    window.history.replaceState(window.history.state, document.title, base);
  }
  if (prevId === "discoverView" && viewId !== "discoverView") {
    closeDiscoverCommentsPanel();
    teardownDiscoverPlayback();
    restorePlayerBarAfterDiscover();
  }

  if (viewId === "discoverView") {
    const gen = ++discoverEnterGeneration;
    void (async () => {
      try {
        try {
          if (el.audioPlayer && !el.audioPlayer.paused) {
            el.audioPlayer.pause();
          }
        } catch {
          /* ignore */
        }
        try {
          if (el.fullPlayerVideo && !el.fullPlayerVideo.paused) {
            el.fullPlayerVideo.pause();
          }
        } catch {
          /* ignore */
        }
        const listMode = state.discoverListMode === "saved" ? "saved" : "forYou";
        state.discoverListMode = listMode;
        if (listMode === "saved") {
          const savedPayload = (await request("/discover/saved", { allowNotFound: true })) ?? [];
          state.discoverSamples = Array.isArray(savedPayload) ? savedPayload : [];
        } else {
          state.discoverSamples = await request("/discover/feed");
          state.discoverForYouSamples = [...state.discoverSamples];
        }
        if (gen !== discoverEnterGeneration) {
          return;
        }
        if (state.discoverPendingSampleId != null) {
          const pendingId = state.discoverPendingSampleId;
          let idx = state.discoverSamples.findIndex((s) => s.id === pendingId);
          if (idx < 0 && listMode === "forYou") {
            try {
              const one = await request(`/discover/samples/${pendingId}`);
              if (one && one.id != null) {
                const feedIds = new Set(state.discoverSamples.map((s) => s.id));
                if (!feedIds.has(one.id)) {
                  state.discoverSamples = [one, ...state.discoverSamples];
                  state.discoverForYouSamples = [...state.discoverSamples];
                }
                idx = state.discoverSamples.findIndex((s) => s.id === pendingId);
              }
            } catch {
              if (gen === discoverEnterGeneration) {
                showFlash("Shared clip could not be loaded.", true);
              }
            }
          }
          state.discoverActiveIndex = idx >= 0 ? idx : 0;
          state.discoverPendingSampleId = null;
        }
        if (!Number.isFinite(state.discoverActiveIndex) || state.discoverActiveIndex < 0) {
          state.discoverActiveIndex = 0;
        }
        if (state.discoverSamples.length === 0 && listMode === "forYou") {
          showFlash("No discover clips yet.", true);
          return;
        }
        if (state.discoverActiveIndex >= state.discoverSamples.length) {
          state.discoverActiveIndex = 0;
        }
        finalizeSwitchViewChrome("discoverView");
        suppressPlayerBarForDiscover();
        syncDiscoverSubnavUI();
        renderDiscoverReel();
        bindDiscoverGesturesOnce();
      } catch (err) {
        if (gen === discoverEnterGeneration) {
          showFlash(String(err), true);
        }
      }
    })();
    return;
  }

  discoverEnterGeneration += 1;
  finalizeSwitchViewChrome(viewId);
  applyPlayerBarVisibility();
}

function formatDiscoverCount(n) {
  const x = Number(n) || 0;
  if (x >= 1000) {
    return `${(x / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  }
  return String(x);
}

function syncDiscoverSubnavUI() {
  const forYou = state.discoverListMode !== "saved";
  el.discoverTabForYou?.classList.toggle("active", forYou);
  el.discoverTabForYou?.setAttribute("aria-selected", forYou ? "true" : "false");
  el.discoverTabSaved?.classList.toggle("active", !forYou);
  el.discoverTabSaved?.setAttribute("aria-selected", !forYou ? "true" : "false");
}

function patchDiscoverSampleById(sampleId, patch) {
  const id = Number(sampleId);
  const apply = (arr) => {
    if (!Array.isArray(arr)) {
      return;
    }
    const row = arr.find((z) => Number(z.id) === id);
    if (row) {
      Object.assign(row, patch);
    }
  };
  apply(state.discoverSamples);
  apply(state.discoverForYouSamples);
}

async function switchDiscoverListMode(mode) {
  if (state.activeViewId !== "discoverView") {
    return;
  }
  const next = mode === "saved" ? "saved" : "forYou";
  state.discoverListMode = next;
  syncDiscoverSubnavUI();
  try {
    if (next === "saved") {
      const savedPayload = (await request("/discover/saved", { allowNotFound: true })) ?? [];
      state.discoverSamples = Array.isArray(savedPayload) ? savedPayload : [];
    } else {
      const cached = state.discoverForYouSamples;
      if (Array.isArray(cached) && cached.length) {
        state.discoverSamples = [...cached];
      } else {
        state.discoverSamples = await request("/discover/feed");
        state.discoverForYouSamples = [...state.discoverSamples];
      }
    }
    if (!Number.isFinite(state.discoverActiveIndex) || state.discoverActiveIndex < 0) {
      state.discoverActiveIndex = 0;
    }
    if (state.discoverActiveIndex >= state.discoverSamples.length) {
      state.discoverActiveIndex = 0;
    }
    renderDiscoverReel();
  } catch (err) {
    showFlash(String(err), true);
  }
}

/** API returns /ui/videos/... when clips are on the same host as the API; resolve against API origin when UI is on Netlify. */
function resolveDiscoverVideoUrl(url) {
  const u = String(url || "").trim();
  if (!u) {
    return "";
  }
  if (/^https?:\/\//i.test(u)) {
    return isSafeHttpMediaUrl(u) ? u : "";
  }
  const api = String(state.baseUrl || "").trim();
  if (!api) {
    return u;
  }
  try {
    const raw = api.includes("://") ? api : `https://${api}`;
    const base = new URL(raw);
    return new URL(u, `${base.origin}/`).href;
  } catch {
    return u;
  }
}

function isDiscoverVideoPrimaryActive() {
  if (!state.playbackVideoPrimary || !el.fullPlayerVideo) {
    return false;
  }
  const primaryUrl = String(state.playbackVideoPrimary.videoUrl || "").trim();
  const v = el.fullPlayerVideo;
  if (state.playbackVideoPrimary.hlsUrl) {
    return true;
  }
  if (primaryUrl) {
    return true;
  }
  return Boolean(v.getAttribute("src") || v.currentSrc);
}

async function restoreDiscoverPrimaryVideoForCurrentSong() {
  const songId = Number(state.currentPlayingSong?.id);
  if (!(songId > 0)) {
    return false;
  }
  try {
    const discoverBundle = await request(`/discover/video-for-song/${songId}`);
    const dvUrl = discoverBundle
      ? resolveDiscoverVideoUrl(String(discoverBundle.video_url || "").trim())
      : "";
    const dvHlsRaw = discoverBundle?.hls_url
      ? resolveDiscoverVideoUrl(String(discoverBundle.hls_url || "").trim())
      : "";
    if (!dvUrl && !dvHlsRaw) {
      return false;
    }
    state.playbackVideoPrimary = {
      videoUrl: dvUrl || dvHlsRaw || "",
      hlsUrl: dvHlsRaw || null,
    };
    attachFullPlayerVideoProgressSync();
    return true;
  } catch {
    return false;
  }
}

function detachFullPlayerVideoProgressSync() {
  const vid = el.fullPlayerVideo;
  if (!vid) {
    return;
  }
  if (vid._discoverPrimaryTimeSync) {
    vid.removeEventListener("timeupdate", vid._discoverPrimaryTimeSync);
    vid.removeEventListener("play", vid._discoverPrimaryPlaySync);
    vid.removeEventListener("pause", vid._discoverPrimaryPauseSync);
    vid.removeEventListener("ended", vid._discoverPrimaryEndedSync);
    vid._discoverPrimaryTimeSync = null;
    vid._discoverPrimaryPlaySync = null;
    vid._discoverPrimaryPauseSync = null;
    vid._discoverPrimaryEndedSync = null;
  }
}

function handlePrimaryVideoEnded() {
  void safeAsyncAction(async () => {
    if (!state.playbackVideoPrimary) {
      return;
    }
    flushCurrentHistory("ended").catch(() => {});
    if (state.syncSession.sessionId && !state.syncSession.isHost) {
      return;
    }
    const vid = el.fullPlayerVideo;
    if (state.repeatSong && state.currentPlayingSong && vid) {
      resetHistoryPlaybackTracking();
      state.lastHistorySentMs = 0;
      vid.currentTime = 0;
      await vid.play().catch(() => {});
      updatePlayerProgressUI();
      return;
    }
    await playNextInQueue();
  })();
}

function attachFullPlayerVideoProgressSync() {
  detachFullPlayerVideoProgressSync();
  const vid = el.fullPlayerVideo;
  if (!vid || !state.playbackVideoPrimary) {
    return;
  }
  const onTime = () => {
    if (state.playbackVideoPrimary) {
      updatePlayerProgressUI();
    }
  };
  const onPlay = () => {
    if (!state.playbackVideoPrimary) {
      return;
    }
    startPlaybackClock();
    el.playerToggleBtn.innerHTML = '<i class="material-icons">pause</i>';
    if (el.fullPlayerPlayIcon) {
      el.fullPlayerPlayIcon.textContent = "pause";
    }
  };
  const onPause = () => {
    if (!state.playbackVideoPrimary) {
      return;
    }
    pausePlaybackClock();
    el.playerToggleBtn.innerHTML = '<i class="material-icons">play_arrow</i>';
    if (el.fullPlayerPlayIcon) {
      el.fullPlayerPlayIcon.textContent = "play_arrow";
    }
    void safeAsyncAction(() => flushCurrentHistory("pause"))();
  };
  const onEnded = () => {
    handlePrimaryVideoEnded();
  };
  vid._discoverPrimaryTimeSync = onTime;
  vid._discoverPrimaryPlaySync = onPlay;
  vid._discoverPrimaryPauseSync = onPause;
  vid._discoverPrimaryEndedSync = onEnded;
  vid.addEventListener("timeupdate", onTime);
  vid.addEventListener("play", onPlay);
  vid.addEventListener("pause", onPause);
  vid.addEventListener("ended", onEnded);
}

function clearPlaybackVideoPrimary() {
  if (!state.playbackVideoPrimary) {
    return;
  }
  fullPlayerVideoResumeState.pending = false;
  fullPlayerVideoResumeState.wasVideoMode = false;
  fullPlayerVideoResumeState.wasPlaying = false;
  fullPlayerVideoResumeState.time = 0;
  fullPlayerVideoResumeState.songId = null;
  fullPlayerVideoResumeState.videoUrl = "";
  fullPlayerVideoResumeState.hlsUrl = null;
  detachFullPlayerVideoProgressSync();
  teardownDiscoverMedia("fpPrimary");
  state.playbackVideoPrimary = null;
  const vid = el.fullPlayerVideo;
  if (vid) {
    delete vid.dataset.fpPrimaryLoadKey;
    vid.classList.remove("fp-video-behind-artwork");
    try {
      vid.pause();
    } catch (_) {
      /* ignore */
    }
    vid.removeAttribute("src");
    try {
      vid.load();
    } catch (_) {
      /* ignore */
    }
    vid.muted = true;
  }
}

async function resolveSongForDiscoverSample(sample) {
  const sid = sample?.song_id;
  if (sid != null && String(sid).trim() !== "") {
    const pk = Number(sid);
    if (Number.isFinite(pk) && pk > 0) {
      try {
        const song = await request(`/songs/${pk}`);
        if (song && song.id) {
          return await ensureSongInDb(song);
        }
      } catch {
        /* fall through to iTunes / search */
      }
    }
  }
  const artist = String(sample?.artist_name || "").trim();
  const title = String(sample?.title || "").trim();
  const tid = sample?.itunes_track_id;
  if (tid != null && String(tid).trim() !== "") {
    const n = Number(tid);
    if (Number.isFinite(n)) {
      const song = await request("/songs/by-itunes", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: toUrlEncoded({
          itunes_track_id: String(n),
          title,
          artist,
        }),
      });
      return ensureSongInDb(song);
    }
  }
  const q = normalizeSearchQuery(`${artist} ${title}`);
  if (!q) {
    return null;
  }
  const result = await request(`/search?q=${encodeURIComponent(q)}`);
  const songs = result.songs || [];
  const first = songs[0];
  if (!first) {
    return null;
  }
  return ensureSongInDb(first);
}

async function playDiscoverSampleInFullPlayer() {
  if (state.syncSession.sessionId && !state.syncSession.isHost) {
    showFlash("Only the host can change or play songs.", true);
    return;
  }
  const sample = getActiveDiscoverSample();
  if (!sample) {
    return;
  }
  const videoUrl = resolveDiscoverVideoUrl(String(sample.video_url || "").trim());
  const hlsEarly = sample.hls_url ? resolveDiscoverVideoUrl(String(sample.hls_url).trim()) : "";
  if (!videoUrl && !hlsEarly) {
    showFlash("No video for this clip.", true);
    return;
  }
  let song;
  try {
    song = await resolveSongForDiscoverSample(sample);
  } catch (err) {
    showFlash(String(err?.message || err), true);
    return;
  }
  if (!song || !song.id) {
    showFlash("Could not match this clip to a song.", true);
    return;
  }

  const historyFlushPromise = flushCurrentHistory("switch");

  clearPlaybackVideoPrimary();
  el.audioPlayer.pause();
  el.audioPlayer.removeAttribute("src");
  try {
    el.audioPlayer.load();
  } catch (_) {
    /* ignore */
  }

  resetHistoryPlaybackTracking();
  state.currentPlayingSong = song;
  state.queue = [song];
  state.queueIndex = 0;
  state.lastHistorySentMs = 0;
  syncLikeButtonsUI();
  renderQueue();

  el.nowPlayingTitle.textContent = song.title || "Unknown";
  el.nowPlayingArtist.textContent = song.artist || "Unknown";
  el.playerToggleBtn.innerHTML = '<i class="material-icons">pause</i>';
  if (el.fullPlayerPlayIcon) {
    el.fullPlayerPlayIcon.textContent = "pause";
  }
  if (el.fullPlayerTitle) {
    el.fullPlayerTitle.textContent = song.title || "Unknown";
  }
  if (el.fullPlayerArtist) {
    el.fullPlayerArtist.textContent = song.artist || "Unknown artist";
  }

  state.playbackVideoPrimary = { videoUrl: videoUrl || hlsEarly || "", hlsUrl: hlsEarly || null };
  state.activeFpTab = "related";
  state.fullPlayerMediaMode = "video";

  updateNowPlayingArtwork(song);

  switchView("searchView");

  document.querySelectorAll(".fp-media-seg").forEach((s) => {
    const isVideo = s.getAttribute("data-fpmedia") === "video";
    s.classList.toggle("active", isVideo);
    s.setAttribute("aria-selected", isVideo ? "true" : "false");
  });

  openFullPlayer();
  syncFullPlayerMedia();
  attachFullPlayerVideoProgressSync();
  const vid = el.fullPlayerVideo;
  if (vid) {
    vid.volume = state.audioPrefs.volume;
    void vid.play().catch(() => {});
  }
  void renderFullPlayerRelated();
  updatePlayerProgressUI();
  historyFlushPromise.catch(() => {});
}

function getActiveDiscoverSample() {
  const list = state.discoverSamples || [];
  if (!list.length) {
    return null;
  }
  let i = state.discoverActiveIndex || 0;
  if (i < 0) {
    i = 0;
  }
  if (i >= list.length) {
    i = list.length - 1;
  }
  return list[i];
}

function updateDiscoverMuteButtonUI() {
  const muted = !!state.discoverReelMuted;
  if (el.discoverMuteIcon) {
    el.discoverMuteIcon.textContent = muted ? "volume_off" : "volume_up";
  }
  if (el.discoverMuteBtn) {
    el.discoverMuteBtn.setAttribute("aria-pressed", muted ? "true" : "false");
    el.discoverMuteBtn.title = muted ? "Unmute" : "Mute";
  }
}

function updateDiscoverChrome() {
  updateDiscoverMuteButtonUI();
  const s = getActiveDiscoverSample();
  if (!s || !el.discoverTitle || !el.discoverArtist) {
    return;
  }
  el.discoverTitle.textContent = s.title || "";
  el.discoverArtist.textContent = s.artist_name || "";
  if (el.discoverLikeCount) {
    el.discoverLikeCount.textContent = formatDiscoverCount(s.likes_count);
  }
  if (el.discoverSaveCount) {
    el.discoverSaveCount.textContent = formatDiscoverCount(s.saves_count);
  }
  if (el.discoverLikeIcon) {
    el.discoverLikeIcon.textContent = s.liked_by_me ? "favorite" : "favorite_border";
  }
  if (el.discoverSaveIcon) {
    el.discoverSaveIcon.textContent = s.saved_by_me ? "bookmark" : "bookmark_border";
  }
  if (el.discoverCommentCount) {
    el.discoverCommentCount.textContent = formatDiscoverCount(s.comments_count);
  }
}

function syncDiscoverMainVideo() {
  const v = el.discoverMainVideo;
  const s = getActiveDiscoverSample();
  if (!v || !s) {
    return;
  }
  v.muted = !!state.discoverReelMuted;
  v.loop = false;
  v.oncanplay = null;
  v.ontimeupdate = null;
  v.onended = null;
  v.preload = "auto";
  const mp4Url = resolveDiscoverVideoUrl(String(s.video_url || "").trim());
  const hlsUrl = s.hls_url ? resolveDiscoverVideoUrl(String(s.hls_url).trim()) : "";
  if (!mp4Url && !hlsUrl) {
    return;
  }
  void loadDiscoverMedia("reel", v, mp4Url, hlsUrl || null).then(() => {
    if (state.activeViewId !== "discoverView") {
      return;
    }
    v.muted = !!state.discoverReelMuted;
    v.onended = () => {
      if (state.activeViewId !== "discoverView") {
        return;
      }
      stepDiscoverReelSmooth(1);
    };
    const onPlayingPrefetch = () => {
      v.removeEventListener("playing", onPlayingPrefetch);
      scheduleDiscoverNeighborPrefetch();
    };
    v.addEventListener("playing", onPlayingPrefetch);
    v.play().catch(() => {});
  });
}

/** Prefetch next 1–2 reel MP4s after current clip starts (no idle delay; avoids bandwidth fight with first load). */
function scheduleDiscoverNeighborPrefetch() {
  if (state.activeViewId !== "discoverView") {
    return;
  }
  const run = () => {
    if (state.activeViewId !== "discoverView") {
      return;
    }
    const list = state.discoverSamples || [];
    const n = list.length;
    if (n < 2) {
      return;
    }
    const i = (((Number(state.discoverActiveIndex) || 0) % n) + n) % n;
    const urls = [];
    const next = list[(i + 1) % n];
    urls.push(resolveDiscoverVideoUrl(String(next.video_url || "").trim()));
    if (n > 2) {
      const next2 = list[(i + 2) % n];
      urls.push(resolveDiscoverVideoUrl(String(next2.video_url || "").trim()));
    }
    warmDiscoverNeighboringClips(urls);
  };
  setTimeout(run, 0);
}

function renderDiscoverReel() {
  const empty = !state.discoverSamples.length;
  el.discoverEmptyState?.classList.toggle("hidden", !empty);
    if (empty) {
    if (el.discoverEmptyState) {
      el.discoverEmptyState.textContent =
        state.discoverListMode === "saved" ? "Nothing saved yet." : "No clips here yet.";
    }
    if (el.discoverMainVideo) {
      try {
        el.discoverMainVideo.pause();
      } catch {
        /* ignore */
      }
      el.discoverMainVideo.removeAttribute("src");
      try {
        el.discoverMainVideo.load();
      } catch {
        /* ignore */
      }
    }
    updateDiscoverMuteButtonUI();
    return;
  }
  updateDiscoverChrome();
  syncDiscoverMainVideo();
}

function stepDiscoverReel(delta) {
  const n = (state.discoverSamples || []).length;
  if (n === 0) {
    return;
  }
  state.discoverActiveIndex = (state.discoverActiveIndex + delta + n) % n;
  renderDiscoverReel();
}

function stepDiscoverReelSmooth(delta) {
  const n = (state.discoverSamples || []).length;
  if (n === 0) {
    return;
  }
  const nextIdx = (state.discoverActiveIndex + delta + n) % n;
  if (nextIdx === state.discoverActiveIndex) {
    return;
  }
  const stage = el.discoverReelStage;
  if (!stage || prefersDiscoverReelReducedMotion()) {
    stepDiscoverReel(delta);
    return;
  }
  if (discoverReelSlideAnimating) {
    return;
  }
  discoverReelSlideAnimating = true;

  const leaveClass = delta > 0 ? "discover-reel-leave-up" : "discover-reel-leave-down";
  const enterClass = delta > 0 ? "discover-reel-enter-from-below" : "discover-reel-enter-from-above";

  let committed = false;
  const commitAndEnter = () => {
    if (committed) {
      return;
    }
    committed = true;
    window.clearTimeout(fallbackTimer);
    stage.removeEventListener("transitionend", onTransitionEnd);
    state.discoverActiveIndex = (state.discoverActiveIndex + delta + n) % n;
    updateDiscoverChrome();
    syncDiscoverMainVideo();
    stage.classList.remove("discover-reel-leave-up", "discover-reel-leave-down");
    stage.classList.add(enterClass);
    void stage.offsetHeight;
    requestAnimationFrame(() => {
      stage.classList.remove(enterClass);
      discoverReelSlideAnimating = false;
    });
  };

  const fallbackTimer = window.setTimeout(commitAndEnter, 260);

  const onTransitionEnd = (e) => {
    if (e.target !== stage || e.propertyName !== "transform") {
      return;
    }
    commitAndEnter();
  };

  stage.addEventListener("transitionend", onTransitionEnd);
  stage.classList.add(leaveClass);
}

function bindDiscoverGesturesOnce() {
  if (discoverGesturesBound || !el.discoverReelWrap) {
    return;
  }
  discoverGesturesBound = true;
  let touchY0 = null;
  el.discoverReelWrap.addEventListener(
    "touchstart",
    (e) => {
      if (state.activeViewId !== "discoverView") {
        return;
      }
      const t = e.changedTouches && e.changedTouches[0];
      touchY0 = t ? t.clientY : null;
    },
    { passive: true },
  );
  el.discoverReelWrap.addEventListener(
    "touchend",
    (e) => {
      if (state.activeViewId !== "discoverView" || touchY0 == null) {
        return;
      }
      const t = e.changedTouches && e.changedTouches[0];
      const y = t ? t.clientY : touchY0;
      const dy = touchY0 - y;
      touchY0 = null;
      if (Math.abs(dy) < 32) {
        return;
      }
      if (dy > 0) {
        stepDiscoverReelSmooth(1);
      } else {
        stepDiscoverReelSmooth(-1);
      }
    },
    { passive: true },
  );

  let wheelAccum = 0;
  let wheelTimer = null;
  el.discoverReelWrap.addEventListener(
    "wheel",
    (e) => {
      if (state.activeViewId !== "discoverView") {
        return;
      }
      e.preventDefault();
      wheelAccum += e.deltaY;
      if (wheelTimer) {
        window.clearTimeout(wheelTimer);
      }
      wheelTimer = window.setTimeout(() => {
        wheelTimer = null;
        if (wheelAccum > 40) {
          stepDiscoverReelSmooth(1);
        } else if (wheelAccum < -40) {
          stepDiscoverReelSmooth(-1);
        }
        wheelAccum = 0;
      }, 45);
    },
    { passive: false },
  );

  if (!window.__yiroDiscoverKeysBound) {
    window.__yiroDiscoverKeysBound = true;
    document.addEventListener("keydown", (e) => {
      if (state.activeViewId !== "discoverView") {
        return;
      }
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
        return;
      }
      if (e.key === "ArrowDown" || e.key === "j" || e.key === "J") {
        e.preventDefault();
        stepDiscoverReelSmooth(1);
      } else if (e.key === "ArrowUp" || e.key === "k" || e.key === "K") {
        e.preventDefault();
        stepDiscoverReelSmooth(-1);
      }
    });
  }
}

function openDiscoverFullVideo() {
  const s = getActiveDiscoverSample();
  if (!s || !el.discoverFullVideo || !el.discoverFullOverlay) {
    return;
  }
  const mp4Url = resolveDiscoverVideoUrl(String(s.video_url || "").trim());
  const hlsUrl = s.hls_url ? resolveDiscoverVideoUrl(String(s.hls_url).trim()) : "";
  if (!mp4Url && !hlsUrl) {
    return;
  }
  if (el.discoverMainVideo) {
    el.discoverMainVideo.pause();
  }
  const fv = el.discoverFullVideo;
  fv.muted = false;
  el.discoverFullOverlay.classList.remove("hidden");
  el.discoverFullOverlay.setAttribute("aria-hidden", "false");
  void loadDiscoverMedia("overlay", fv, mp4Url, hlsUrl || null).then(() => {
    fv.play().catch(() => {});
  });
}

function closeDiscoverFullVideo() {
  teardownDiscoverMedia("overlay");
  if (el.discoverFullVideo) {
    el.discoverFullVideo.pause();
  }
  if (el.discoverFullOverlay) {
    el.discoverFullOverlay.classList.add("hidden");
    el.discoverFullOverlay.setAttribute("aria-hidden", "true");
  }
  if (state.activeViewId === "discoverView") {
    syncDiscoverMainVideo();
  }
}

async function toggleDiscoverLike() {
  const s = getActiveDiscoverSample();
  if (!s) {
    return;
  }
  try {
    const res = await request(`/discover/samples/${s.id}/like`, { method: "POST" });
    const liked = Boolean(res.active);
    const likes = Number(res.likes_count) || 0;
    patchDiscoverSampleById(s.id, { liked_by_me: liked, likes_count: likes });
    updateDiscoverChrome();
  } catch (err) {
    showFlash(String(err), true);
  }
}

async function toggleDiscoverSave() {
  const s = getActiveDiscoverSample();
  if (!s) {
    return;
  }
  const sid = Number(s.id);
  if (!Number.isFinite(sid)) {
    showFlash("Invalid clip.", true);
    return;
  }
  const wasSaved = Boolean(s.saved_by_me);
  try {
    const res = await request(`/discover/samples/${sid}/save`, { method: "POST" });
    const savesRaw = Number(res?.saves_count);
    const saves = Number.isFinite(savesRaw) ? savesRaw : 0;
    const saved =
      res != null && typeof res.active === "boolean" ? Boolean(res.active) : !wasSaved;
    patchDiscoverSampleById(sid, { saved_by_me: saved, saves_count: saves });

    if (state.discoverListMode === "saved") {
      const fresh = (await request("/discover/saved", { allowNotFound: true })) ?? [];
      state.discoverSamples = Array.isArray(fresh) ? fresh : [];
      const n = state.discoverSamples.length;
      if (n === 0) {
        state.discoverActiveIndex = 0;
      } else {
        const i = Number(state.discoverActiveIndex) || 0;
        state.discoverActiveIndex = Math.min(Math.max(0, i), n - 1);
      }
      renderDiscoverReel();
      updateDiscoverChrome();
      return;
    }

    updateDiscoverChrome();
  } catch (err) {
    showFlash(String(err), true);
  }
}

function shareActiveDiscoverSample() {
  const s = getActiveDiscoverSample();
  if (!s) {
    return;
  }
  const idStr = sanitizeShareNumericId(String(s.id));
  if (!idStr) {
    showFlash("This clip cannot be shared.", true);
    return;
  }
  const base = `${window.location.origin}${window.location.pathname}`;
  const link = `${base}#discover/${idStr}`;
  const text = `${s.title || "Clip"} — ${s.artist_name || "Artist"} · Discover on Yiro`;
  if (navigator.share) {
    void navigator.share({ title: s.title || "Yiro Discover", text, url: link }).catch(() => {});
    return;
  }
  void navigator.clipboard.writeText(link).then(
    () => showFlash("Discover link copied."),
    () => showFlash("Could not copy link.", true),
  );
}

function closeDiscoverCommentsPanel() {
  el.discoverCommentsOverlay?.classList.add("hidden");
  el.discoverCommentsOverlay?.setAttribute("aria-hidden", "true");
  document.body.classList.remove("discover-comments-open");
  discoverExpandedReplyThreadIds.clear();
  clearDiscoverCommentReply();
  if (el.discoverCommentsClipMeta) {
    el.discoverCommentsClipMeta.textContent = "";
  }
}

function formatDiscoverCommentTime(iso) {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
      return "";
    }
    return d.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
  } catch {
    return "";
  }
}

function groupDiscoverCommentsByParent(rows) {
  const byParent = new Map();
  for (const c of rows) {
    const p = c.parent_id == null || c.parent_id === undefined ? null : Number(c.parent_id);
    if (!byParent.has(p)) {
      byParent.set(p, []);
    }
    byParent.get(p).push(c);
  }
  for (const ch of byParent.values()) {
    ch.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  }
  return byParent;
}

function setDiscoverShowRepliesToggleUi(btn, count, expanded) {
  btn.setAttribute("aria-expanded", expanded ? "true" : "false");
  btn.textContent = expanded ? "Yanıtları gizle" : `Yanıtları gör · ${count}`;
}

function renderDiscoverCommentRow(c, depth, listEl) {
  const row = document.createElement("div");
  row.className = "discover-comment-row";
  if (depth > 0) {
    row.classList.add("discover-comment-row-reply");
    row.style.setProperty("--discover-reply-depth", String(Math.min(depth, 5)));
  }
  if (c.reply_to_username != null && c.reply_to_username !== "" && c.parent_id != null) {
    const hint = document.createElement("div");
    hint.className = "discover-comment-reply-hint";
    hint.textContent = `↪ ${c.reply_to_username}`;
    row.appendChild(hint);
  }
  const head = document.createElement("div");
  head.className = "discover-comment-row-head";
  const userEl = document.createElement("div");
  userEl.className = "discover-comment-user";
  userEl.textContent = c.username || "User";
  const replyBtn = document.createElement("button");
  replyBtn.type = "button";
  replyBtn.className = "btn ghost discover-comment-reply-btn";
  replyBtn.textContent = "Reply";
  replyBtn.addEventListener("click", () => setDiscoverCommentReply(c.id, c.username || "user"));
  head.appendChild(userEl);
  head.appendChild(replyBtn);
  row.appendChild(head);
  const bodyEl = document.createElement("div");
  bodyEl.className = "discover-comment-body";
  appendRichMessageContent(bodyEl, c.body || "");
  row.appendChild(bodyEl);
  const meta = document.createElement("div");
  meta.className = "discover-comment-meta";
  meta.textContent = formatDiscoverCommentTime(c.created_at);
  row.appendChild(meta);
  listEl.appendChild(row);
}

function renderDiscoverCommentThread(c, byParent, depth, listEl) {
  renderDiscoverCommentRow(c, depth, listEl);
  const kids = byParent.get(Number(c.id)) || [];
  if (!kids.length) {
    return;
  }
  const wrap = document.createElement("div");
  wrap.className = "discover-comment-replies-toggle-wrap";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn ghost discover-comment-show-replies";
  const cid = Number(c.id);
  const repliesEl = document.createElement("div");
  repliesEl.className = "discover-comment-replies";
  const expanded = discoverExpandedReplyThreadIds.has(cid);
  setDiscoverShowRepliesToggleUi(btn, kids.length, expanded);
  if (expanded) {
    for (const k of kids) {
      renderDiscoverCommentThread(k, byParent, depth + 1, repliesEl);
    }
  } else {
    repliesEl.hidden = true;
  }
  btn.addEventListener("click", () => {
    const isOpen = discoverExpandedReplyThreadIds.has(cid);
    if (isOpen) {
      discoverExpandedReplyThreadIds.delete(cid);
      repliesEl.innerHTML = "";
      repliesEl.hidden = true;
      setDiscoverShowRepliesToggleUi(btn, kids.length, false);
      return;
    }
    discoverExpandedReplyThreadIds.add(cid);
    repliesEl.hidden = false;
    for (const k of kids) {
      renderDiscoverCommentThread(k, byParent, depth + 1, repliesEl);
    }
    setDiscoverShowRepliesToggleUi(btn, kids.length, true);
  });
  wrap.appendChild(btn);
  wrap.appendChild(repliesEl);
  listEl.appendChild(wrap);
}

async function refreshDiscoverCommentsList(sampleId) {
  const list = el.discoverCommentsList;
  if (!list) {
    return;
  }
  list.innerHTML = `<div class="discover-comments-status">Loading…</div>`;
  try {
    const rows = await request(`/discover/samples/${sampleId}/comments`, { allowNotFound: true });
    const arr = Array.isArray(rows) ? rows : [];
    list.innerHTML = "";
    if (rows === null) {
      const errBox = document.createElement("div");
      errBox.className = "discover-comments-error";
      errBox.setAttribute("role", "alert");
      errBox.textContent =
        "Comments are not available on this server yet. Update the backend or try again after deploy.";
      list.appendChild(errBox);
      return;
    }
    if (!arr.length) {
      const empty = document.createElement("div");
      empty.className = "discover-comments-empty";
      empty.textContent = "No comments yet. Be the first.";
      list.appendChild(empty);
      return;
    }
    const byParent = groupDiscoverCommentsByParent(arr);
    const roots = byParent.get(null) || [];
    for (const c of roots) {
      renderDiscoverCommentThread(c, byParent, 0, list);
    }
  } catch (err) {
    list.innerHTML = "";
    const errBox = document.createElement("div");
    errBox.className = "discover-comments-error";
    errBox.setAttribute("role", "alert");
    errBox.textContent = String(err);
    list.appendChild(errBox);
  }
}

async function openDiscoverCommentsPanel() {
  const s = getActiveDiscoverSample();
  if (!s || !el.discoverCommentsOverlay) {
    return;
  }
  clearDiscoverCommentReply();
  el.discoverCommentsOverlay.classList.remove("hidden");
  el.discoverCommentsOverlay.setAttribute("aria-hidden", "false");
  document.body.classList.add("discover-comments-open");
  if (el.discoverCommentsClipMeta) {
    const artist = String(s.artist_name || "").trim();
    const title = String(s.title || "").trim();
    el.discoverCommentsClipMeta.textContent =
      artist && title ? `${artist} — ${title}` : title || artist || "";
  }
  if (el.discoverCommentInput) {
    el.discoverCommentInput.value = "";
  }
  discoverExpandedReplyThreadIds.clear();
  await refreshDiscoverCommentsList(s.id);
}

async function submitDiscoverComment(event) {
  event.preventDefault();
  const s = getActiveDiscoverSample();
  if (!s || !el.discoverCommentInput) {
    return;
  }
  const body = normalizeDiscoverCommentBody(el.discoverCommentInput.value || "");
  if (!body) {
    showFlash("Write a comment first.", true);
    return;
  }
  const btn = el.discoverCommentSubmit;
  if (btn) {
    btn.disabled = true;
  }
  try {
    const payload = { body };
    const replyParentId =
      discoverCommentReplyParentId != null && Number.isFinite(discoverCommentReplyParentId)
        ? Number(discoverCommentReplyParentId)
        : null;
    if (replyParentId != null) {
      payload.parent_id = replyParentId;
    }
    await request(`/discover/samples/${s.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    el.discoverCommentInput.value = "";
    clearDiscoverCommentReply();
    if (replyParentId != null) {
      discoverExpandedReplyThreadIds.add(replyParentId);
    }
    const nextCount = (Number(s.comments_count) || 0) + 1;
    patchDiscoverSampleById(s.id, { comments_count: nextCount });
    updateDiscoverChrome();
    await refreshDiscoverCommentsList(s.id);
    showFlash("Comment posted.");
  } catch (err) {
    showFlash(String(err), true);
  } finally {
    if (btn) {
      btn.disabled = false;
    }
  }
}

function renderArtistDiscoverVideos() {
  if (!el.artistVideosRail || !el.artistVideosSection) {
    return;
  }
  const videos = state.artistDiscoverVideos || [];
  if (videos.length === 0) {
    el.artistVideosSection.classList.add("hidden");
    el.artistVideosRail.innerHTML = "";
    return;
  }
  el.artistVideosSection.classList.remove("hidden");
  el.artistVideosRail.innerHTML = "";
  for (const v of videos) {
    const card = document.createElement("article");
    card.className = "artist-video-card";
    card.tabIndex = 0;
    const wrap = document.createElement("div");
    wrap.className = "artist-video-thumb-wrap";
    const vid = document.createElement("video");
    vid.className = "artist-video-thumb";
    vid.muted = true;
    vid.setAttribute("playsinline", "");
    vid.preload = "metadata";
    vid.src = resolveDiscoverVideoUrl(String(v.video_url || ""));
    const playIc = document.createElement("div");
    playIc.className = "artist-video-play-icon";
    playIc.innerHTML = `<i class="material-icons">play_circle</i>`;
    wrap.appendChild(vid);
    wrap.appendChild(playIc);
    const tEl = document.createElement("div");
    tEl.className = "artist-video-card-title";
    tEl.textContent = v.title || "";
    const mEl = document.createElement("div");
    mEl.className = "artist-video-card-meta muted";
    mEl.textContent = v.artist_name || "";
    card.appendChild(wrap);
    card.appendChild(tEl);
    card.appendChild(mEl);
    card.addEventListener("click", () => {
      state.discoverPendingSampleId = v.id;
      switchView("discoverView");
    });
    el.artistVideosRail.appendChild(card);
  }
}

function scrollArtistVideosRail(delta) {
  if (!el.artistVideosRail) {
    return;
  }
  el.artistVideosRail.scrollBy({ left: delta * 220, behavior: "smooth" });
}

function maybeRefreshLibraryMetricsForView(viewId) {
  if (!state.token || state.dataRefreshBulkInFlight) {
    return;
  }
  if (!VIEW_IDS_REFRESH_LIBRARY_METRICS.has(viewId)) {
    return;
  }
  void Promise.all([fetchLibrarySummary(), fetchLibraryStats()]).catch(() => {});
}

/** Returns true when hash navigation opened a concrete view (skip default search). */
async function handleHash() {
  const rawHash = window.location.hash.substring(1).trim();
  if (!rawHash) {
    return false;
  }

  if (!state.token) {
    return false;
  }

  if (rawHash === "discover") {
    state.discoverPendingSampleId = null;
    switchView("discoverView");
    showFlash("Discover opened.");
    return true;
  }

  const parsed = parseDeepLinkHash(rawHash);
  if (!parsed) {
    return false;
  }
  const { kind: type, rawId: id } = parsed;

  if (type === "song") {
    try {
      const song = await request(`/songs/${id}`);
      if (song) {
        await playSong(song);
        if (el.audioPlayer.paused) {
          el.shareStartOverlay?.classList.remove("hidden");
          const resumeOnInteract = () => {
            el.audioPlayer.play().catch(() => {});
            el.shareStartOverlay?.classList.add("hidden");
            el.shareStartBtn?.removeEventListener("click", resumeOnInteract);
          };
          el.shareStartBtn?.addEventListener("click", resumeOnInteract);
        } else {
          showFlash(`Playing shared song: ${song.title}`);
        }
        return true;
      }
    } catch (err) {
      console.error("Failed to load shared song:", err);
    }
    return false;
  }
  if (type === "playlist") {
    try {
      if (state.playlists.some((p) => String(p.id) === String(id))) {
        await openPlaylist(id);
      } else {
        await openPublicPlaylist(id);
      }
      switchView("playlistsView");
      if (el.audioPlayer.paused) {
        el.shareStartOverlay?.classList.remove("hidden");
        const resumeOnInteract = () => {
          el.audioPlayer.play().catch(() => {});
          el.shareStartOverlay?.classList.add("hidden");
          el.shareStartBtn?.removeEventListener("click", resumeOnInteract);
        };
        el.shareStartBtn?.addEventListener("click", resumeOnInteract);
      } else {
        showFlash("Opening shared playlist...");
      }
      return true;
    } catch (err) {
      console.error("Failed to load shared playlist:", err);
    }
    return false;
  }
  if (type === "artist") {
    try {
      let decodedName;
      try {
        decodedName = decodeURIComponent(id);
      } catch {
        return false;
      }
      const opened = await openArtistDetail(decodedName, { requireItunesMatch: true });
      if (!opened) {
        return true;
      }
      showFlash(`Opening artist: ${decodedName}`);
      return true;
    } catch (err) {
      console.error("Failed to load shared artist:", err);
    }
    return false;
  }
  if (type === "user") {
    try {
      let decodedName;
      try {
        decodedName = decodeURIComponent(id);
      } catch {
        return false;
      }
      const safeUser = normalizeUsernameForShare(decodedName);
      if (!safeUser) {
        return false;
      }
      await openPublicUserProfile({ username: safeUser }, { backView: "searchView" });
      showFlash(`Opening profile: ${safeUser}`);
      return true;
    } catch (err) {
      console.error("Failed to load shared profile:", err);
    }
    return false;
  }
  if (type === "album") {
    try {
      const cid = Number(id);
      if (!Number.isFinite(cid) || cid < 1) {
        return false;
      }
      const tracks = await fetchAlbumTracks(cid, 200);
      if (!Array.isArray(tracks) || tracks.length === 0) {
        showFlash("Album could not be loaded.", true);
        return false;
      }
      const t0 = tracks[0];
      const album = {
        collection_id: cid,
        title: t0.album || t0.title || "Album",
        artist: t0.artist || "Unknown artist",
        artwork_url: t0.artwork_url,
        track_count: tracks.length,
      };
      await openArtistDetail(album.artist);
      await openArtistAlbum(album, {});
      switchArtistDetailTab("albums");
      showFlash(`Opening album: ${album.title}`);
      return true;
    } catch (err) {
      console.error("Failed to load shared album:", err);
    }
    return false;
  }
  if (type === "discover") {
    const sid = Number(id);
    if (!Number.isFinite(sid) || sid < 1) {
      return false;
    }
    state.discoverListMode = "forYou";
    state.discoverPendingSampleId = sid;
    switchView("discoverView");
    showFlash("Opening shared clip…");
    return true;
  }

  return false;
}


function clearPlaylistSyncTimer() {
  if (state.syncTimer) {
    window.clearInterval(state.syncTimer);
    state.syncTimer = null;
  }
}

function clearSocialSyncTimer() {
  if (state.socialSyncTimer) {
    window.clearInterval(state.socialSyncTimer);
    state.socialSyncTimer = null;
  }
}

/** Stop audio/video, close Listen Together WS, clear sync timers (logout / session expiry). */
function teardownMediaAndSyncSession() {
  if (typeof window.__yiroListenTogetherTeardown === "function") {
    window.__yiroListenTogetherTeardown();
  }
  clearPlaylistSyncTimer();
  clearSocialSyncTimer();
  clearDataRefreshTimer();
  stopPlayback();
}

function startSocialSyncTimer() {
  clearSocialSyncTimer();
  state.socialSyncTimer = window.setInterval(async () => {
    if (!state.token) {
      return;
    }
    try {
      await fetchFollowingPlaylists();
    } catch {
      // Keep silent in background polling.
    }
  }, 15000);
}

function clearDataRefreshTimer() {
  if (state.dataRefreshTimer) {
    window.clearInterval(state.dataRefreshTimer);
    state.dataRefreshTimer = null;
  }
  if (state.dataRefreshHeavyTimer) {
    window.clearInterval(state.dataRefreshHeavyTimer);
    state.dataRefreshHeavyTimer = null;
  }
}

function startDataRefreshTimer() {
  clearDataRefreshTimer();
  state.dataRefreshTimer = window.setInterval(() => {
    void backgroundRefreshDataLight();
  }, DATA_REFRESH_INTERVAL_MS);
  state.dataRefreshHeavyTimer = window.setInterval(() => {
    void backgroundRefreshDataHeavy();
  }, DATA_HEAVY_REFRESH_INTERVAL_MS);
}

function getLightDataRefreshJobs() {
  return [
    fetchPlaylists,
    fetchFollowingPlaylists,
    fetchFavorites,
    fetchQueueFromBackend,
    fetchRecommendations,
    fetchTopArtistsForSearch,
  ];
}

function getHeavyDataRefreshJobs() {
  return [
    fetchLibrarySummary,
    fetchLibraryStats,
    fetchDiscoverPlaylists,
    fetchHistory,
    fetchLibraryCollections,
    fetchAnalytics,
    fetchTrendingTracks,
  ];
}

function getCoreDataRefreshJobs() {
  return [...getLightDataRefreshJobs(), ...getHeavyDataRefreshJobs()];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

/** Run jobs in parallel but offset each start time to spread load on the API/DB. */
async function runRefreshJobsStaggered(
  jobs: Array<() => Promise<unknown>>,
  staggerMs: number,
): Promise<PromiseSettledResult<unknown>[]> {
  return Promise.allSettled(
    jobs.map(async (job, i) => {
      if (staggerMs > 0 && i > 0) {
        await sleep(staggerMs * i);
      }
      return job();
    }),
  );
}

async function refreshPlaylistDetailAfterDataLoad() {
  if (state.selectedPlaylistId) {
    try {
      await fetchPlaylistDetail(state.selectedPlaylistId);
    } catch {
      renderPlaylistDetail();
    }
  } else {
    renderPlaylistDetail();
  }
}

function shouldRenderSearchAfterPoll() {
  return state.activeViewId === "searchView" || state.activeViewId === "artistDetailView";
}

async function backgroundRefreshDataLight() {
  if (
    !state.token ||
    state.dataRefreshLightInFlight ||
    state.dataRefreshFullInFlight ||
    state.dataRefreshBulkInFlight
  ) {
    return;
  }
  state.dataRefreshLightInFlight = true;
  perfMark("yiro-refresh-light-start");
  try {
    await runRefreshJobsStaggered(getLightDataRefreshJobs(), DATA_REFRESH_LIGHT_STAGGER_MS);
    await refreshPlaylistDetailAfterDataLoad();
    if (shouldRenderSearchAfterPoll()) {
      renderSearchResults();
    }
  } catch {
    // Silent periodic refresh
  } finally {
    perfMark("yiro-refresh-light-end");
    perfMeasure("yiro-refresh-light", "yiro-refresh-light-start", "yiro-refresh-light-end");
    state.dataRefreshLightInFlight = false;
  }
}

async function backgroundRefreshDataHeavy() {
  if (
    !state.token ||
    state.dataRefreshHeavyInFlight ||
    state.dataRefreshFullInFlight ||
    state.dataRefreshBulkInFlight
  ) {
    return;
  }
  state.dataRefreshHeavyInFlight = true;
  perfMark("yiro-refresh-heavy-start");
  try {
    await runRefreshJobsStaggered(getHeavyDataRefreshJobs(), DATA_REFRESH_JOB_STAGGER_MS);
    await refreshPlaylistDetailAfterDataLoad();
    if (shouldRenderSearchAfterPoll()) {
      renderSearchResults();
    }
  } catch {
    // Silent periodic refresh
  } finally {
    perfMark("yiro-refresh-heavy-end");
    perfMeasure("yiro-refresh-heavy", "yiro-refresh-heavy-start", "yiro-refresh-heavy-end");
    state.dataRefreshHeavyInFlight = false;
  }
}

/** Full refresh: visibility resume + same workload as initial poll baseline. */
async function backgroundRefreshDataFull() {
  if (
    !state.token ||
    state.dataRefreshFullInFlight ||
    state.dataRefreshLightInFlight ||
    state.dataRefreshHeavyInFlight ||
    state.dataRefreshBulkInFlight
  ) {
    return;
  }
  state.dataRefreshFullInFlight = true;
  perfMark("yiro-refresh-start");
  try {
    await runRefreshJobsStaggered(getLightDataRefreshJobs(), DATA_REFRESH_LIGHT_STAGGER_MS);
    await runRefreshJobsStaggered(getHeavyDataRefreshJobs(), DATA_REFRESH_JOB_STAGGER_MS);
    await refreshPlaylistDetailAfterDataLoad();
    renderSearchResults();
  } catch {
    // Silent periodic refresh
  } finally {
    perfMark("yiro-refresh-end");
    perfMeasure("yiro-data-refresh", "yiro-refresh-start", "yiro-refresh-end");
    state.dataRefreshFullInFlight = false;
  }
}

function onDocumentVisibilityForDataRefresh() {
  if (document.visibilityState === "hidden") {
    state.docHiddenAtMs = Date.now();
    return;
  }
  if (!state.token) {
    state.docHiddenAtMs = null;
    return;
  }
  const started = state.docHiddenAtMs;
  state.docHiddenAtMs = null;
  if (!started) {
    return;
  }
  const hiddenFor = Date.now() - started;
  if (hiddenFor >= VISIBILITY_REFRESH_MIN_HIDDEN_MS) {
    void backgroundRefreshDataFull();
  }
}

async function request(path, options: RequestInit & { allowNotFound?: boolean } = {}) {
  const { allowNotFound, ...fetchInit } = options;
  const url = `${state.baseUrl}${path}`;
  const headers = { ...(fetchInit.headers || {}) };
  if (state.token) {
    headers.Authorization = `Bearer ${state.token}`;
  }

  const response = await fetch(url, {
    ...fetchInit,
    headers,
  });

  const contentType = response.headers.get("content-type") || "";
  const contentLength = response.headers.get("content-length");
  const isNoContent =
    response.status === 204 ||
    response.status === 205 ||
    contentLength === "0";
  let payload = null;
  if (isNoContent) {
    payload = {};
  } else {
    const raw = await response.text();
    if (!raw) {
      payload = {};
    } else if (contentType.includes("application/json")) {
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = {};
      }
    } else {
      payload = { raw };
    }
  }

  if (response.status === 401) {
    if (isCredentialEntryPath(path)) {
      clearAccessTokenOnly();
      const msg = errorDetailFromPayload(payload) || "Unauthorized";
      throw new Error(msg);
    }
    teardownMediaAndSyncSession();
    clearSession();
    showLogin();
    throw new Error("Session expired. Please login again.");
  }

  if (!response.ok) {
    if (allowNotFound && response.status === 404) {
      return null;
    }
    const detail = payload && payload.detail ? payload.detail : `Request failed (${response.status})`;
    throw new Error(detail);
  }
  return payload;
}


function sessionWebSocketUrl(sessionId, token) {
  const raw = String(state.baseUrl || "").trim().replace(/\/$/, "");
  if (!raw) throw new Error("API base URL is not configured.");

  let u = new URL(raw.includes("://") ? raw : `https://${raw}`);
  
  // Güvenli protokol (wss) Railway için en iyisidir
  const wsProto = u.protocol === "https:" ? "wss:" : "ws:";
  
  // pathPrefix zaten "/api" değerini taşıyor olmalı
  const pathPrefix = u.pathname.replace(/\/$/, "");
  const qs = token ? `?token=${encodeURIComponent(token)}` : "";

  // BURASI KRİTİK: "/sessions/ws" kısmını geri ekledik
  return `${wsProto}//${u.host}${pathPrefix}/sessions/ws/${encodeURIComponent(sessionId)}${qs}`;
}

async function login(email, password) {
  const body = toUrlEncoded({
    email: normalizeProfileEmail(email),
    password: normalizeAuthPassword(password),
  });
  const tokenPayload = await request("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  state.token = tokenPayload.access_token || "";
  saveSession();
  await loadProfile();
  showApp();
  startSocialSyncTimer();
  startDataRefreshTimer();
  const navigatedFromHash = await handleHash();
  if (!navigatedFromHash) {
    switchView("searchView");
  }
  await refreshAllData();
  showFlash("Login successful.");
}

async function register(username, email, password) {
  const body = toUrlEncoded({
    username: normalizeProfileUsername(username),
    email: normalizeProfileEmail(email),
    password: normalizeAuthPassword(password),
  });
  return request("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
}

async function requestPasswordReset(email) {
  const body = toUrlEncoded({ email: normalizeProfileEmail(email) });
  return request("/auth/forgot-password", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
}

async function resetPassword(token, newPassword) {
  const body = toUrlEncoded({
    token: normalizeResetToken(token),
    new_password: normalizeAuthPassword(newPassword),
  });
  return request("/auth/reset-password", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
}

function setAuthMode(modeName) {
  const nextMode = String(modeName || "").trim() || "login";
  state.authMode = nextMode;
  const tabs = [
    ["login", el.authTabLogin],
    ["register", el.authTabRegister],
    ["forgot", el.authTabForgot],
    ["reset", el.authTabReset],
  ];
  const forms = [
    ["login", el.loginForm],
    ["register", el.registerForm],
    ["forgot", el.forgotPasswordForm],
    ["reset", el.resetPasswordForm],
  ];
  for (const [name, tab] of tabs) {
    tab?.classList.toggle("active", name === nextMode);
  }
  for (const [name, form] of forms) {
    form?.classList.toggle("hidden", name !== nextMode);
  }
}

async function loadProfile() {
  state.user = await request("/auth/me");
  loadProfilePrefs();
  el.welcomeTitle.textContent = `Welcome ${state.user.username}`;
  el.welcomeMeta.textContent = state.user.email;
  renderTopbarStats();
  renderProfileView();
}

function renderProfileAvatarPreview(rawUrl) {
  if (!el.profileAvatarPreview || !el.profileAvatarFallback) {
    return;
  }
  const avatarUrl = String(rawUrl || "").trim();
  const fallbackSeed = String(state.user?.username || "U").trim();
  el.profileAvatarFallback.textContent = fallbackSeed ? fallbackSeed[0].toUpperCase() : "U";
  if (!avatarUrl) {
    el.profileAvatarPreview.removeAttribute("src");
    el.profileAvatarPreview.classList.add("hidden");
    el.profileAvatarFallback.classList.remove("hidden");
    return;
  }
  el.profileAvatarPreview.src = avatarUrl;
  el.profileAvatarPreview.classList.remove("hidden");
  el.profileAvatarFallback.classList.add("hidden");
}

function readImageFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Failed to read selected image."));
    reader.readAsDataURL(file);
  });
}

function renderProfileView() {
  if (!state.user || !el.profileUsername || !el.profileEmail) {
    return;
  }
  if (el.profileUsername) {
    el.profileUsername.value = state.user.username || "";
  }
  if (el.profileEmail) {
    el.profileEmail.value = state.user.email || "";
  }
  if (el.profileBio) {
    el.profileBio.value = state.profilePrefs.bio || "";
  }
  if (el.profileMemberSince) {
    const memberSince = state.user.created_at ? new Date(state.user.created_at).toLocaleDateString() : "-";
    el.profileMemberSince.textContent = `Member since: ${memberSince}`;
  }
  renderProfileAvatarPreview(state.profilePrefs.avatarUrl);
}

function renderEmpty(container, text) {
  container.innerHTML = `<div class="empty">${text}</div>`;
}

function artworkFallbackText(song) {
  const seed = (song.title || song.artist || "").trim();
  if (!seed) {
    return "♪";
  }
  return seed[0].toUpperCase();
}

function artworkFallbackMarkup(song) {
  return `<div class="song-artwork-fallback" aria-hidden="true">${artworkFallbackText(song)}</div>`;
}

function upgradeItunesArtworkUrl(rawValue) {
  const value = rawValue ? String(rawValue).trim() : "";
  if (!value || !/mzstatic\.com/i.test(value)) {
    return value;
  }
  return value
    .replace(/\/\d+x\d+bb\//gi, "/600x600bb/")
    .replace(/30x30bb/g, "600x600bb")
    .replace(/60x60bb/g, "600x600bb")
    .replace(/100x100bb/g, "600x600bb");
}

function resolveArtworkUrl(rawValue) {
  const value = rawValue ? String(rawValue).trim() : "";
  if (!value) {
    return "";
  }
  if (/^(https?:|data:|blob:)/i.test(value)) {
    return isSafeArtworkUrl(value) ? upgradeItunesArtworkUrl(value) : "";
  }
  const normalized = value.replaceAll("\\", "/");
  const base = String(state.baseUrl || "").replace(/\/$/, "");
  let url = `${base}/songs/artwork?path=${encodeURIComponent(normalized)}`;
  if (state.token) {
    url += `&token=${encodeURIComponent(state.token)}`;
  }
  return url;
}

function songLine(song) {
  const artist = song.artist || "Unknown artist";
  const album = song.album || "Unknown album";
  return `${artist} - ${album}`;
}

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function buildGeneratedAvatarUrl(displayName) {
  const safeName = String(displayName || "User").trim() || "User";
  const seed = normalizeText(safeName) || "user";
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  const hue = hash % 360;
  const initial = safeName[0] ? safeName[0].toUpperCase() : "U";
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72">
      <rect width="72" height="72" rx="36" fill="hsl(${hue} 55% 32%)" />
      <text x="36" y="43" text-anchor="middle" fill="#eaf6ff" font-size="30" font-family="Inter,Arial,sans-serif" font-weight="700">${initial}</text>
    </svg>
  `;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function resolveProfileAvatarForUsername(username, backendAvatarUrl = "") {
  const safeUsername = String(username || "").trim();
  const backendUrl = resolveArtworkUrl(backendAvatarUrl);
  if (backendUrl) {
    return backendUrl;
  }
  const currentUsername = String(state.user?.username || "").trim();
  if (safeUsername && currentUsername && safeUsername.toLocaleLowerCase("tr") === currentUsername.toLocaleLowerCase("tr")) {
    const ownAvatar = resolveArtworkUrl(state.user?.avatar_url || "");
    if (ownAvatar) {
      return ownAvatar;
    }
  }
  return buildGeneratedAvatarUrl(safeUsername || "User");
}

function isAksoyshopUrl(value) {
  const raw = value ? String(value).trim() : "";
  if (!raw) {
    return false;
  }
  try {
    const parsed = new URL(raw);
    return parsed.hostname === "aksoyshop.com" || parsed.hostname.endsWith(".aksoyshop.com");
  } catch {
    return raw.toLowerCase().includes("aksoyshop.com/");
  }
}

function sourceTypeFromSong(song) {
  if (song && typeof song.is_local === "boolean") {
    if (song.is_local) {
      return "local";
    }
    if (isAksoyshopUrl(song.preview_url)) {
      return "remote";
    }
    return "itunes";
  }
  const explicit = String(song?.source_type || "").toLowerCase();
  if (explicit === "local" || explicit === "itunes" || explicit === "remote") {
    return explicit;
  }
  if (isAksoyshopUrl(song?.preview_url)) {
    return "remote";
  }
  return "itunes";
}

function sourceBadgeFromSong(song) {
  const sourceType = sourceTypeFromSong(song);
  if (sourceType === "local") {
    return {
      label: "LOCAL",
      className: "source-local",
    };
  }
  if (sourceType === "remote") {
    return {
      label: "REMOTE",
      className: "source-remote",
    };
  }
  return {
    label: "ITUNES",
    className: "source-itunes",
  };
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor((ms || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}


/** iTunes katalog / önizleme kaynaklı kuyruk satırları — süre yerine "Preview". Yerel (is_local) DB şarkılarında gerçek süre. */
function isQueueSongItunesCatalog(song) {
  if (!song) {
    return true;
  }
  if (song.is_local === true) {
    return false;
  }
  if (song.is_local === false) {
    return true;
  }
  const tid = song.itunes_track_id != null ? String(song.itunes_track_id).trim() : "";
  return tid.length > 0;
}

function formatQueueSongDurationLabel(song) {
  if (isQueueSongItunesCatalog(song)) {
    return "Preview";
  }
  const ms = Number(song?.duration_ms);
  if (Number.isFinite(ms) && ms > 0) {
    return formatDuration(ms);
  }
  return "Preview";
}

function formatClock(seconds) {
  const raw = Number(seconds);
  const safeSeconds = Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
  const minutes = Math.floor(safeSeconds / 60);
  const rest = safeSeconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function readBufferedSeconds(audio) {
  if (!audio || !audio.buffered || audio.buffered.length === 0) {
    return 0;
  }
  const now = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
  for (let index = 0; index < audio.buffered.length; index += 1) {
    const start = audio.buffered.start(index);
    const end = audio.buffered.end(index);
    if (now >= start && now <= end) {
      return end;
    }
  }
  return audio.buffered.end(audio.buffered.length - 1);
}

function updatePlayerProgressUI() {
  const primary = state.playbackVideoPrimary;
  const vid = el.fullPlayerVideo;
  const useVideo = Boolean(
    primary &&
      vid &&
      (primary.hlsUrl || vid.getAttribute("src") || vid.currentSrc),
  );
  const media = useVideo ? vid : el.audioPlayer;

  const rawDur = Number(media.duration);
  const duration = Number.isFinite(rawDur) && rawDur > 0 ? rawDur : 0;
  const rawCt = Number(media.currentTime);
  const currentTime = Number.isFinite(rawCt) && rawCt >= 0 ? rawCt : 0;
  let bufferedSeconds = 0;
  if (media.buffered && media.buffered.length > 0) {
    const now = currentTime;
    for (let index = 0; index < media.buffered.length; index += 1) {
      const start = media.buffered.start(index);
      const end = media.buffered.end(index);
      if (Number.isFinite(now) && Number.isFinite(start) && Number.isFinite(end) && now >= start && now <= end) {
        bufferedSeconds = end;
        break;
      }
    }
    if (!bufferedSeconds) {
      const lastEnd = media.buffered.end(media.buffered.length - 1);
      bufferedSeconds = Number.isFinite(lastEnd) ? lastEnd : 0;
    }
  }

  const playedPercent = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  const bufferedPercent = Math.max(playedPercent, duration > 0 ? Math.min(100, (bufferedSeconds / duration) * 100) : 0);

  const playedStyle = `${playedPercent}%`;
  const bufferedStyle = `${bufferedPercent}%`;
  const timeStr = formatClock(currentTime);
  const durStr = formatClock(duration);
  const fpDurStr =
    primary || !(state.currentPlayingSong && isQueueSongItunesCatalog(state.currentPlayingSong))
      ? durStr
      : "Preview";

  el.playerPlayed.style.width = playedStyle;
  el.playerBuffered.style.width = bufferedStyle;
  el.playerCurrentTime.textContent = timeStr;
  el.playerDuration.textContent = durStr;

  // Update Full Player
  if (el.fullPlayerPlayed) el.fullPlayerPlayed.style.width = playedStyle;
  if (el.fullPlayerBuffered) el.fullPlayerBuffered.style.width = bufferedStyle;
  if (el.fullPlayerCurrentTime) el.fullPlayerCurrentTime.textContent = timeStr;
  if (el.fullPlayerDuration) el.fullPlayerDuration.textContent = fpDurStr;
}

/** Map db `song.id` or `itunes_track_id` (string keys) to filename under `/ui/videos/`. */
const FULL_PLAYER_VIDEO_MAP = {
  // "1234567890": "example.mp4",
};

function fullPlayerVideoUrlForSong(song) {
  if (!song || !state.baseUrl) {
    return "";
  }
  const idKey = song.id != null ? String(song.id) : null;
  const itKey = song.itunes_track_id ? String(song.itunes_track_id).trim() : null;
  const filename =
    (idKey && FULL_PLAYER_VIDEO_MAP[idKey]) || (itKey && FULL_PLAYER_VIDEO_MAP[itKey]) || "";
  if (!filename) {
    return "";
  }
  const base = state.baseUrl.replace(/\/$/, "");
  return `${base}/videos/${encodeURIComponent(filename)}`;
}

function syncFullPlayerMedia() {
  const vid = el.fullPlayerVideo;
  const ph = el.fullPlayerVideoPlaceholder;
  const img = el.fullPlayerArtwork;
  if (!img) {
    return;
  }

  const primaryUrl = state.playbackVideoPrimary?.videoUrl;
  const primaryHls = state.playbackVideoPrimary?.hlsUrl;
  if ((primaryUrl || primaryHls) && vid) {
    ph?.classList.add("hidden");
    vid.muted = false;
    vid.volume = state.audioPrefs.volume;
    if (primaryHls) {
      const loadKey = `${primaryUrl}\0${primaryHls}`;
      if (vid.dataset.fpPrimaryLoadKey !== loadKey) {
        vid.dataset.fpPrimaryLoadKey = loadKey;
        void loadDiscoverMedia("fpPrimary", vid, primaryUrl, primaryHls);
      }
    } else {
      delete vid.dataset.fpPrimaryLoadKey;
      teardownDiscoverMedia("fpPrimary");
      if (vid.getAttribute("src") !== primaryUrl) {
        vid.src = primaryUrl;
        vid.load();
      }
    }
    if (state.fullPlayerMediaMode === "video") {
      img.classList.add("hidden");
      img.style.display = "none";
      vid.classList.remove("hidden");
      vid.classList.remove("fp-video-behind-artwork");
    } else {
      const artworkUrl = resolveArtworkUrl(state.currentPlayingSong?.artwork_url);
      if (artworkUrl) {
        img.classList.remove("hidden");
        img.style.display = "block";
      } else {
        img.classList.add("hidden");
        img.style.display = "none";
      }
      vid.classList.add("fp-video-behind-artwork");
      vid.classList.remove("hidden");
    }
    return;
  }

  if (state.fullPlayerMediaMode !== "video") {
    if (vid) {
      vid.pause();
      vid.classList.add("hidden");
      vid.removeAttribute("src");
      try {
        vid.load();
      } catch (_) {
        /* ignore */
      }
    }
    ph?.classList.add("hidden");
    const artworkUrl = resolveArtworkUrl(state.currentPlayingSong?.artwork_url);
    if (artworkUrl) {
      img.classList.remove("hidden");
      img.style.display = "block";
    } else {
      img.classList.add("hidden");
      img.style.display = "none";
    }
    return;
  }
  img.classList.add("hidden");
  img.style.display = "none";
  const song = state.currentPlayingSong;
  const url = fullPlayerVideoUrlForSong(song);
  if (url && vid) {
    ph?.classList.add("hidden");
    vid.classList.remove("hidden");
    if (vid.getAttribute("src") !== url) {
      vid.src = url;
      vid.load();
    }
    vid.muted = true;
  } else {
    if (vid) {
      vid.pause();
      vid.classList.add("hidden");
      vid.removeAttribute("src");
      try {
        vid.load();
      } catch (_) {
        /* ignore */
      }
    }
    ph?.classList.remove("hidden");
  }
}

function updateNowPlayingArtwork(song) {
  const artworkUrl = resolveArtworkUrl(song?.artwork_url);
  if (artworkUrl) {
    el.nowPlayingArtwork.src = artworkUrl;
    el.nowPlayingArtwork.style.display = "block";
    el.nowPlayingArtworkFallback.classList.add("hidden");
    
    // Update Full Player
    if (el.fullPlayerArtwork) {
      el.fullPlayerArtwork.src = artworkUrl;
      el.fullPlayerArtwork.style.display = "block";
    }
    if (el.fullPlayerBg) {
      el.fullPlayerBg.style.backgroundImage = `url('${artworkUrl}')`;
    }
  } else {
    el.nowPlayingArtwork.removeAttribute("src");
    el.nowPlayingArtwork.style.display = "none";
    el.nowPlayingArtworkFallback.classList.remove("hidden");
    el.nowPlayingArtworkFallback.textContent = artworkFallbackText(song || {});
    
    // Update Full Player
    if (el.fullPlayerArtwork) {
      el.fullPlayerArtwork.style.display = "none";
      el.fullPlayerArtwork.removeAttribute("src");
    }
    if (el.fullPlayerBg) {
      el.fullPlayerBg.style.backgroundImage = "none";
    }
  }
  syncFullPlayerMedia();
}

function updateMobileVolumeIcon(vol) {
  const mobileVolBtn = document.getElementById("mobileVolumeBtn");
  if (!mobileVolBtn) {
    return;
  }
  const n = Math.max(0, Math.min(100, Math.round(Number(vol))));
  const iconName = n === 0 ? "volume_off" : n < 50 ? "volume_down" : "volume_up";
  const btnIcon = mobileVolBtn.querySelector(".material-icons");
  if (btnIcon) {
    btnIcon.textContent = iconName;
  }
  const pctLabel = document.getElementById("mobileVolumePercentLabel");
  if (pctLabel) {
    pctLabel.textContent = `${n}%`;
  }
  const fpPct = document.getElementById("fullPlayerVolumePercentLabel");
  if (fpPct) {
    fpPct.textContent = `${n}%`;
  }
}

function bumpVolumePercent(delta) {
  const current = Math.round(state.audioPrefs.volume * 100);
  applyVolumePercent(current + Number(delta));
}

let volumePrefsPersistTimer = null;

function applyVolumePercent(percent) {
  const clamped = Math.max(0, Math.min(100, Math.round(Number(percent))));
  state.audioPrefs.volume = clamped / 100;
  el.audioPlayer.volume = state.audioPrefs.volume;
  if (state.playbackVideoPrimary && el.fullPlayerVideo) {
    el.fullPlayerVideo.volume = state.audioPrefs.volume;
  }
  const s = String(clamped);
  if (el.playerVolume) {
    el.playerVolume.value = s;
  }
  if (el.fullPlayerVolume) {
    el.fullPlayerVolume.value = s;
  }
  updateMobileVolumeIcon(clamped);
  savePlayerPrefs();
  if (volumePrefsPersistTimer != null) {
    window.clearTimeout(volumePrefsPersistTimer);
  }
  volumePrefsPersistTimer = window.setTimeout(() => {
    volumePrefsPersistTimer = null;
    void persistAudioPrefs();
  }, 400);
}

/** iOS Safari: range bazen sürüklerken `input` atmaz; touchmove/touchend ile senkronla. */
function bindRangeVolumeTouchSync(rangeEl) {
  if (!rangeEl) {
    return;
  }
  const sync = () => {
    applyVolumePercent(Number(rangeEl.value));
  };
  rangeEl.addEventListener("touchmove", sync, { passive: true });
  rangeEl.addEventListener("touchend", sync, { passive: true });
  rangeEl.addEventListener("touchcancel", sync, { passive: true });
}

function syncAudioPrefsUI() {
  const pct = String(Math.round(state.audioPrefs.volume * 100));
  if (el.playerVolume) {
    el.playerVolume.value = pct;
  }
  if (el.fullPlayerVolume) {
    el.fullPlayerVolume.value = pct;
  }
  el.audioPlayer.volume = state.audioPrefs.volume;
  if (state.playbackVideoPrimary && el.fullPlayerVideo) {
    el.fullPlayerVideo.volume = state.audioPrefs.volume;
  }
  updateMobileVolumeIcon(Number(pct));
}

function syncRepeatButtonsUI() {
  el.playerRepeatBtn?.classList.toggle("active", state.repeatSong);
  el.queueRepeatBtn?.classList.toggle("active", state.repeatQueue);
  el.fullPlayerRepeatBtn?.classList.toggle("active", state.repeatSong);
  el.fullPlayerShuffleBtn?.classList.toggle("active", !!state.shuffleQueue);
}

function buildFavoriteTogglePending(song, wantFav) {
  return {
    wantFav: Boolean(wantFav),
    songId: song.id != null ? song.id : null,
    itunesTrackId: song.itunes_track_id ? String(song.itunes_track_id).trim() : null,
    titleArtistKey: normalizeText(`${song.title}|${song.artist}`),
  };
}

function favoritePendingMatchesSong(song, pending) {
  if (!song || !pending) {
    return false;
  }
  if (pending.songId != null && song.id != null && String(pending.songId) === String(song.id)) {
    return true;
  }
  const pIt = pending.itunesTrackId && String(pending.itunesTrackId).trim();
  const sIt = song.itunes_track_id && String(song.itunes_track_id).trim();
  if (pIt && sIt && pIt === sIt) {
    return true;
  }
  if (pending.titleArtistKey) {
    return normalizeText(`${song.title}|${song.artist}`) === pending.titleArtistKey;
  }
  return false;
}

function syncLikeButtonsUI() {
  if (!state.currentPlayingSong || !state.favorites) {
    if (el.playerLikeBtn) el.playerLikeBtn.innerHTML = '<i class="material-icons">favorite_border</i>';
    if (el.fullPlayerLikeBtn) el.fullPlayerLikeBtn.innerHTML = '<i class="material-icons">favorite_border</i>';
    return;
  }
  let isFav = state.favorites.some((f) => String(f.id) === String(state.currentPlayingSong.id));
  if (state.favoriteTogglePending && favoritePendingMatchesSong(state.currentPlayingSong, state.favoriteTogglePending)) {
    isFav = state.favoriteTogglePending.wantFav;
  }
  const html = isFav
    ? '<i class="material-icons" style="color:var(--ytm-brand-color, #1db954);">favorite</i>'
    : '<i class="material-icons">favorite_border</i>';

  if (el.playerLikeBtn) el.playerLikeBtn.innerHTML = html;
  if (el.fullPlayerLikeBtn) el.fullPlayerLikeBtn.innerHTML = html;
}

function renderOfflineState() {
  if (!el.offlineStateBadge) {
    return;
  }
  const isOnline = navigator.onLine;
  el.offlineStateBadge.textContent = isOnline ? "online" : "offline";
  el.offlineStateBadge.classList.toggle("source-local", isOnline);
  el.offlineStateBadge.classList.toggle("source-remote", !isOnline);
}

function queueHasSong(song) {
  if (!song) {
    return -1;
  }
  return state.queue.findIndex((item) => {
    if (song.id && item.id) {
      return song.id === item.id;
    }
    return normalizeText(`${song.title}|${song.artist}`) === normalizeText(`${item.title}|${item.artist}`);
  });
}

function isSameTrackAsPlaying(candidate, current) {
  if (!candidate || !current) {
    return false;
  }
  if (candidate.id && current.id && String(candidate.id) === String(current.id)) {
    return true;
  }
  const cIt = candidate.itunes_track_id && String(candidate.itunes_track_id).trim();
  const curIt = current.itunes_track_id && String(current.itunes_track_id).trim();
  if (cIt && curIt && cIt === curIt) {
    return true;
  }
  return (
    normalizeText(`${candidate.title}|${candidate.artist}`) === normalizeText(`${current.title}|${current.artist}`)
  );
}

function renderQueue() {
  if (!el.queueList) {
    return;
  }
  if (state.queue.length === 0) {
    renderEmpty(el.queueList, "Queue is empty.");
    return;
  }
  el.queueList.innerHTML = "";
  const useTouchQueueControls = isTouchLikeDevice();
  state.queue.forEach((song, index) => {
    const row = document.createElement("article");
    row.className = `list-item queue-row${index === state.queueIndex ? " active" : ""}`;
    row.dataset.index = String(index);
    row.draggable = false;
    const activeBadge = index === state.queueIndex ? '<span class="meta-pill good">Now</span>' : "";
    row.innerHTML = `
      <div class="song-title">${song.title || "Unknown"} ${activeBadge}</div>
      <div class="song-meta">${song.artist || "Unknown artist"}</div>
      <div class="item-actions"></div>
    `;
    const actions = row.querySelector(".item-actions");
    const playBtn = document.createElement("button");
    playBtn.className = "btn ghost";
    playBtn.type = "button";
    playBtn.textContent = "P";
    playBtn.title = "Play";
    playBtn.setAttribute("aria-label", "Play queue item");
    playBtn.addEventListener("click", safeAsyncAction(() => playQueueIndex(index), { button: playBtn }));
    actions.appendChild(playBtn);

    const removeBtn = document.createElement("button");
    removeBtn.className = "btn ghost";
    removeBtn.type = "button";
    removeBtn.textContent = "X";
    removeBtn.title = "Remove";
    removeBtn.setAttribute("aria-label", "Remove queue item");
    removeBtn.addEventListener("click", () => removeFromQueue(index));

    let moveUpBtn = null;
    let moveDownBtn = null;
    if (useTouchQueueControls) {
      moveUpBtn = document.createElement("button");
      moveUpBtn.className = "btn ghost";
      moveUpBtn.type = "button";
      moveUpBtn.textContent = "↑";
      moveUpBtn.title = "Move up";
      moveUpBtn.setAttribute("aria-label", "Move queue item up");
      moveUpBtn.addEventListener("click", () => moveQueueItem(index, index - 1));
      moveUpBtn.disabled = index <= 0;

      moveDownBtn = document.createElement("button");
      moveDownBtn.className = "btn ghost";
      moveDownBtn.type = "button";
      moveDownBtn.textContent = "↓";
      moveDownBtn.title = "Move down";
      moveDownBtn.setAttribute("aria-label", "Move queue item down");
      moveDownBtn.addEventListener("click", () => moveQueueItem(index, index + 1));
      moveDownBtn.disabled = index >= state.queue.length - 1;
    }

    const dragHandleBtn = document.createElement("button");
    dragHandleBtn.className = "btn ghost queue-drag-handle";
    dragHandleBtn.type = "button";
    dragHandleBtn.textContent = "≡";
    dragHandleBtn.title = "Drag to reorder";
    dragHandleBtn.setAttribute("aria-label", "Drag queue item to reorder");
    dragHandleBtn.addEventListener("mousedown", () => {
      row.draggable = true;
    });
    dragHandleBtn.addEventListener("mouseup", () => {
      if (!row.classList.contains("dragging")) {
        row.draggable = false;
      }
    });
    dragHandleBtn.addEventListener("mouseleave", () => {
      if (!row.classList.contains("dragging")) {
        row.draggable = false;
      }
    });

    row.addEventListener("dragstart", (event) => {
      if (!row.draggable) {
        event.preventDefault();
        return;
      }
      state.queueDragFromIndex = index;
      row.classList.add("dragging");
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", String(index));
      }
    });
    row.addEventListener("dragover", (event) => {
      if (state.queueDragFromIndex === null || state.queueDragFromIndex === index) {
        return;
      }
      event.preventDefault();
      row.classList.add("drag-over");
    });
    row.addEventListener("dragleave", () => {
      row.classList.remove("drag-over");
    });
    row.addEventListener("drop", (event) => {
      if (state.queueDragFromIndex === null || state.queueDragFromIndex === index) {
        return;
      }
      event.preventDefault();
      row.classList.remove("drag-over");
      moveQueueItem(state.queueDragFromIndex, index);
    });
    row.addEventListener("dragend", () => {
      state.queueDragFromIndex = null;
      row.draggable = false;
      row.classList.remove("dragging");
      el.queueList
        ?.querySelectorAll(".queue-row.drag-over")
        .forEach((item) => item.classList.remove("drag-over"));
    });

    if (moveUpBtn) {
      actions.appendChild(moveUpBtn);
    }
    if (moveDownBtn) {
      actions.appendChild(moveDownBtn);
    }
    if (!useTouchQueueControls) {
      actions.appendChild(dragHandleBtn);
    }
    actions.appendChild(removeBtn);
    el.queueList.appendChild(row);
  });
}

function removeFromQueue(index) {
  if (index < 0 || index >= state.queue.length) {
    return;
  }
  const [removed] = state.queue.splice(index, 1);
  if (state.queueIndex > index) {
    state.queueIndex -= 1;
  } else if (state.queueIndex >= state.queue.length) {
    state.queueIndex = state.queue.length - 1;
  }
  renderQueue();
  if (removed?.queue_item_id) {
    void request(`/queue/items/${removed.queue_item_id}`, { method: "DELETE" })
      .then(() => syncQueueReorder())
      .catch(() => {});
  } else {
    void syncQueueReorder();
  }
}

function moveQueueItem(fromIndex, toIndex) {
  if (
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= state.queue.length ||
    toIndex >= state.queue.length ||
    fromIndex === toIndex
  ) {
    return;
  }
  const [movedItem] = state.queue.splice(fromIndex, 1);
  state.queue.splice(toIndex, 0, movedItem);

  if (state.queueIndex === fromIndex) {
    state.queueIndex = toIndex;
  } else if (fromIndex < state.queueIndex && toIndex >= state.queueIndex) {
    state.queueIndex -= 1;
  } else if (fromIndex > state.queueIndex && toIndex <= state.queueIndex) {
    state.queueIndex += 1;
  }

  renderQueue();
  void syncQueueReorder();
  requestAnimationFrame(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    const activeRow = el.queueList?.querySelector(".queue-row.active");
    activeRow?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
}

function clearQueue() {
  state.queue = [];
  state.queueIndex = -1;
  renderQueue();
  void request("/queue/clear", { method: "POST" }).catch(() => {});
}

function streamUrlForSong(songId) {
  const streamUrl = new URL(`${state.baseUrl}/stream/${songId}`);
  if (state.token) {
    streamUrl.searchParams.set("token", state.token);
  }
  return streamUrl.toString();
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    return;
  }
  try {
    const registration = await navigator.serviceWorker.register("./sw.js", { scope: "./" });
    await navigator.serviceWorker.ready;
    state.serviceWorkerReady = true;
    if (registration.active) {
      registration.active.postMessage({
        type: "SET_CACHE_POLICY",
        maxEntries: STREAM_CACHE_POLICY.maxEntries,
        maxBytes: STREAM_CACHE_POLICY.maxBytes,
      });
    }
  } catch {
    state.serviceWorkerReady = false;
  }
}

function queueLocalTrackForCache(streamUrl) {
  if (!state.serviceWorkerReady || !navigator.serviceWorker) {
    return;
  }
  const message = { type: "CACHE_STREAM", url: streamUrl };
  if (navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage(message);
    return;
  }
  navigator.serviceWorker.ready
    .then((registration) => {
      if (registration.active) {
        registration.active.postMessage(message);
      }
    })
    .catch(() => {});
}

function formatLargeDuration(ms) {
  const totalMinutes = Math.floor((ms || 0) / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) {
    return `${minutes}m`;
  }
  return `${hours}h ${minutes}m`;
}

function isWithinPeriod(dateValue, period) {
  if (period === "all") {
    return true;
  }
  const played = new Date(dateValue).getTime();
  const now = Date.now();
  if (!Number.isFinite(played)) {
    return false;
  }
  if (period === "today") {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return played >= start.getTime();
  }
  if (period === "week") {
    return played >= now - 7 * 24 * 60 * 60 * 1000;
  }
  if (period === "month") {
    return played >= now - 30 * 24 * 60 * 60 * 1000;
  }
  return true;
}

function filteredHistoryItems() {
  return state.history.filter((item) => {
    const sourceType = sourceTypeFromSong(item.song || item);
    if (state.historyFilters.source === "local" && sourceType !== "local") {
      return false;
    }
    if (state.historyFilters.source === "itunes" && sourceType !== "itunes") {
      return false;
    }
    return isWithinPeriod(item.listened_at, state.historyFilters.period);
  });
}

function renderTopbarStats() {
  const summary = state.librarySummary;
  if (!summary) {
    el.welcomeStats.textContent = "";
    return;
  }
  const stats = state.libraryStats;
  const genreText = stats && stats.top_genres && stats.top_genres.length > 0
    ? stats.top_genres.map((item) => item.genre).slice(0, 3).join(", ")
    : "-";
  const savedArtistsCount = state.libraryCollections.artists.length;
  const savedAlbumsCount = state.libraryCollections.albums.length;
  const followingUsersCount = state.socialFollowingUsers.length;
  el.welcomeStats.textContent =
    `Favorites: ${summary.favorites_count} | Playlists: ${summary.playlists_count} | Last 7d plays: ${summary.recent_plays_count} | ` +
    `Total listened: ${formatLargeDuration(summary.total_listen_ms)} | Top genres: ${genreText} | ` +
    `Saved artists: ${savedArtistsCount} | Saved albums: ${savedAlbumsCount} | Following users: ${followingUsersCount}`;
}

function refreshAfterFavoriteMutation() {
  void (async () => {
    try {
      await fetchFavorites();
      syncLikeButtonsUI();
    } catch (err) {
      console.error(err);
    }
  })();
  void Promise.all([fetchLibrarySummary(), fetchLibraryStats()])
    .then(async () => {
      state.songRelationsCache.clear();
      await preloadSongRelations(state.searchResults);
      renderSearchResults();
      syncLikeButtonsUI();
    })
    .catch(console.error);
}

function refreshAfterPlaylistMutation(playlistId = null) {
  Promise.all([
    fetchPlaylists(),
    fetchDiscoverPlaylists(el.discoverQuery?.value || ""),
    fetchFollowingPlaylists(),
    fetchLibrarySummary(),
    fetchLibraryStats(),
  ]).then(async () => {
    const targetId = playlistId || state.selectedPlaylistId;
    if (targetId) {
      if (state.selectedPlaylistId !== targetId) {
        state.selectedPlaylistId = targetId;
      }
      await fetchPlaylistDetail(targetId);
    } else {
      renderPlaylistDetail();
    }
    state.songRelationsCache.clear();
    await preloadSongRelations(state.searchResults);
    renderSearchResults();
  }).catch(console.error);
}

function refreshAfterHistoryMutation() {
  Promise.all([fetchHistory(), fetchLibrarySummary(), fetchLibraryStats()]).catch(console.error);
}

async function fetchLibrarySummary() {
  state.librarySummary = await request("/library/summary");
  renderTopbarStats();
}

async function fetchLibraryStats() {
  state.libraryStats = await request("/library/stats");
  renderTopbarStats();
}

async function fetchLibraryCollections() {
  const payload = await request("/library/collections");
  state.libraryCollections.artists = payload.saved_artists || [];
  state.libraryCollections.albums = payload.saved_albums || [];
  renderTopbarStats();
  renderLibraryAlbums();
  renderLibraryArtists();
  hydrateLibraryCollectionArtwork().then(() => {
    renderLibraryAlbums();
    renderLibraryArtists();
  }).catch(console.error);
}

async function searchSongsForArtwork(query) {
  const normalizedQuery = normalizeSearchQuery(query);
  if (!normalizedQuery) {
    return [];
  }
  try {
    const result = await request(`/search?q=${encodeURIComponent(normalizedQuery)}`);
    return Array.isArray(result.songs) ? result.songs : [];
  } catch {
    return [];
  }
}

function pickArtworkFromSongs(songs, matcher) {
  const list = Array.isArray(songs) ? songs : [];
  for (const song of list) {
    if (typeof matcher === "function" && !matcher(song)) {
      continue;
    }
    const artworkUrl = resolveArtworkUrl(song?.artwork_url);
    if (artworkUrl) {
      return artworkUrl;
    }
  }
  return "";
}

async function resolveLibraryArtistArtwork(artistName) {
  const safeArtistName = String(artistName || "").trim();
  const artistKey = normalizeText(safeArtistName);
  if (!artistKey) {
    return "";
  }
  const stableArtworkUrl = resolveStableArtistArtworkUrl(safeArtistName);
  if (stableArtworkUrl) {
    state.libraryArtworkCache.artists.set(artistKey, stableArtworkUrl);
    return stableArtworkUrl;
  }
  if (state.libraryArtworkCache.artists.has(artistKey)) {
    const cachedArtwork = state.libraryArtworkCache.artists.get(artistKey) || "";
    const resolvedCached = resolveStableArtistArtworkUrl(safeArtistName, cachedArtwork);
    if (resolvedCached) {
      state.libraryArtworkCache.artists.set(artistKey, resolvedCached);
      return resolvedCached;
    }
    return cachedArtwork;
  }
  const fromTopArtists = (state.topArtists || []).find(
    (item) => normalizeText(item.artist || "") === artistKey && resolveArtworkUrl(item.artwork_url)
  );
  if (fromTopArtists) {
    const topUrl = resolveStableArtistArtworkUrl(safeArtistName, fromTopArtists.artwork_url);
    state.libraryArtworkCache.artists.set(artistKey, topUrl || "");
    return topUrl || "";
  }
  const songs = await searchSongsForArtwork(safeArtistName);
  const matchedArtwork =
    pickArtworkFromSongs(songs, (song) => normalizeText(song.artist || "") === artistKey) ||
    pickArtworkFromSongs(songs);
  const normalizedMatched = resolveStableArtistArtworkUrl(safeArtistName, matchedArtwork || "");
  state.libraryArtworkCache.artists.set(artistKey, normalizedMatched || "");
  return normalizedMatched || "";
}

async function resolveLibraryAlbumArtwork(albumTitle, artistName) {
  const safeAlbumTitle = String(albumTitle || "").trim();
  const safeArtistName = String(artistName || "").trim();
  const albumKey = `${normalizeText(safeAlbumTitle)}::${normalizeText(safeArtistName)}`;
  if (!safeAlbumTitle || !albumKey) {
    return "";
  }
  if (state.libraryArtworkCache.albums.has(albumKey)) {
    return state.libraryArtworkCache.albums.get(albumKey) || "";
  }
  const songs = await searchSongsForArtwork(`${safeAlbumTitle} ${safeArtistName}`.trim());
  const normalizedAlbumTitle = normalizeText(safeAlbumTitle);
  const normalizedArtistName = normalizeText(safeArtistName);
  const matchedArtwork =
    pickArtworkFromSongs(
      songs,
      (song) =>
        normalizeText(song.album || "") === normalizedAlbumTitle &&
        (!normalizedArtistName || normalizeText(song.artist || "") === normalizedArtistName)
    ) ||
    pickArtworkFromSongs(songs, (song) => normalizeText(song.album || "") === normalizedAlbumTitle) ||
    pickArtworkFromSongs(songs);
  state.libraryArtworkCache.albums.set(albumKey, matchedArtwork || "");
  return matchedArtwork || "";
}

async function hydrateLibraryCollectionArtwork() {
  const artists = state.libraryCollections.artists || [];
  const albums = state.libraryCollections.albums || [];
  state.libraryCollections.artists = await Promise.all(
    artists.map(async (artist) => {
      const artistName = String(artist.artist_name || "").trim();
      const stableArtworkUrl = resolveStableArtistArtworkUrl(artistName, artist.artwork_url || "");
      if (stableArtworkUrl) {
        return {
          ...artist,
          artwork_url: stableArtworkUrl,
        };
      }
      return {
        ...artist,
        artwork_url: await resolveLibraryArtistArtwork(artistName),
      };
    })
  );
  state.libraryCollections.albums = await Promise.all(
    albums.map(async (album) => ({
      ...album,
      artwork_url: await resolveLibraryAlbumArtwork(album.album_title, album.artist_name),
    }))
  );
}

async function fetchSocialFollowingUsers(options = {}) {
  const force = Boolean(options.force);
  const now = Date.now();
  if (!force && lastSocialFollowingFetchMs > 0 && now - lastSocialFollowingFetchMs < SOCIAL_FOLLOWING_POLL_MIN_MS) {
    return;
  }
  lastSocialFollowingFetchMs = now;
  state.socialFollowingUsers = await request("/social/following");
  renderTopbarStats();
  renderFollowingUsers();
}

async function fetchQueueFromBackend() {
  try {
    const items = await request("/queue");
    if (!Array.isArray(items)) {
      return;
    }
    state.queue = items.map((item) => ({
      id: item.song_id || null,
      queue_item_id: item.id,
      title: item.title,
      artist: item.artist,
      album: item.album,
      artwork_url: item.artwork_url,
      preview_url: item.preview_url,
      is_local: item.is_local,
      file_path: item.file_path,
      duration_ms: item.duration_ms != null ? Number(item.duration_ms) : null,
    }));
    if (state.queue.length > 0 && state.queueIndex < 0) {
      state.queueIndex = 0;
    }
    renderQueue();
  } catch {
    // keep client-only queue if backend is unavailable
  }
}

async function syncQueueAdd(song, position) {
  try {
    const payload = {
      song_id: song.id || null,
      title: song.title || null,
      artist: song.artist || null,
      album: song.album || null,
      artwork_url: song.artwork_url || null,
      preview_url: song.preview_url || null,
      position,
    };
    const created = await request("/queue/items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return created;
  } catch {
    return null;
  }
}

async function syncQueueReorder() {
  const itemIds = state.queue.map((item) => item.queue_item_id).filter(Boolean);
  if (itemIds.length !== state.queue.length || itemIds.length === 0) {
    return;
  }
  try {
    await request("/queue/reorder", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ item_ids: itemIds }),
    });
  } catch {
    // keep local order
  }
}

async function loadAudioPrefs() {
  try {
    const payload = await request("/audio/preferences");
    if (Number.isFinite(payload.volume)) {
      state.audioPrefs.volume = Math.max(0, Math.min(1, Number(payload.volume)));
    }
  } catch {
    // backend may not be ready on first boot, keep local defaults
  }
  syncAudioPrefsUI();
}

async function persistAudioPrefs() {
  savePlayerPrefs();
  try {
    await request("/audio/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        volume: state.audioPrefs.volume,
      }),
    });
  } catch {
    // keep silent: local persistence still works
  }
}

async function getSongRelations(songId) {
  if (!songId) {
    return null;
  }
  if (state.songRelationsCache.has(songId)) {
    return state.songRelationsCache.get(songId);
  }
  const relation = await request(`/songs/${songId}/relations`);
  state.songRelationsCache.set(songId, relation);
  return relation;
}

const SONG_RELATIONS_BATCH_SIZE = 50;

async function preloadSongRelations(songs) {
  const relationTargets = (songs || []).filter((song) => song.id && !state.songRelationsCache.has(song.id));
  if (relationTargets.length === 0) {
    return;
  }

  const fetchBatchFallbackParallel = async () => {
    await Promise.all(
      relationTargets.map(async (song) => {
        try {
          await getSongRelations(song.id);
        } catch {
          state.songRelationsCache.set(song.id, null);
        }
      })
    );
  };

  try {
    const ids = relationTargets.map((s) => s.id);
    for (let offset = 0; offset < ids.length; offset += SONG_RELATIONS_BATCH_SIZE) {
      const chunkIds = ids.slice(offset, offset + SONG_RELATIONS_BATCH_SIZE);
      const rows = await request("/songs/relations/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ song_ids: chunkIds }),
      });
      const list = Array.isArray(rows) ? rows : [];
      for (const rel of list) {
        if (rel && rel.song_id != null) {
          state.songRelationsCache.set(Number(rel.song_id), rel);
        }
      }
    }
    for (const song of relationTargets) {
      if (!state.songRelationsCache.has(song.id)) {
        try {
          await getSongRelations(song.id);
        } catch {
          state.songRelationsCache.set(song.id, null);
        }
      }
    }
  } catch {
    await fetchBatchFallbackParallel();
  }
}

function buildRowOverflowMenu(items, ariaLabel = "More actions") {
  const det = document.createElement("details");
  det.className = "row-actions-dropdown";
  det.addEventListener("click", (e) => e.stopPropagation());
  const sum = document.createElement("summary");
  sum.className = "btn ghost icon-btn row-actions-dropdown-trigger";
  sum.setAttribute("aria-label", ariaLabel);
  sum.innerHTML = '<i class="material-icons">more_vert</i>';
  const panel = document.createElement("div");
  panel.className = "row-actions-dropdown-panel";
  for (const item of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = item.danger ? "row-actions-dropdown-item danger" : "row-actions-dropdown-item";
    btn.textContent = item.label;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      det.removeAttribute("open");
      item.run();
    });
    panel.appendChild(btn);
  }
  det.append(sum, panel);
  return det;
}

async function openAddToPlaylistPickerInline(song, actions, options) {
  if (!options?.onPlaylistAdd) {
    return;
  }
  if (state.playlists.length === 0) {
    try {
      await fetchPlaylists();
    } catch {
      /* list stays empty; message below */
    }
  }
  if (state.playlists.length === 0) {
    showFlash("Create a playlist first.", true);
    return;
  }
  actions.querySelector(".playlist-picker-inline")?.remove();

  const picker = document.createElement("div");
  picker.className = "playlist-picker-inline";

  const details = document.createElement("details");
  details.className = "playlist-picker-dropdown";
  details.addEventListener("click", (e) => e.stopPropagation());

  const summary = document.createElement("summary");
  summary.className = "playlist-picker-trigger";
  summary.setAttribute("aria-label", "Choose playlist");
  summary.textContent = "Playlist";

  const menu = document.createElement("div");
  menu.className = "playlist-picker-menu";
  menu.setAttribute("role", "listbox");

  for (const playlist of state.playlists) {
    const opt = document.createElement("button");
    opt.type = "button";
    opt.className = "playlist-picker-option";
    opt.textContent = playlist.name;
    opt.setAttribute("role", "option");
    opt.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      details.dataset.selectedId = String(playlist.id);
      summary.textContent = playlist.name;
      summary.title = playlist.name;
      details.removeAttribute("open");
    });
    menu.appendChild(opt);
  }

  details.append(summary, menu);

  const confirmBtn = document.createElement("button");
  confirmBtn.className = "btn primary playlist-picker-add";
  confirmBtn.type = "button";
  confirmBtn.textContent = "Add";
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn playlist-picker-cancel";
  cancelBtn.type = "button";
  cancelBtn.textContent = "Cancel";

  const closePicker = () => {
    picker.remove();
  };

  confirmBtn.addEventListener(
    "click",
    safeAsyncAction(async () => {
      const playlistId = Number(details.dataset.selectedId || 0);
      if (!playlistId) {
        showFlash("Select a playlist first.", true);
        return;
      }
      await options.onPlaylistAdd(song, playlistId);
      closePicker();
    }, { button: confirmBtn }),
  );
  cancelBtn.addEventListener("click", closePicker);
  const pickerActions = document.createElement("div");
  pickerActions.className = "playlist-picker-actions";
  pickerActions.appendChild(confirmBtn);
  pickerActions.appendChild(cancelBtn);
  picker.appendChild(details);
  picker.appendChild(pickerActions);
  actions.appendChild(picker);
}

function buildSongItem(song, options = {}) {
  const wrap = document.createElement("article");
  wrap.className = "list-item";
  const idText = song.id ? `#${song.id}` : "external";
  const sourceBadge = sourceBadgeFromSong(song);
  const relation = options.relation || null;
  const titlePills = [];
  if (relation && relation.favorited) {
    titlePills.push('<span class="meta-pill good">Favorited</span>');
  }
  if (relation && relation.playlists && relation.playlists.length > 0) {
    titlePills.push(`<span class="meta-pill">In ${relation.playlists.length} playlist(s)</span>`);
  }
  if (options.reasons && options.reasons.length > 0) {
    titlePills.push(
      options.reasons
        .map((reason) => `<span class="meta-pill reason">${String(reason).replaceAll("_", " ")}</span>`)
        .join("")
    );
  }
  const titlePillsHtml = titlePills.join("");
  const artworkUrl = resolveArtworkUrl(song.artwork_url);
  wrap.innerHTML = `
    <div class="song-item-main">
      <div class="song-artwork">
        ${
          artworkUrl
            ? `<img src="${artworkUrl}" alt="Song artwork" loading="lazy" referrerpolicy="no-referrer">`
            : artworkFallbackMarkup(song)
        }
      </div>
      <div class="song-content">
        <div class="song-title">${song.title || "Unknown"} <span class="muted">(${idText})</span> <span class="source-pill ${sourceBadge.className}">${sourceBadge.label}</span>${titlePillsHtml}</div>
        <div class="song-meta">${songLine(song)}</div>
        <div class="item-actions"></div>
      </div>
    </div>
  `;
  const actions = wrap.querySelector(".item-actions");
  const artworkContainer = wrap.querySelector(".song-artwork");
  const artworkImage = artworkContainer ? artworkContainer.querySelector("img") : null;
  if (artworkContainer && artworkImage) {
    artworkImage.addEventListener("error", () => {
      artworkContainer.innerHTML = artworkFallbackMarkup(song);
    });
  }

  const safeArtistName = String(song.artist || "").trim();

  if (options.compactSongRow) {
    wrap.classList.add("song-item-compact");
  }

  const playBtn = document.createElement("button");
  playBtn.className = "btn ghost icon-btn";
  playBtn.type = "button";
  playBtn.title = "Play";
  playBtn.setAttribute("aria-label", "Play");
  playBtn.innerHTML = '<i class="material-icons">play_arrow</i>';
  playBtn.addEventListener(
    "click",
    safeAsyncAction(async () => {
      await playSong(song);
    }, { button: playBtn }),
  );
  actions.appendChild(playBtn);

  const queueBtn = document.createElement("button");
  queueBtn.className = "btn ghost icon-btn";
  queueBtn.type = "button";
  queueBtn.title = "Play next in queue";
  queueBtn.setAttribute("aria-label", "Play next in queue");
  queueBtn.innerHTML = '<i class="material-icons">playlist_play</i>';
  queueBtn.addEventListener("click", () => {
    enqueueSong(song, { insertAfterCurrent: true });
    showFlash(`Queued: ${song.title || "Track"}`);
  });
  actions.appendChild(queueBtn);

  const menuItems = [];
  if (safeArtistName) {
    menuItems.push({
      label: "Follow artist",
      run: () => {
        void safeAsyncAction(async () => {
          if (options.onFollowArtist) {
            await options.onFollowArtist(song);
            return;
          }
          await saveArtistToLibrary(safeArtistName);
        })();
      },
    });
  }
  if (options.onFavorite) {
    menuItems.push({
      label: options.favoriteLabel || "Favorite",
      run: () => {
        void safeAsyncAction(() => options.onFavorite(song))();
      },
    });
  }
  if (song.id) {
    menuItems.push({
      label: "Share",
      run: () => {
        void safeAsyncAction(() => shareSong(song))();
      },
    });
  }
  if (options.onPlaylistAdd) {
    menuItems.push({
      label: "Add to playlist",
      run: () => {
        void openAddToPlaylistPickerInline(song, actions, options);
      },
    });
  }
  if (options.onRemove) {
    menuItems.push({
      label: options.removeLabel || "Remove from playlist",
      danger: true,
      run: () => {
        void safeAsyncAction(() => options.onRemove(song))();
      },
    });
  }
  if (options.onMoveUp) {
    menuItems.push({
      label: "Move up",
      run: () => {
        void safeAsyncAction(() => options.onMoveUp(song))();
      },
    });
  }
  if (options.onMoveDown) {
    menuItems.push({
      label: "Move down",
      run: () => {
        void safeAsyncAction(() => options.onMoveDown(song))();
      },
    });
  }
  if (menuItems.length > 0) {
    actions.appendChild(buildRowOverflowMenu(menuItems, "More track actions"));
  }

  return wrap;
}

function resolveSearchEmptyMessage() {
  const activeFilter = String(state.searchFilter || "songs");
  if (!state.hasSearched) {
    return "No search results yet.";
  }
  if (activeFilter === "albums") {
    return "Album bulunamadi.";
  }
  if (activeFilter === "community_playlists") {
    return "Community playlist bulunamadi.";
  }
  if (activeFilter === "artists") {
    return "Sanatci bulunamadi.";
  }
  if (activeFilter === "profiles") {
    return "Profil bulunamadi.";
  }
  return "Sarki bulunamadi.";
}

function renderSearchResults() {
  perfMark("yiro-render-search-start");
  try {
  renderSearchCommunityPlaylists();
  renderSearchShowcase();
  if (state.searchResults.length === 0) {
    renderEmpty(el.searchResults, resolveSearchEmptyMessage());
    applySearchFilterVisibility();
    return;
  }

  if (state.searchFilter === "albums") {
    const albumMap = new Map();
    for (const song of state.searchResults) {
      const albumName = String(song.album || "").trim();
      const artistName = String(song.artist || "Unknown artist").trim();
      if (!albumName) {
        continue;
      }
      const key = `${normalizeText(albumName)}::${normalizeText(artistName)}`;
      if (!albumMap.has(key)) {
        albumMap.set(key, {
          title: albumName,
          artist: artistName,
          artwork_url: song.artwork_url || "",
          tracks: 1,
          seedSong: song,
        });
      } else {
        albumMap.get(key).tracks += 1;
      }
    }
    const albums = Array.from(albumMap.values());
    if (albums.length === 0) {
      renderEmpty(el.searchResults, "Album bulunamadi.");
      applySearchFilterVisibility();
      return;
    }
    el.searchResults.innerHTML = "";
    const fragment = document.createDocumentFragment();
    for (const album of albums) {
      const row = document.createElement("article");
      row.className = "list-item";
      const artworkUrl = resolveArtworkUrl(album.artwork_url);
      row.innerHTML = `
        <div class="song-item-main">
          <div class="song-artwork">
            ${
              artworkUrl
                ? `<img src="${artworkUrl}" alt="${album.title} artwork" loading="lazy" referrerpolicy="no-referrer">`
                : artworkFallbackMarkup({ title: album.title, artist: album.artist })
            }
          </div>
          <div class="song-content">
            <div class="song-title">${album.title}</div>
            <div class="song-meta">${album.artist}</div>
            <div class="song-meta">${album.tracks} tracks in search result</div>
            <div class="item-actions"></div>
          </div>
        </div>
      `;
      const actions = row.querySelector(".item-actions");
      const openArtistBtn = document.createElement("button");
      openArtistBtn.className = "btn ghost";
      openArtistBtn.type = "button";
      openArtistBtn.textContent = "Open Artist";
      openArtistBtn.addEventListener(
        "click",
        safeAsyncAction(() => openArtistDetail(album.artist), { button: openArtistBtn })
      );
      actions.appendChild(openArtistBtn);
      const playBtn = document.createElement("button");
      playBtn.className = "btn";
      playBtn.type = "button";
      playBtn.textContent = "Play";
      playBtn.addEventListener(
        "click",
        safeAsyncAction(() => playSong(album.seedSong), { button: playBtn })
      );
      actions.appendChild(playBtn);
      const shareBtn = document.createElement("button");
      shareBtn.className = "btn ghost icon-btn btn-share";
      shareBtn.innerHTML = '<i class="material-icons">share</i>';
      shareBtn.title = "Share Artist";
      shareBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        void safeAsyncAction(() => shareArtist(album.artist), { button: shareBtn })();
      });
      actions.appendChild(shareBtn);
      fragment.appendChild(row);

    }
    el.searchResults.appendChild(fragment);
    applySearchFilterVisibility();
    return;
  }

  el.searchResults.innerHTML = "";
  const fragmentSongs = document.createDocumentFragment();
  const allSongs = state.searchResults;
  const limit = Number(state.searchSongVisibleLimit) || SEARCH_SONGS_INITIAL_RENDER_CAP;
  const maxVisible = Math.min(allSongs.length, limit);
  const songsToRender = allSongs.slice(0, maxVisible);
  for (const song of songsToRender) {
    const relation = song.id ? state.songRelationsCache.get(song.id) || null : null;
    fragmentSongs.appendChild(
      buildSongItem(song, {
        onFavorite: addFavoriteFromSong,
        favoriteLabel: "Add Favorite",
        onPlaylistAdd: addSongToPlaylist,
        relation,
      })
    );
  }
  el.searchResults.appendChild(fragmentSongs);
  if (maxVisible < allSongs.length) {
    const moreWrap = document.createElement("div");
    moreWrap.className = "search-show-more-wrap";
    moreWrap.style.padding = "12px 0";
    const moreBtn = document.createElement("button");
    moreBtn.className = "btn ghost";
    moreBtn.type = "button";
    const next = Math.min(allSongs.length, maxVisible + SEARCH_SONGS_PAGE_INCREMENT);
    moreBtn.textContent = `Load more songs (${maxVisible} of ${allSongs.length})`;
    moreBtn.addEventListener("click", () => {
      state.searchSongVisibleLimit = next;
      renderSearchResults();
    });
    moreWrap.appendChild(moreBtn);
    el.searchResults.appendChild(moreWrap);
  }
  applySearchFilterVisibility();
  } finally {
    perfMark("yiro-render-search-end");
    perfMeasure("yiro-render-search", "yiro-render-search-start", "yiro-render-search-end");
  }
}

function syncSearchFilterButtons() {
  for (const button of el.searchFilterButtons) {
    const filterName = String(button.dataset.searchFilter || "").trim();
    const isActive = filterName === state.searchFilter;
    const isEnabled = filterName === "songs" || hasSearchFilterResults(filterName);
    button.classList.toggle("active", isActive);
    button.disabled = !isEnabled;
    button.setAttribute("aria-disabled", isEnabled ? "false" : "true");
  }
}

function getFilteredCommunityPlaylists() {
  const rawQuery = normalizeSearchQuery(state.lastSearchQuery || el.searchQuery?.value || "").toLocaleLowerCase("tr");
  if (!rawQuery) {
    return state.discoveredPlaylists || [];
  }
  return (state.discoveredPlaylists || []).filter((playlist) => {
    const name = String(playlist.name || "").toLocaleLowerCase("tr");
    const description = String(playlist.description || "").toLocaleLowerCase("tr");
    const owner = String(playlist.owner_username || "").toLocaleLowerCase("tr");
    return name.includes(rawQuery) || description.includes(rawQuery) || owner.includes(rawQuery);
  });
}

function renderSearchCommunityPlaylists() {
  if (!el.searchCommunityPlaylistList) {
    return;
  }
  const playlists = getFilteredCommunityPlaylists();
  if (!playlists.length) {
    renderEmpty(el.searchCommunityPlaylistList, "Community playlist bulunamadi.");
    return;
  }
  el.searchCommunityPlaylistList.innerHTML = "";
  const fragment = document.createDocumentFragment();
  for (const playlist of playlists) {
    const row = buildPlaylistMenuRow(playlist, {
      metaText: `Owner: ${playlist.owner_username || "unknown"} • Public`,
      onOpen: () => openPublicPlaylist(playlist.id),
    });
    const actions = row.querySelector(".item-actions");
    const openBtn = document.createElement("button");
    openBtn.className = "btn";
    openBtn.type = "button";
    openBtn.textContent = "Open";
    openBtn.addEventListener(
      "click",
      (event) => {
        event.stopPropagation();
        void safeAsyncAction(() => openPublicPlaylist(playlist.id), { button: openBtn })();
      }
    );
    actions.appendChild(openBtn);
    fragment.appendChild(row);
  }
  el.searchCommunityPlaylistList.appendChild(fragment);
}

function hasSearchFilterResults(filterName) {
  const activeFilter = String(filterName || "songs");
  if (activeFilter === "albums") {
    return state.searchResults.some((song) => String(song.album || "").trim());
  }
  if (activeFilter === "profiles") {
    if (state.searchProfilesMode === "self" && state.user) {
      return true;
    }
    return state.artistListenerProfiles.length > 0;
  }
  if (activeFilter === "community_playlists") {
    return getFilteredCommunityPlaylists().length > 0;
  }
  if (activeFilter === "artists") {
    return state.searchResults.length > 0 || state.topArtists.length > 0;
  }
  return state.searchResults.length > 0;
}

function applySearchFilterVisibility() {
  if (!el.searchFilterSections.length) {
    return;
  }
  const activeFilter = String(state.searchFilter || "songs");
  let visibleCount = 0;
  for (const section of el.searchFilterSections) {
    const tags = String(section.dataset.searchSection || "")
      .split(/\s+/)
      .filter(Boolean);
    const isVisible = tags.includes(activeFilter) && hasSearchFilterResults(activeFilter);
    section.classList.toggle("hidden", !isVisible);
    if (isVisible) {
      visibleCount += 1;
    }
  }
  syncSearchFilterButtons();
}

function setSearchFilter(filterName) {
  const nextFilter = String(filterName || "").trim();
  if (!nextFilter) {
    return;
  }
  if (nextFilter === "profiles") {
    state.searchProfilesMode = "listeners";
  }
  if (nextFilter !== "songs" && !hasSearchFilterResults(nextFilter)) {
    syncSearchFilterButtons();
    return;
  }
  state.searchFilter = nextFilter;
  renderSearchResults();
  applySearchFilterVisibility();
  if (nextFilter === "profiles") {
    void loadSearchProfilesForActiveArtist();
  }
}

function resolveSearchProfilesArtistName() {
  if (state.selectedArtistName) {
    return String(state.selectedArtistName).trim();
  }
  const searchArtist = state.searchResults.find((item) => String(item.artist || "").trim())?.artist;
  if (searchArtist) {
    return String(searchArtist).trim();
  }
  const topArtist = state.topArtists.find((item) => String(item.artist || "").trim())?.artist;
  if (topArtist) {
    return String(topArtist).trim();
  }
  return "";
}

async function fetchArtistListenerProfiles(artistName, options = {}) {
  const safeArtist = normalizeArtistQueryParam(artistName);
  if (!safeArtist) {
    return [];
  }
  const cacheKey = safeArtist.toLocaleLowerCase("tr");
  if (!options.force && state.artistListenerCache.has(cacheKey)) {
    return state.artistListenerCache.get(cacheKey) || [];
  }
  const listeners = await request(`/history/artist-listeners?artist=${encodeURIComponent(safeArtist)}&limit=24`);
  state.artistListenerCache.set(cacheKey, listeners || []);
  return listeners || [];
}

function isUserFollowed(userId) {
  return state.socialFollowingUsers.some((item) => Number(item.user_id) === Number(userId));
}

async function setUserFollowStatus(userId, shouldFollow) {
  const numericUserId = Number(userId || 0);
  if (!numericUserId) {
    throw new Error("User id is not available.");
  }
  await request(`/social/follow/${numericUserId}`, { method: shouldFollow ? "POST" : "DELETE" });
  await fetchSocialFollowingUsers({ force: true });
}

async function fetchSelfProfilePlaylists() {
  const username = String(state.user?.username || "").trim();
  if (!username) {
    state.selfProfilePlaylists = [];
    return;
  }
  try {
    state.selfProfilePlaylists = await request(`/users/${encodeURIComponent(username)}/playlists`);
  } catch {
    state.selfProfilePlaylists = [];
  }
}

function renderSearchProfiles() {
  if (!el.searchProfilesList || !el.searchProfilesMeta) {
    return;
  }
  if (state.searchProfilesMode === "self" && state.user) {
    const joinedAt = state.user.created_at ? new Date(state.user.created_at).toLocaleDateString() : "-";
    el.searchProfilesMeta.textContent = `Signed in as: ${state.user.username}`;
    el.searchProfilesList.innerHTML = "";

    const profileRow = document.createElement("article");
    profileRow.className = "list-item";
    profileRow.innerHTML = `
      <div class="song-title">${state.user.username}</div>
      <div class="song-meta">${state.user.email || "-"}</div>
      <div class="song-meta">Member since: ${joinedAt}</div>
      <div class="item-actions"></div>
    `;
    const actions = profileRow.querySelector(".item-actions");
    const editBtn = document.createElement("button");
    editBtn.className = "btn ghost";
    editBtn.type = "button";
    editBtn.textContent = "Open Profile";
    editBtn.addEventListener("click", safeAsyncAction(openCurrentUserProfileView, { button: editBtn }));
    actions.appendChild(editBtn);
    el.searchProfilesList.appendChild(profileRow);

    if (!state.selfProfilePlaylists.length) {
      const empty = document.createElement("article");
      empty.className = "list-item";
      empty.innerHTML = `
        <div class="song-title">Public playlists</div>
        <div class="song-meta">No public playlists found for your profile.</div>
      `;
      el.searchProfilesList.appendChild(empty);
      return;
    }

    for (const playlist of state.selfProfilePlaylists) {
      const row = document.createElement("article");
      row.className = "list-item";
      row.innerHTML = `
        <div class="song-title">${playlist.name || "Untitled playlist"}</div>
        <div class="song-meta">${playlist.description || "No description"}</div>
        <div class="song-meta">Public playlist</div>
        <div class="item-actions"></div>
      `;
      const playlistActions = row.querySelector(".item-actions");
      const openBtn = document.createElement("button");
      openBtn.className = "btn";
      openBtn.type = "button";
      openBtn.textContent = "Open";
      openBtn.addEventListener(
        "click",
        safeAsyncAction(() => openPublicPlaylist(playlist.id), { button: openBtn })
      );
      playlistActions.appendChild(openBtn);
      el.searchProfilesList.appendChild(row);
    }
    return;
  }
  if (!state.artistListenerArtistName) {
    el.searchProfilesMeta.textContent = "Profil bulunamadi.";
    renderEmpty(el.searchProfilesList, "Profil bulunamadi.");
    return;
  }
  el.searchProfilesMeta.textContent = `Listeners for artist: ${state.artistListenerArtistName}`;
  if (!state.artistListenerProfiles.length) {
    renderEmpty(el.searchProfilesList, "Profil bulunamadi.");
    return;
  }
  el.searchProfilesList.innerHTML = "";
  for (const profile of state.artistListenerProfiles) {
    const row = document.createElement("article");
    row.className = "list-item";
    const playCount = Number(profile.play_count || 0);
    const followed = isUserFollowed(profile.user_id);
    const lastAt = profile.last_listened_at ? new Date(profile.last_listened_at).toLocaleString() : "-";
    const profileName = String(profile.username || "Unknown user").trim();
    const avatarUrl = resolveProfileAvatarForUsername(profileName, profile.avatar_url || "");
    row.innerHTML = `
      <div class="song-item-main profile-row-main">
        <div class="profile-row-avatar">
          <img src="${avatarUrl}" alt="${profileName}">
        </div>
        <div class="song-content">
          <div class="song-title">${profileName}</div>
          <div class="song-meta">${playCount} plays with this artist</div>
          <div class="song-meta">Last listen: ${lastAt}</div>
        </div>
      </div>
      <div class="item-actions"></div>
    `;
    row.addEventListener("click", () => {
      void safeAsyncAction(() => openPublicUserProfile(profile, { backView: "searchView" }), {})();
    });
    const actions = row.querySelector(".item-actions");
    const followBtn = document.createElement("button");
    followBtn.className = "btn ghost";
    followBtn.type = "button";
    followBtn.textContent = followed ? "Unfollow" : "Follow";
    followBtn.addEventListener(
      "click",
      (event) => {
        event.stopPropagation();
        void safeAsyncAction(async () => {
          await setUserFollowStatus(profile.user_id, !followed);
          await loadSearchProfilesForActiveArtist({ force: true });
        }, { button: followBtn })();
      }
    );
    actions.appendChild(followBtn);
    el.searchProfilesList.appendChild(row);
  }
}

async function loadSearchProfilesForActiveArtist(options = {}) {
  state.searchProfilesMode = "listeners";
  const artistName = resolveSearchProfilesArtistName();
  state.artistListenerArtistName = artistName;
  if (!artistName) {
    state.artistListenerProfiles = [];
    renderSearchProfiles();
    return;
  }
  state.artistListenerProfiles = await fetchArtistListenerProfiles(artistName, { force: Boolean(options.force) });
  renderSearchProfiles();
}

async function openCurrentUserProfileView() {
  if (!state.token || !state.user) {
    showFlash("Please sign in first.", true);
    showLogin();
    return;
  }
  switchView("profilesView");
  renderProfileView();
}

function setActivePlaylistTab(tabName) {
  const nextTab = String(tabName || "").trim() || "owned";
  state.activePlaylistTab = nextTab;
  for (const button of el.playlistTabButtons) {
    const isActive = button.dataset.playlistTab === nextTab;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-selected", isActive ? "true" : "false");
  }
  for (const panel of el.playlistTabPanels) {
    const isActive = panel.dataset.playlistPanel === nextTab;
    panel.classList.toggle("hidden", !isActive);
    panel.classList.toggle("active", isActive);
  }
}

function pickSearchFeaturedArtist() {
  const firstSong = state.searchResults[0] || null;
  if (firstSong) {
    return {
      name: String(firstSong.artist || "Unknown artist"),
      artworkUrl: resolveArtworkUrl(firstSong.artwork_url),
      meta: "Artist • Based on your search",
    };
  }
  if (state.topArtists.length > 0) {
    const first = state.topArtists[0];
    return {
      name: String(first.artist || "Unknown artist"),
      artworkUrl: resolveArtworkUrl(first.artwork_url),
      meta: first.source === "personal" ? "Artist • For you" : "Artist • Trending",
    };
  }
  return null;
}

function renderSearchShowcase() {
  if (!el.searchFeaturedArtist || !el.searchQuickPicks) {
    return;
  }
  const shouldShowFeatured = state.hasSearched;
  el.searchFeaturedArtist.classList.toggle("hidden", !shouldShowFeatured);
  if (!shouldShowFeatured) {
    el.searchFeaturedArtist.innerHTML = "";
  }

  const featured = pickSearchFeaturedArtist();
  if (shouldShowFeatured && !featured) {
    renderEmpty(el.searchFeaturedArtist, "Search an artist to show featured section.");
  } else if (shouldShowFeatured) {
    el.searchFeaturedArtist.innerHTML = `
      <div class="ytm-featured-main">
        <div class="ytm-featured-artwork">
          ${
            featured.artworkUrl
              ? `<img src="${featured.artworkUrl}" alt="${featured.name} artwork" loading="lazy" referrerpolicy="no-referrer">`
              : artworkFallbackMarkup({ title: featured.name, artist: featured.name })
          }
        </div>
        <div class="ytm-featured-copy">
          <div class="ytm-featured-title">${featured.name}</div>
          <div class="ytm-featured-meta">${featured.meta}</div>
          <div class="ytm-featured-actions">
            <button class="btn" type="button" data-ytm-action="shuffle">Shuffle</button>
            <button class="btn ghost" type="button" data-ytm-action="open-artist">Open</button>
            <button class="btn ghost" type="button" data-ytm-action="follow-artist">Follow</button>
            <button class="btn ghost" type="button" data-ytm-action="share-artist">Share</button>
          </div>

        </div>
      </div>
    `;
    const shuffleBtn = el.searchFeaturedArtist.querySelector('[data-ytm-action="shuffle"]');
    if (shuffleBtn) {
      shuffleBtn.addEventListener(
        "click",
        safeAsyncAction(async () => {
          const candidateSongs = state.searchResults.length > 0
            ? state.searchResults
            : state.recommendations.map((entry) => entry.song || entry);
          await shuffleSongsIntoQueue(candidateSongs, { maxItems: 20 });
        }, { button: shuffleBtn })
      );
    }
    const openArtistBtn = el.searchFeaturedArtist.querySelector('[data-ytm-action="open-artist"]');
    if (openArtistBtn) {
      openArtistBtn.addEventListener(
        "click",
        safeAsyncAction(async () => {
          await openArtistDetail(featured.name);
        }, { button: openArtistBtn })
      );
    }
    const followArtistBtn = el.searchFeaturedArtist.querySelector('[data-ytm-action="follow-artist"]');
    if (followArtistBtn) {
      followArtistBtn.addEventListener(
        "click",
        safeAsyncAction(async () => {
          await saveArtistToLibrary(featured.name);
        }, { button: followArtistBtn })
      );
    }
    const shareArtistBtn = el.searchFeaturedArtist.querySelector('[data-ytm-action="share-artist"]');
    if (shareArtistBtn) {
      shareArtistBtn.addEventListener(
        "click",
        safeAsyncAction(async () => {
          await shareArtist(featured.name);
        }, { button: shareArtistBtn })
      );
    }
  }


  const quickSongs = state.searchResults.length > 0
    ? state.searchResults.slice(0, 4)
    : state.recommendations.map((entry) => entry.song || entry).slice(0, 4);

  if (quickSongs.length === 0) {
    renderEmpty(el.searchQuickPicks, "No quick picks yet.");
    return;
  }
  el.searchQuickPicks.innerHTML = `<div class="ytm-quick-pick-title">Quick picks</div>`;
  for (const song of quickSongs) {
    const artworkUrl = resolveArtworkUrl(song.artwork_url);
    const durationLabel = Number(song.duration_ms || 0) > 0 ? formatDuration(song.duration_ms) : "Preview";
    const row = document.createElement("article");
    row.className = "ytm-quick-item";
    row.innerHTML = `
      <div class="ytm-quick-artwork">
        ${
          artworkUrl
            ? `<img src="${artworkUrl}" alt="Song artwork" loading="lazy" referrerpolicy="no-referrer">`
            : artworkFallbackMarkup(song)
        }
      </div>
      <div class="ytm-quick-copy">
        <div class="ytm-quick-song">${song.title || "Unknown"}</div>
        <div class="ytm-quick-meta">Song • ${song.artist || "Unknown artist"} • ${durationLabel}</div>
      </div>
    `;
    row.addEventListener(
      "click",
      safeAsyncAction(async () => {
        await playSong(song);
      })
    );
    el.searchQuickPicks.appendChild(row);
  }
}

function switchArtistDetailTab(tabName) {
  const isSongsTab = tabName === "songs";
  state.artistDetailTab = isSongsTab ? "songs" : "albums";
  el.artistSongsSection?.classList.remove("hidden");
  el.artistAlbumsSection?.classList.remove("hidden");
  el.artistTracksSection?.classList.remove("hidden");
  el.artistSongsSection?.classList.toggle("active", isSongsTab);
  el.artistAlbumsSection?.classList.toggle("active", !isSongsTab);
  el.artistSongsTabBtn?.classList.toggle("active", isSongsTab);
  el.artistAlbumsTabBtn?.classList.toggle("active", !isSongsTab);
}

function collectSearchArtistCandidates(limit = 5) {
  const safeLimit = Math.max(1, Number(limit || 5));
  const names = [];
  for (const item of state.topArtists.slice(0, safeLimit)) {
    const artistName = String(item.artist || "").trim();
    if (artistName) {
      names.push(artistName);
    }
  }
  for (const song of state.searchResults) {
    const artistName = String(song.artist || "").trim();
    if (artistName) {
      names.push(artistName);
    }
    if (names.length >= safeLimit * 2) {
      break;
    }
  }
  const uniqueByNormalized = [];
  const seen = new Set();
  for (const name of names) {
    const normalized = normalizeText(name);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    uniqueByNormalized.push({ name, normalized });
    if (uniqueByNormalized.length >= safeLimit) {
      break;
    }
  }
  return uniqueByNormalized;
}

function isArtistNameVerifiedFromSearch(artistName, limit = 5) {
  const normalizedArtist = normalizeText(artistName || "");
  if (!normalizedArtist) {
    return false;
  }
  const candidates = collectSearchArtistCandidates(limit);
  if (!candidates.length) {
    return true;
  }
  return candidates.some((item) => item.normalized === normalizedArtist);
}

function isArtistNameVerifiedFromDetailData(artistName) {
  const normalizedArtist = normalizeText(artistName || "");
  if (!normalizedArtist) {
    return false;
  }
  const byArtistMatch = (value) => normalizeText(value || "") === normalizedArtist;
  const hasSongMatch = state.artistDetailResults.some((song) => byArtistMatch(song.artist));
  if (hasSongMatch) {
    return true;
  }
  const hasAlbumMatch = state.artistAlbums.some((album) => byArtistMatch(album.artist || state.selectedArtistName));
  return hasAlbumMatch;
}

function isBlockedArtistArtworkUrl(artworkUrl) {
  const safeUrl = resolveArtworkUrl(artworkUrl);
  if (!safeUrl) {
    return false;
  }
  return state.failedArtistArtworkUrls.has(safeUrl);
}

/** Prefer artwork already shown in library/search so the detail hero matches list cards. */
function pickArtistDetailArtworkUrl(apiRawUrl, artistName) {
  const artistKey = normalizeText(String(artistName || "").trim());
  const cachedUrl = artistKey ? resolveArtworkUrl(state.artistArtworkCache.get(artistKey) || "") : "";
  if (cachedUrl && !isBlockedArtistArtworkUrl(cachedUrl)) {
    return cachedUrl;
  }
  const apiUrl = resolveArtworkUrl(apiRawUrl || "");
  if (artistKey && apiUrl && !isBlockedArtistArtworkUrl(apiUrl)) {
    state.artistArtworkCache.set(artistKey, apiUrl);
  }
  return apiUrl;
}

function resolveArtistDetailArtwork() {
  const selectedArtistName = String(state.selectedArtistName || "").trim();
  const selectedArtistKey = normalizeText(selectedArtistName);
  const cachedArtworkUrl = selectedArtistKey ? resolveArtworkUrl(state.artistArtworkCache.get(selectedArtistKey) || "") : "";
  if (cachedArtworkUrl && !isBlockedArtistArtworkUrl(cachedArtworkUrl)) {
    return cachedArtworkUrl;
  }
  const fixedArtworkUrl = resolveArtworkUrl(state.artistDetailArtworkUrl || "");
  if (fixedArtworkUrl && !isBlockedArtistArtworkUrl(fixedArtworkUrl)) {
    if (selectedArtistKey) {
      state.artistArtworkCache.set(selectedArtistKey, fixedArtworkUrl);
    }
    return fixedArtworkUrl;
  }
  const selectedArtist = selectedArtistKey;
  if (!selectedArtist) {
    return "";
  }
  const verifiedBySearch = isArtistNameVerifiedFromSearch(selectedArtistName, 5);
  const verifiedByDetailData = isArtistNameVerifiedFromDetailData(selectedArtistName);
  if (!verifiedBySearch && !verifiedByDetailData) {
    return "";
  }
  const byArtistMatch = (artistName) => normalizeText(artistName || "") === selectedArtist;

  if (verifiedBySearch) {
    const topArtistMatch = state.topArtists
      .slice(0, 5)
      .find((item) => byArtistMatch(item.artist) && resolveArtworkUrl(item.artwork_url));
    if (topArtistMatch) {
      const topArtworkUrl = resolveArtworkUrl(topArtistMatch.artwork_url);
      if (topArtworkUrl && !isBlockedArtistArtworkUrl(topArtworkUrl)) {
        state.artistArtworkCache.set(selectedArtist, topArtworkUrl);
        return topArtworkUrl;
      }
    }

    const songMatch = state.searchResults.find(
      (song) => byArtistMatch(song.artist) && resolveArtworkUrl(song.artwork_url)
    );
    if (songMatch) {
      const songArtworkUrl = resolveArtworkUrl(songMatch.artwork_url);
      if (songArtworkUrl && !isBlockedArtistArtworkUrl(songArtworkUrl)) {
        state.artistArtworkCache.set(selectedArtist, songArtworkUrl);
        return songArtworkUrl;
      }
    }
  }

  const detailMatch = state.artistDetailResults.find(
    (song) => byArtistMatch(song.artist) && resolveArtworkUrl(song.artwork_url)
  );
  if (detailMatch) {
    const detailArtworkUrl = resolveArtworkUrl(detailMatch.artwork_url);
    if (detailArtworkUrl && !isBlockedArtistArtworkUrl(detailArtworkUrl)) {
      state.artistArtworkCache.set(selectedArtist, detailArtworkUrl);
      return detailArtworkUrl;
    }
  }

  const albumMatch = state.artistAlbums.find(
    (album) => byArtistMatch(album.artist || state.selectedArtistName) && resolveArtworkUrl(album.artwork_url)
  );
  if (albumMatch) {
    const albumArtworkUrl = resolveArtworkUrl(albumMatch.artwork_url);
    if (albumArtworkUrl && !isBlockedArtistArtworkUrl(albumArtworkUrl)) {
      state.artistArtworkCache.set(selectedArtist, albumArtworkUrl);
      return albumArtworkUrl;
    }
  }

  return "";
}

function resolveStableArtistArtworkUrl(artistName, fallbackArtworkUrl = "") {
  const artistKey = normalizeText(artistName || "");
  const cachedArtworkUrl = artistKey ? resolveArtworkUrl(state.artistArtworkCache.get(artistKey) || "") : "";
  if (cachedArtworkUrl && !isBlockedArtistArtworkUrl(cachedArtworkUrl)) {
    return cachedArtworkUrl;
  }
  const resolvedFallback = resolveArtworkUrl(fallbackArtworkUrl);
  if (resolvedFallback && !isBlockedArtistArtworkUrl(resolvedFallback)) {
    if (artistKey) {
      state.artistArtworkCache.set(artistKey, resolvedFallback);
    }
    return resolvedFallback;
  }
  return "";
}

function showArtistDetailPhotoFallback() {
  if (!el.artistDetailPhoto || !el.artistDetailPhotoFallback) {
    return;
  }
  const artistName = state.selectedArtistName || "Artist";
  el.artistDetailPhoto.removeAttribute("src");
  el.artistDetailPhoto.style.display = "none";
  el.artistDetailPhotoFallback.classList.remove("hidden");
  el.artistDetailPhotoFallback.textContent = artworkFallbackText({ title: artistName, artist: artistName });
}

function bindArtistDetailPhotoErrorHandler() {
  if (!el.artistDetailPhoto) {
    return;
  }
  if (el.artistDetailPhoto.dataset.errorBound === "1") {
    return;
  }
  el.artistDetailPhoto.addEventListener("error", () => {
    const failedUrl = resolveArtworkUrl(el.artistDetailPhoto.currentSrc || el.artistDetailPhoto.src);
    if (failedUrl) {
      state.failedArtistArtworkUrls.add(failedUrl);
    }
    showArtistDetailPhotoFallback();
  });
  el.artistDetailPhoto.dataset.errorBound = "1";
}

function renderArtistDetailHeader() {
  const artistName = state.selectedArtistName || "Artist";
  el.artistDetailTitle.textContent = artistName;
  const infoBits = [];
  if (state.artistDetailSource === "itunes") {
    infoBits.push("Source: iTunes");
  } else {
    infoBits.push("Source: Fallback");
  }
  const songTotal = Number(state.artistSongsTotalAvailable) || state.artistDetailResults.length;
  infoBits.push(`Songs: ${songTotal}`);
  infoBits.push(`Albums: ${state.artistAlbums.length}`);
  el.artistDetailMeta.textContent = infoBits.join(" | ");

  bindArtistDetailPhotoErrorHandler();
  const artworkUrl = resolveArtistDetailArtwork();
  if (el.artistDetailPhoto && el.artistDetailPhotoFallback) {
    if (artworkUrl) {
      el.artistDetailPhoto.src = artworkUrl;
      el.artistDetailPhoto.style.display = "block";
      el.artistDetailPhotoFallback.classList.add("hidden");
    } else {
      showArtistDetailPhotoFallback();
    }
  }
}

function getArtistDetailFilterQuery() {
  return normalizeSearchQuery(state.artistDetailFilterQuery || "").toLocaleLowerCase("tr");
}

function matchesArtistDetailFilter(songOrAlbum, filterQuery) {
  if (!filterQuery) {
    return true;
  }
  const title = String(songOrAlbum.title || "").toLocaleLowerCase("tr");
  const artist = String(songOrAlbum.artist || "").toLocaleLowerCase("tr");
  const album = String(songOrAlbum.album || "").toLocaleLowerCase("tr");
  return title.includes(filterQuery) || artist.includes(filterQuery) || album.includes(filterQuery);
}

function isMobileViewport() {
  return window.matchMedia("(max-width: 768px)").matches;
}

const ARTIST_PAGE_SIZE = 4;
/** Must stay in sync with analytics /artist-detail songs_limit max (le=10_000). */
const ARTIST_DETAIL_SONGS_MAX = 10_000;
/** First paint: fast iTunes lookup only, then full catalog after delay. */
const ARTIST_DETAIL_INITIAL_SONGS = 50;
const ARTIST_DETAIL_FULL_CATALOG_DELAY_MS = 5000;

function updateArtistSongsPageNav(filteredCount) {
  const nav = document.getElementById("artistSongsPageNav");
  const info = document.getElementById("artistSongsPageInfo");
  const prevBtn = document.getElementById("artistSongsPrevBtn");
  const nextBtn = document.getElementById("artistSongsNextBtn");
  if (!nav) return;
  if (!isMobileViewport() || filteredCount <= ARTIST_PAGE_SIZE) {
    nav.style.display = "none";
    return;
  }
  nav.style.display = "flex";
  const totalPages = Math.ceil(filteredCount / ARTIST_PAGE_SIZE);
  const page = state.artistSongsPage;
  if (info) info.textContent = `${page + 1} / ${totalPages}`;
  if (prevBtn) prevBtn.disabled = page <= 0;
  if (nextBtn) nextBtn.disabled = page >= totalPages - 1;
}

function updateArtistAlbumsPageNav(filteredCount) {
  const nav = document.getElementById("artistAlbumsPageNav");
  const info = document.getElementById("artistAlbumsPageInfo");
  const prevBtn = document.getElementById("artistAlbumsPrevBtn");
  const nextBtn = document.getElementById("artistAlbumsNextBtn");
  if (!nav) return;
  if (!isMobileViewport() || filteredCount <= ARTIST_PAGE_SIZE) {
    nav.style.display = "none";
    return;
  }
  nav.style.display = "flex";
  const totalPages = Math.ceil(filteredCount / ARTIST_PAGE_SIZE);
  const page = state.artistAlbumsPage;
  if (info) info.textContent = `${page + 1} / ${totalPages}`;
  if (prevBtn) prevBtn.disabled = page <= 0;
  if (nextBtn) nextBtn.disabled = page >= totalPages - 1;
}

function changeArtistSongsPage(delta) {
  const filterQuery = getArtistDetailFilterQuery();
  const filteredSongs = state.artistDetailResults.filter((song) => matchesArtistDetailFilter(song, filterQuery));
  const totalPages = Math.ceil(filteredSongs.length / ARTIST_PAGE_SIZE);
  const newPage = state.artistSongsPage + delta;
  if (newPage < 0 || newPage >= totalPages) return;
  state.artistSongsSlideDir = delta > 0 ? "right" : "left";
  state.artistSongsPage = newPage;
  renderArtistDetailSongs();
}

function changeArtistAlbumsPage(delta) {
  const filterQuery = getArtistDetailFilterQuery();
  const filteredAlbums = state.artistAlbums.filter((album) => matchesArtistDetailFilter(album, filterQuery));
  const totalPages = Math.ceil(filteredAlbums.length / ARTIST_PAGE_SIZE);
  const newPage = state.artistAlbumsPage + delta;
  if (newPage < 0 || newPage >= totalPages) return;
  state.artistAlbumsSlideDir = delta > 0 ? "right" : "left";
  state.artistAlbumsPage = newPage;
  renderArtistAlbums();
}

function renderArtistDetailSongs() {
  const filterQuery = getArtistDetailFilterQuery();
  const filteredSongs = state.artistDetailResults.filter((song) => matchesArtistDetailFilter(song, filterQuery));
  if (state.artistDetailResults.length === 0) {
    renderEmpty(el.artistDetailResults, "No songs found for this artist.");
    updateArtistSongsPageNav(0);
  } else if (filteredSongs.length === 0) {
    renderEmpty(el.artistDetailResults, "No songs match your filter.");
    updateArtistSongsPageNav(0);
  } else {
    const mobile = isMobileViewport();
    let songsToRender = filteredSongs;
    if (mobile && filteredSongs.length > ARTIST_PAGE_SIZE) {
      const totalPages = Math.ceil(filteredSongs.length / ARTIST_PAGE_SIZE);
      if (state.artistSongsPage >= totalPages) state.artistSongsPage = totalPages - 1;
      if (state.artistSongsPage < 0) state.artistSongsPage = 0;
      const start = state.artistSongsPage * ARTIST_PAGE_SIZE;
      songsToRender = filteredSongs.slice(start, start + ARTIST_PAGE_SIZE);
    }
    // Apply slide animation
    const slideDir = state.artistSongsSlideDir;
    if (mobile && slideDir) {
      el.artistDetailResults.classList.remove("artist-slide-left", "artist-slide-right");
      void el.artistDetailResults.offsetWidth; // force reflow
      el.artistDetailResults.classList.add(slideDir === "right" ? "artist-slide-right" : "artist-slide-left");
      state.artistSongsSlideDir = "";
    } else {
      el.artistDetailResults.classList.remove("artist-slide-left", "artist-slide-right");
    }
    el.artistDetailResults.innerHTML = "";
    for (const song of songsToRender) {
      const relation = song.id ? state.songRelationsCache.get(song.id) || null : null;
      el.artistDetailResults.appendChild(
        buildSongItem(song, {
          onFavorite: addFavoriteFromSong,
          favoriteLabel: "Add Favorite",
          onPlaylistAdd: addSongToPlaylist,
          relation,
        })
      );
    }
    updateArtistSongsPageNav(filteredSongs.length);
  }
  const canLoadMore =
    (state.artistSongsTotalAvailable > state.artistDetailResults.length &&
      state.artistSongsLimit < ARTIST_DETAIL_SONGS_MAX) ||
    !state.artistDetailCatalogComplete;
  el.artistSongsLoadMoreBtn.classList.toggle("hidden", !canLoadMore || Boolean(filterQuery));
}

function renderArtistAlbums() {
  const filterQuery = getArtistDetailFilterQuery();
  const filteredAlbums = state.artistAlbums.filter((album) => matchesArtistDetailFilter(album, filterQuery));
  if (state.artistAlbums.length === 0) {
    renderEmpty(el.artistAlbumsList, "No albums found for this artist.");
    el.artistAlbumTracksTitle.classList.add("hidden");
    renderEmpty(el.artistAlbumTracksList, "Select an album to list tracks.");
    updateArtistAlbumsPageNav(0);
    return;
  }
  if (filteredAlbums.length === 0) {
    renderEmpty(el.artistAlbumsList, "No albums match your filter.");
    updateArtistAlbumsPageNav(0);
    return;
  }
  const mobile = isMobileViewport();
  let albumsToRender = filteredAlbums;
  if (mobile && filteredAlbums.length > ARTIST_PAGE_SIZE) {
    const totalPages = Math.ceil(filteredAlbums.length / ARTIST_PAGE_SIZE);
    if (state.artistAlbumsPage >= totalPages) state.artistAlbumsPage = totalPages - 1;
    if (state.artistAlbumsPage < 0) state.artistAlbumsPage = 0;
    const start = state.artistAlbumsPage * ARTIST_PAGE_SIZE;
    albumsToRender = filteredAlbums.slice(start, start + ARTIST_PAGE_SIZE);
  }
  // Apply slide animation
  const slideDir = state.artistAlbumsSlideDir;
  if (mobile && slideDir) {
    el.artistAlbumsList.classList.remove("artist-slide-left", "artist-slide-right");
    void el.artistAlbumsList.offsetWidth;
    el.artistAlbumsList.classList.add(slideDir === "right" ? "artist-slide-right" : "artist-slide-left");
    state.artistAlbumsSlideDir = "";
  } else {
    el.artistAlbumsList.classList.remove("artist-slide-left", "artist-slide-right");
  }
  el.artistAlbumsList.innerHTML = "";
  for (const album of albumsToRender) {
    const albumCollectionId = getAlbumCollectionId(album);
    const albumTitle = getAlbumDisplayTitle(album);
    const albumArtist = getAlbumDisplayArtist(album);
    const artworkUrl = resolveArtworkUrl(album.artwork_url);
    const row = document.createElement("article");
    row.className = "list-item artist-album-row";
    row.classList.add("clickable");
    row.classList.toggle(
      "active",
      state.selectedArtistAlbum && getAlbumCollectionId(state.selectedArtistAlbum) === albumCollectionId
    );
    row.innerHTML = `
      <div class="artist-album-main">
        <div class="artist-album-artwork">
          ${
            artworkUrl
              ? `<img src="${artworkUrl}" alt="${albumTitle} artwork" loading="lazy" referrerpolicy="no-referrer">`
              : artworkFallbackMarkup({ title: albumTitle, artist: albumArtist })
          }
        </div>
        <div class="artist-album-content">
          <div class="song-title">${albumTitle}</div>
          <div class="song-meta">${albumArtist}</div>
          <div class="song-meta">${Number(album.track_count || 0)} tracks</div>
        </div>
      </div>
      <div class="item-actions"></div>
    `;
    const artworkContainer = row.querySelector(".artist-album-artwork");
    const artworkImage = artworkContainer ? artworkContainer.querySelector("img") : null;
    if (artworkContainer && artworkImage) {
      artworkImage.addEventListener("error", () => {
        artworkContainer.innerHTML = artworkFallbackMarkup({ title: albumTitle, artist: albumArtist });
      });
    }
    const actions = row.querySelector(".item-actions");
    const openBtn = document.createElement("button");
    openBtn.className = "btn ghost";
    openBtn.type = "button";
    openBtn.textContent = "Show Tracks";
    openBtn.addEventListener(
      "click",
      safeAsyncAction((event) => {
        event?.stopPropagation();
        return openArtistAlbum(album, { anchorElement: openBtn });
      }, { button: openBtn })
    );
    actions.appendChild(openBtn);
    const saveAlbumBtn = document.createElement("button");
    saveAlbumBtn.className = "btn ghost";
    saveAlbumBtn.type = "button";
    saveAlbumBtn.textContent = "Save Album";
    saveAlbumBtn.addEventListener(
      "click",
      safeAsyncAction((event) => {
        event?.stopPropagation();
        return saveAlbumToLibrary(albumTitle, albumArtist);
      }, { button: saveAlbumBtn })
    );
    actions.appendChild(saveAlbumBtn);
    const shareAlbumBtn = document.createElement("button");
    shareAlbumBtn.className = "btn ghost icon-btn btn-share";
    shareAlbumBtn.type = "button";
    shareAlbumBtn.innerHTML = '<i class="material-icons">share</i>';
    shareAlbumBtn.title = "Share album";
    shareAlbumBtn.setAttribute("aria-label", "Share album");
    shareAlbumBtn.addEventListener(
      "click",
      safeAsyncAction((event) => {
        event?.stopPropagation();
        return shareAlbum({
          collection_id: albumCollectionId,
          title: albumTitle,
          artist: albumArtist,
        });
      }, { button: shareAlbumBtn }),
    );
    actions.appendChild(shareAlbumBtn);
    const playAlbumBtn = document.createElement("button");
    playAlbumBtn.className = "btn primary";
    playAlbumBtn.type = "button";
    playAlbumBtn.innerHTML = '<i class="material-icons" style="font-size:16px;vertical-align:middle;margin-right:3px">play_arrow</i>Play Album';
    playAlbumBtn.addEventListener(
      "click",
      safeAsyncAction((event) => {
        event?.stopPropagation();
        return playAlbum(album, { button: playAlbumBtn });
      }, { button: playAlbumBtn })
    );
    actions.appendChild(playAlbumBtn);
    row.addEventListener("click", (event) => {
      if (event.target instanceof HTMLElement && event.target.closest("button, select, input, a")) {
        return;
      }
      void safeAsyncAction(() => openArtistAlbum(album, { anchorElement: row }))();
    });
    el.artistAlbumsList.appendChild(row);
  }
  updateArtistAlbumsPageNav(filteredAlbums.length);
}

function renderArtistAlbumTracks() {
  if (!state.selectedArtistAlbum) {
    el.artistAlbumTracksTitle.classList.add("hidden");
    renderEmpty(el.artistAlbumTracksList, "Select an album to list tracks.");
    return;
  }
  el.artistAlbumTracksTitle.classList.remove("hidden");
  el.artistAlbumTracksTitle.textContent = `Album Tracks: ${getAlbumDisplayTitle(state.selectedArtistAlbum)}`;
  if (state.artistAlbumTracks.length === 0) {
    renderEmpty(el.artistAlbumTracksList, "No tracks found for this album.");
    return;
  }
  el.artistAlbumTracksList.innerHTML = "";
  for (const track of state.artistAlbumTracks) {
    const trackRow = buildSongItem(track, {
      onFavorite: addFavoriteFromSong,
      favoriteLabel: "Add Favorite",
      onPlaylistAdd: addSongToPlaylist,
      relation: null,
    });
    trackRow.classList.add("clickable");
    trackRow.addEventListener("click", (event) => {
      if (event.target instanceof HTMLElement && event.target.closest("button, select, input, a")) {
        return;
      }
      if (!track.preview_url && !(track.is_local === true && track.id && track.file_path)) {
        showFlash("This track has no preview/playable source.", true);
        return;
      }
      void safeAsyncAction(async () => {
        await playSong(track);
      })();
    });
    el.artistAlbumTracksList.appendChild(trackRow);
  }
  if (el.artistAlbumTracksList) {
    el.artistAlbumTracksList.scrollTop = 0;
  }
}

function focusArtistTracksPanel(anchorElement) {
  const targetTitle = el.artistAlbumTracksTitle;
  const firstTrack = el.artistAlbumTracksList?.querySelector(".list-item");
  const target = firstTrack || targetTitle || el.artistTracksSection;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  if (anchorElement instanceof HTMLElement) {
    anchorElement.blur();
  }
  const scrollBehavior = prefersReducedMotion() ? "auto" : "smooth";
  const scrollBlock = isCompactViewport() ? "nearest" : "start";
  window.requestAnimationFrame(() => {
    target.scrollIntoView({ behavior: scrollBehavior, block: scrollBlock, inline: "nearest" });
  });
}

function renderArtistDetailResults() {
  renderArtistDetailHeader();
  renderArtistDetailSongs();
  renderArtistAlbums();
  renderArtistAlbumTracks();
}

function renderSearchArtistRail() {
  if (state.topArtists.length === 0) {
    el.searchArtistRail.innerHTML = "<div class='empty'>No artists yet.</div>";
    renderSearchShowcase();
    applySearchFilterVisibility();
    return;
  }

  el.searchArtistRail.innerHTML = "";
  for (const artistItem of state.topArtists) {
    const artistName = String(artistItem.artist || "Unknown artist");
    const score = Number(artistItem.score || 0);
    const source = String(artistItem.source || "");
    const reasonText = String(artistItem.reason || "").trim();
    const sourceText = source === "personal" ? "For you" : source === "trending" ? "Trending in Turkiye" : "";
    const reasonKey = reasonText.toLowerCase();
    const sourceKey = sourceText.toLowerCase();
    const dedupedReasonText = reasonKey && reasonKey === sourceKey ? "" : reasonText;
    const metaText = [dedupedReasonText, sourceText, source === "personal" && score > 0 ? `${score} plays` : ""]
      .filter(Boolean)
      .join(" | ");
    const artworkUrl = resolveStableArtistArtworkUrl(artistName, artistItem.artwork_url);
    const card = document.createElement("article");
    card.className = "artist-rail-card";
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", `${artistName} songs`);
    card.innerHTML = `
      <div class="artist-rail-artwork">
        ${
          artworkUrl
            ? `<img src="${artworkUrl}" alt="${artistName} artwork" loading="lazy" referrerpolicy="no-referrer">`
            : artworkFallbackMarkup({ title: artistName, artist: artistName })
        }
      </div>
      <div class="artist-rail-name">${artistName}</div>
      <div class="artist-rail-meta">${metaText || "Popular artist"}</div>
      <div class="artist-rail-actions">
        <button class="btn" type="button" data-action="open">Show Songs</button>
        <button class="btn ghost icon-btn btn-share" type="button" data-action="share" title="Share Artist">
          <i class="material-icons">share</i>
        </button>
      </div>

    `;
    const artworkContainer = card.querySelector(".artist-rail-artwork");
    const artworkImage = artworkContainer ? artworkContainer.querySelector("img") : null;
    if (artworkContainer && artworkImage) {
      artworkImage.addEventListener("error", () => {
        artworkContainer.innerHTML = artworkFallbackMarkup({ title: artistName, artist: artistName });
      });
    }

    const openArtist = safeAsyncAction(async () => {
      el.searchQuery.value = artistName;
      await openArtistDetail(artistName);
    });

    card.addEventListener("click", (event) => {
      if (event.target instanceof HTMLElement && event.target.closest("button")) {
        return;
      }
      void openArtist();
    });
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        void openArtist();
      }
    });

    const openBtn = card.querySelector('[data-action="open"]');
    if (openBtn) {
      openBtn.addEventListener(
        "click",
        (event) => {
          event.stopPropagation();
          void safeAsyncAction(async () => {
            el.searchQuery.value = artistName;
            await openArtistDetail(artistName);
          }, { button: openBtn })();
        }
      );
    }
    const shareBtn = card.querySelector('[data-action="share"]');
    if (shareBtn) {
      shareBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        void safeAsyncAction(() => shareArtist(artistName), { button: shareBtn })();
      });
    }

    el.searchArtistRail.appendChild(card);
  }
  renderSearchShowcase();
  applySearchFilterVisibility();
}

function renderSearchRecommendationRail() {
  if (state.recommendations.length === 0) {
    el.searchRecommendationRail.innerHTML =
      "<div class='empty'>No recommendations yet. Listen to music or save favorites so we can suggest similar tracks.</div>";
    renderSearchShowcase();
    applySearchFilterVisibility();
    return;
  }
  el.searchRecommendationRail.innerHTML = "";
  const recommendationSongs = state.recommendations.map((entry) => entry.song || entry);
  for (const song of recommendationSongs) {
    const card = document.createElement("article");
    card.className = "recommendation-rail-card";
    const artworkUrl = resolveArtworkUrl(song.artwork_url);
    card.innerHTML = `
      <div class="recommendation-rail-artwork">
        ${
          artworkUrl
            ? `<img src="${artworkUrl}" alt="Song artwork" loading="lazy" referrerpolicy="no-referrer">`
            : artworkFallbackMarkup(song)
        }
      </div>
      <div class="recommendation-rail-title">${song.title || "Unknown"}</div>
      <div class="recommendation-rail-artist">${song.artist || "Unknown artist"}</div>
      <div class="recommendation-rail-actions">
        <button class="btn" type="button" data-action="play">Play</button>
        <button class="btn ghost icon-btn btn-share" type="button" data-action="share" title="Share Song">
          <i class="material-icons">share</i>
        </button>
      </div>

    `;
    const artworkContainer = card.querySelector(".recommendation-rail-artwork");
    const artworkImage = artworkContainer ? artworkContainer.querySelector("img") : null;
    if (artworkContainer && artworkImage) {
      artworkImage.addEventListener("error", () => {
        artworkContainer.innerHTML = artworkFallbackMarkup(song);
      });
    }
    const playBtn = card.querySelector('[data-action="play"]');
    if (playBtn) {
      playBtn.addEventListener(
        "click",
        safeAsyncAction(async () => {
          await playSong(song);
        }, { button: playBtn })
      );
    }
    const shareBtn = card.querySelector('[data-action="share"]');
    if (shareBtn) {
      shareBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        void safeAsyncAction(() => shareSong(song), { button: shareBtn })();
      });
    }

    el.searchRecommendationRail.appendChild(card);
  }
  renderSearchShowcase();
  applySearchFilterVisibility();
}

function renderFavorites() {
  if (state.favorites.length === 0) {
    renderEmpty(el.favoriteList, "No favorites yet.");
    return;
  }
  el.favoriteList.innerHTML = "";
  for (const song of state.favorites) {
    el.favoriteList.appendChild(
      buildSongItem(song, {
        onRemove: removeFavorite,
        removeLabel: "Remove Favorite",
      })
    );
  }
}

function renderHistory() {
  const items = filteredHistoryItems();
  if (items.length === 0) {
    renderEmpty(el.historyList, "No listening history yet.");
    el.historyStats.textContent = "0 plays in current filter.";
    return;
  }
  const totalMs = items.reduce((sum, item) => sum + (item.listened_duration_ms || 0), 0);
  el.historyStats.textContent = `${items.length} plays | Total listened ${formatLargeDuration(totalMs)} (${formatDuration(totalMs)})`;
  el.historyList.innerHTML = "";
  for (const item of items) {
    const song = item.song || null;
    const title = song?.title || item.track_title || (item.song_id ? `Song ID #${item.song_id}` : "Unknown track");
    const artist = song?.artist || item.track_artist || "Unknown artist";
    const sourceType = sourceTypeFromSong(song || item);
    const source = sourceType === "local" ? "LOCAL" : sourceType === "remote" ? "REMOTE" : "ITUNES";
    const row = document.createElement("article");
    row.className = "list-item";
    row.innerHTML = `
      <div class="song-title">${title}</div>
      <div class="song-meta">${artist} - ${source}</div>
      <div class="song-meta">Played at ${new Date(item.listened_at).toLocaleString()}</div>
      <div class="song-meta">Listened ${formatDuration(item.listened_duration_ms)} (${item.listened_duration_ms} ms)</div>
      <div class="item-actions"></div>
    `;
    const actions = row.querySelector(".item-actions");
    const removeBtn = document.createElement("button");
    removeBtn.className = "btn ghost";
    removeBtn.type = "button";
    removeBtn.textContent = "Delete";
    removeBtn.addEventListener("click", safeAsyncAction(() => deleteHistoryItem(item.id), { button: removeBtn }));
    actions.appendChild(removeBtn);
    el.historyList.appendChild(row);
  }
}

async function fetchUserPublicPlaylistsByUsername(username, options = {}) {
  const safeUsername = String(username || "").trim();
  if (!safeUsername) {
    return [];
  }
  const cacheKey = safeUsername.toLocaleLowerCase("tr");
  if (!options.force && state.followingUserPlaylistsCache.has(cacheKey)) {
    return state.followingUserPlaylistsCache.get(cacheKey) || [];
  }
  const playlists = await request(`/users/${encodeURIComponent(safeUsername)}/playlists`);
  const normalized = Array.isArray(playlists) ? playlists : [];
  state.followingUserPlaylistsCache.set(cacheKey, normalized);
  return normalized;
}

function renderFollowingUserPlaylists() {
  if (!el.followingUserPlaylistsList || !el.followingUserPlaylistsMeta || !el.followingUserPlaylistsTitle) {
    return;
  }
  const username = String(state.selectedFollowingUsername || "").trim();
  if (!username) {
    el.followingUserPlaylistsTitle.textContent = "User Playlists";
    el.followingUserPlaylistsMeta.textContent = "Select a user to see their public playlists.";
    renderEmpty(el.followingUserPlaylistsList, "No user selected.");
    return;
  }
  el.followingUserPlaylistsTitle.textContent = `${username} playlists`;
  el.followingUserPlaylistsMeta.textContent = "Public playlists created by this user";
  if (!state.selectedFollowingUserPlaylists.length) {
    renderEmpty(el.followingUserPlaylistsList, "This user has no public playlists.");
    return;
  }
  el.followingUserPlaylistsList.innerHTML = "";
  for (const playlist of state.selectedFollowingUserPlaylists) {
    const row = buildPlaylistMenuRow(playlist, {
      metaText: `Owner: ${playlist.owner_username || username} • Public`,
      onOpen: () => openPublicPlaylist(playlist.id),
    });
    const actions = row.querySelector(".item-actions");
    const openBtn = document.createElement("button");
    openBtn.className = "btn";
    openBtn.type = "button";
    openBtn.textContent = "Open";
    openBtn.addEventListener(
      "click",
      (event) => {
        event.stopPropagation();
        void safeAsyncAction(() => openPublicPlaylist(playlist.id), { button: openBtn })();
      }
    );
    actions.appendChild(openBtn);
    el.followingUserPlaylistsList.appendChild(row);
  }
}

async function openFollowingUserPlaylists(user, options = {}) {
  const username = String(user?.username || "").trim();
  if (!username) {
    return;
  }
  state.selectedFollowingUsername = username;
  state.selectedFollowingUserPlaylists = await fetchUserPublicPlaylistsByUsername(username, { force: Boolean(options.force) });
  renderFollowingUsers();
  renderFollowingUserPlaylists();
}

function renderUserProfileView() {
  if (!el.userProfileTitle || !el.userProfileMeta || !el.userProfilePlaylistsList) {
    return;
  }
  const username = String(state.userProfileUsername || "").trim();
  if (!username) {
    el.userProfileTitle.textContent = "User Profile";
    el.userProfileMeta.textContent = "";
    renderEmpty(el.userProfilePlaylistsList, "No user selected.");
    return;
  }
  const followedAtText = state.userProfileFollowedAt
    ? `Followed at: ${new Date(state.userProfileFollowedAt).toLocaleString()}`
    : "Public user profile";
  const bioText = String(state.userProfileBio || "").trim();
  el.userProfileTitle.textContent = username;
  el.userProfileMeta.textContent = bioText ? `${followedAtText} | Bio: ${bioText}` : followedAtText;

  const avatarUrl = resolveProfileAvatarForUsername(username, state.userProfileAvatarUrl || "");
  if (el.userProfilePhoto && el.userProfilePhotoFallback) {
    if (el.userProfilePhoto.dataset.errorBound !== "1") {
      el.userProfilePhoto.addEventListener("error", () => {
        el.userProfilePhoto.removeAttribute("src");
        el.userProfilePhoto.style.display = "none";
        el.userProfilePhotoFallback.classList.remove("hidden");
      });
      el.userProfilePhoto.dataset.errorBound = "1";
    }
    if (avatarUrl) {
      el.userProfilePhoto.src = avatarUrl;
      el.userProfilePhoto.style.display = "block";
      el.userProfilePhoto.classList.remove("hidden");
      el.userProfilePhotoFallback.classList.add("hidden");
      el.userProfilePhotoFallback.textContent = username[0] ? username[0].toUpperCase() : "U";
    } else {
      el.userProfilePhoto.removeAttribute("src");
      el.userProfilePhoto.style.display = "none";
      el.userProfilePhoto.classList.add("hidden");
      el.userProfilePhotoFallback.classList.remove("hidden");
      el.userProfilePhotoFallback.textContent = username[0] ? username[0].toUpperCase() : "U";
    }
  }

  if (!state.userProfilePlaylists.length) {
    renderEmpty(el.userProfilePlaylistsList, "This user has no public playlists.");
    return;
  }
  el.userProfilePlaylistsList.innerHTML = "";
  for (const playlist of state.userProfilePlaylists) {
    const row = buildPlaylistMenuRow(playlist, {
      metaText: `Owner: ${playlist.owner_username || username} • Public`,
      onOpen: () => openPublicPlaylist(playlist.id),
    });
    const actions = row.querySelector(".item-actions");
    const openBtn = document.createElement("button");
    openBtn.className = "btn";
    openBtn.type = "button";
    openBtn.textContent = "Open";
    openBtn.addEventListener(
      "click",
      (event) => {
        event.stopPropagation();
        void safeAsyncAction(() => openPublicPlaylist(playlist.id), { button: openBtn })();
      }
    );
    actions.appendChild(openBtn);
    el.userProfilePlaylistsList.appendChild(row);
  }
}

async function openPublicUserProfile(user, options = {}) {
  const username = String(user?.username || "").trim();
  if (!username) {
    return;
  }
  state.userProfileBackView = String(options.backView || "followingUsersView");
  state.userProfileUsername = username;
  state.userProfileAvatarUrl = String(user?.avatar_url || "");
  state.userProfileBio = String(user?.bio || "");
  state.userProfileFollowedAt = user?.followed_at || "";
  state.userProfilePlaylists = await fetchUserPublicPlaylistsByUsername(username, { force: Boolean(options.force) });
  renderUserProfileView();
  switchView("userProfileView");
}

function renderFollowingUsers() {
  if (!el.followingUsersList) {
    return;
  }
  const hasSelectedUser = state.socialFollowingUsers.some(
    (item) => String(item.username || "").trim().toLocaleLowerCase("tr") ===
      String(state.selectedFollowingUsername || "").trim().toLocaleLowerCase("tr")
  );
  if (!hasSelectedUser) {
    state.selectedFollowingUsername = "";
    state.selectedFollowingUserPlaylists = [];
  }
  if (!state.socialFollowingUsers.length) {
    renderEmpty(el.followingUsersList, "You are not following any users yet.");
    renderFollowingUserPlaylists();
    return;
  }
  el.followingUsersList.innerHTML = "";
  for (const user of state.socialFollowingUsers) {
    const username = String(user.username || "Unknown user").trim();
    const followedAt = user.followed_at ? new Date(user.followed_at).toLocaleString() : "-";
    const avatarUrl = resolveProfileAvatarForUsername(username, user.avatar_url || "");
    const row = document.createElement("article");
    row.className = "list-item";
    row.classList.toggle(
      "active",
      username.toLocaleLowerCase("tr") === String(state.selectedFollowingUsername || "").toLocaleLowerCase("tr")
    );
    row.innerHTML = `
      <div class="song-item-main profile-row-main">
        <div class="profile-row-avatar">
          <img src="${avatarUrl}" alt="${username}">
        </div>
        <div class="song-content">
          <div class="song-title">${username}</div>
          <div class="song-meta">Followed at: ${followedAt}</div>
        </div>
      </div>
      <div class="item-actions"></div>
    `;
    row.addEventListener("click", () => {
      void safeAsyncAction(() => openPublicUserProfile(user, { backView: "followingUsersView" }), {})();
    });
    const actions = row.querySelector(".item-actions");
    const unfollowBtn = document.createElement("button");
    unfollowBtn.className = "btn ghost";
    unfollowBtn.type = "button";
    unfollowBtn.textContent = "Unfollow";
    unfollowBtn.addEventListener(
      "click",
      (event) => {
        event.stopPropagation();
        void safeAsyncAction(async () => {
          await setUserFollowStatus(user.user_id, false);
          renderFollowingUsers();
        }, { button: unfollowBtn })();
      }
    );
    actions.appendChild(unfollowBtn);
    el.followingUsersList.appendChild(row);
  }
  renderFollowingUserPlaylists();
}

function buildPlaylistMenuRow(playlist, options = {}) {
  const row = document.createElement("article");
  row.className = "list-item playlist-menu-item";
  row.setAttribute("title", "Open playlist");
  row.classList.toggle("active", Number(state.selectedPlaylistId) === Number(playlist.id));
  row.innerHTML = `
    <div class="song-title">${playlist.name || "Untitled playlist"}</div>
    <div class="song-meta">${playlist.description || "No description"}</div>
    <div class="song-meta">${options.metaText || ""}</div>
    <div class="item-actions"></div>
  `;
  row.addEventListener(
    "click",
    safeAsyncAction(async () => {
      if (options.onOpen) {
        await options.onOpen();
      }
    })
  );
  return row;
}

function renderPlaylists() {
  if (state.playlists.length === 0) {
    renderEmpty(el.playlistList, "No playlists yet.");
    return;
  }

  el.playlistList.innerHTML = "";
  for (const playlist of state.playlists) {
    const row = buildPlaylistMenuRow(playlist, {
      metaText: `${playlist.is_public ? "Public" : "Private"} • Owner playlist`,
      onOpen: () => openPlaylist(playlist.id),
    });
    const actions = row.querySelector(".item-actions");
    actions.appendChild(
      buildRowOverflowMenu(
        [
          {
            label: "Rename",
            run: () => {
              void safeAsyncAction(() => renamePlaylist(playlist))();
            },
          },
          {
            label: "Duplicate",
            run: () => {
              void safeAsyncAction(() => duplicatePlaylist(playlist.id))();
            },
          },
          {
            label: playlist.is_public ? "Make private" : "Make public",
            run: () => {
              void safeAsyncAction(() => setPlaylistVisibility(playlist.id, !playlist.is_public))();
            },
          },
          {
            label: "Delete",
            danger: true,
            run: () => {
              void safeAsyncAction(() => deletePlaylist(playlist.id))();
            },
          },
        ],
        "Playlist actions",
      ),
    );

    el.playlistList.appendChild(row);
  }
}

function renderPlaylistDetail() {
  if (!state.selectedPlaylistDetail) {
    el.playlistDetailTitle.textContent = "Playlist Detail";
    el.playlistDetailMeta.textContent = "";
    if (el.playlistDetailActions) {
      el.playlistDetailActions.replaceChildren();
      el.playlistDetailActions.classList.add("hidden");
    }
    renderEmpty(el.playlistDetailSongs, "Select a playlist from the list.");
    return;
  }

  el.playlistDetailTitle.textContent = state.selectedPlaylistDetail.name || "Playlist";
  const syncBadge = state.selectedPlaylistIsOwned ? "Your playlist" : "Following (synced)";
  const updatedAt = new Date(state.selectedPlaylistDetail.updated_at).toLocaleString();
  el.playlistDetailMeta.textContent = `${state.selectedPlaylistDetail.owner_username || "Unknown"} · ${syncBadge} · Updated ${updatedAt}`;

  if (el.playlistDetailActions) {
    el.playlistDetailActions.classList.remove("hidden");
    el.playlistDetailActions.replaceChildren();
    const shareBtn = document.createElement("button");
    shareBtn.className = "btn ghost icon-btn btn-share";
    shareBtn.type = "button";
    shareBtn.setAttribute("aria-label", "Share playlist");
    shareBtn.title = "Share playlist";
    shareBtn.innerHTML = '<i class="material-icons">share</i>';
    shareBtn.addEventListener(
      "click",
      safeAsyncAction(() => sharePlaylist(state.selectedPlaylistDetail), { button: shareBtn }),
    );
    el.playlistDetailActions.appendChild(shareBtn);
  }

  if (state.selectedPlaylistDetail.songs.length === 0) {
    renderEmpty(el.playlistDetailSongs, "No songs in this playlist.");
    return;
  }

  el.playlistDetailSongs.innerHTML = "";
  for (const song of state.selectedPlaylistDetail.songs) {
    el.playlistDetailSongs.appendChild(
      buildSongItem(song, {
        compactSongRow: true,
        onRemove: state.selectedPlaylistIsOwned
          ? (selectedSong) => removeSongFromPlaylist(state.selectedPlaylistId, selectedSong.id)
          : undefined,
        removeLabel: "Remove from playlist",
        onMoveUp: state.selectedPlaylistIsOwned ? (selectedSong) => moveSongInSelectedPlaylist(selectedSong.id, -1) : undefined,
        onMoveDown: state.selectedPlaylistIsOwned ? (selectedSong) => moveSongInSelectedPlaylist(selectedSong.id, 1) : undefined,
      }),
    );
  }
}

function renderDiscoverPlaylists() {
  if (state.discoveredPlaylists.length === 0) {
    renderEmpty(el.discoverPlaylistList, "No public playlists found.");
    renderSearchCommunityPlaylists();
    applySearchFilterVisibility();
    return;
  }
  el.discoverPlaylistList.innerHTML = "";
  for (const playlist of state.discoveredPlaylists) {
    const row = buildPlaylistMenuRow(playlist, {
      metaText: `Owner: ${playlist.owner_username || "unknown"} • Public`,
      onOpen: () => openPublicPlaylist(playlist.id),
    });
    const actions = row.querySelector(".item-actions");
    actions.appendChild(
      buildRowOverflowMenu(
        [
          {
            label: playlist.is_followed ? "Unfollow" : "Follow",
            run: () => {
              void safeAsyncAction(() =>
                playlist.is_followed ? unfollowPlaylist(playlist.id) : followPlaylist(playlist.id),
              )();
            },
          },
          {
            label: "Follow owner",
            run: () => {
              void safeAsyncAction(() => followPlaylistOwner(playlist.user_id))();
            },
          },
        ],
        "Playlist actions",
      ),
    );
    el.discoverPlaylistList.appendChild(row);
  }
  renderSearchCommunityPlaylists();
  applySearchFilterVisibility();
}

function renderFollowingPlaylists() {
  if (state.followingPlaylists.length === 0) {
    renderEmpty(el.followingPlaylistList, "You are not following any playlists.");
    return;
  }
  el.followingPlaylistList.innerHTML = "";
  for (const playlist of state.followingPlaylists) {
    const row = buildPlaylistMenuRow(playlist, {
      metaText: `Owner: ${playlist.owner_username || "unknown"} • Live mirror`,
      onOpen: () => openPublicPlaylist(playlist.id),
    });
    const actions = row.querySelector(".item-actions");
    actions.appendChild(
      buildRowOverflowMenu(
        [
          {
            label: "Unfollow",
            danger: true,
            run: () => {
              void safeAsyncAction(() => unfollowPlaylist(playlist.id))();
            },
          },
        ],
        "Playlist actions",
      ),
    );
    el.followingPlaylistList.appendChild(row);
  }
}

function renderAnalyticsList(container, items, formatter, options = {}) {
  if (!items || items.length === 0) {
    renderEmpty(container, "Community playlist bulunamadi.");
    return;
  }
  container.innerHTML = "";
  for (const item of items) {
    const row = document.createElement("article");
    row.className = "list-item";
    row.innerHTML = formatter(item);
    if (typeof options.onItemClick === "function") {
      row.classList.add("clickable");
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      const onActivate = () => {
        void safeAsyncAction(() => options.onItemClick(item), {})();
      };
      row.addEventListener("click", onActivate);
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onActivate();
        }
      });
    }
    container.appendChild(row);
  }
}

function renderAnalytics() {
  if (!el.analyticsTopTracks || !el.analyticsTopGenres) {
    return;
  }
  renderAnalyticsList(
    el.analyticsTopTracks,
    state.analytics.topTracks,
    (item) => `
      <div class="song-content">
        <div class="song-title">${item.title}</div>
        <div class="song-meta">${item.artist} | ${item.plays} plays</div>
      </div>
      <div class="item-actions">
         <button class="btn ghost icon-btn btn-share" type="button" onclick="event.stopPropagation(); shareSong({id: ${item.id}, title: '${item.title.replace(/'/g, "\\'")}', artist: '${item.artist.replace(/'/g, "\\'")}'})">
           <i class="material-icons">share</i>
         </button>
      </div>
    `
  );
  renderAnalyticsList(
    el.analyticsTopGenres,
    state.analytics.topGenres,
    (item) => `
      <div class="song-content">
        <div class="song-title">${item.genre}</div>
        <div class="song-meta">${item.plays} plays</div>
      </div>
      <div class="item-actions">
         <button class="btn ghost icon-btn btn-share" type="button" onclick="event.stopPropagation(); shareArtist('${item.genre.replace(/'/g, "\\'")}')">
           <i class="material-icons">share</i>
         </button>
      </div>
    `
  );
}


async function searchSongs(query) {
  const normalizedQuery = normalizeSearchQuery(query);
  if (!normalizedQuery) {
    if (state.searchAbortController) {
      state.searchAbortController.abort();
      state.searchAbortController = null;
    }
    state.hasSearched = false;
    state.lastSearchQuery = "";
    state.searchSongVisibleLimit = SEARCH_SONGS_INITIAL_RENDER_CAP;
    state.selectedArtistName = "";
    state.searchRequestSeq += 1;
    state.searchResults = [];
    state.artistListenerArtistName = "";
    state.artistListenerProfiles = [];
    renderSearchResults();
    renderSearchProfiles();
    return;
  }
  if (normalizedQuery === state.lastSearchQuery) {
    return;
  }

  if (state.searchAbortController) {
    state.searchAbortController.abort();
  }
  const ac = new AbortController();
  state.searchAbortController = ac;

  state.hasSearched = true;
  const requestSeq = state.searchRequestSeq + 1;
  state.searchRequestSeq = requestSeq;

  let result;
  try {
    perfMark("yiro-search-fetch-start");
    result = await request(`/search?q=${encodeURIComponent(normalizedQuery)}`, { signal: ac.signal });
    perfMark("yiro-search-fetch-end");
    perfMeasure("yiro-search-fetch", "yiro-search-fetch-start", "yiro-search-fetch-end");
  } catch (error) {
    if (isAbortError(error)) {
      return;
    }
    throw error;
  } finally {
    if (state.searchAbortController === ac) {
      state.searchAbortController = null;
    }
  }

  if (requestSeq !== state.searchRequestSeq) {
    return;
  }
  state.searchSongVisibleLimit = SEARCH_SONGS_INITIAL_RENDER_CAP;
  state.lastSearchQuery = normalizedQuery;
  state.searchResults = result.songs || [];
  if (!state.selectedArtistName) {
    state.selectedArtistName = normalizeArtistQueryParam(resolveSearchProfilesArtistName());
  }
  renderSearchResults();
  void loadSearchProfilesForActiveArtist();

  const scheduleIdle = (cb) => {
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(() => cb(), { timeout: 2000 });
    } else {
      window.setTimeout(() => cb(), 0);
    }
  };
  scheduleIdle(async () => {
    if (requestSeq !== state.searchRequestSeq) {
      return;
    }
    await preloadSongRelations(state.searchResults);
    if (requestSeq !== state.searchRequestSeq) {
      return;
    }
    renderSearchResults();
  });
}

async function fetchArtistDetailSongs(artistName, songsLimit, options = {}) {
  const safeArtist = normalizeArtistQueryParam(artistName);
  if (!safeArtist) {
    throw new Error("Artist name is required.");
  }
  const safeLimit = Math.max(1, Math.min(ARTIST_DETAIL_SONGS_MAX, Number(songsLimit || ARTIST_DETAIL_SONGS_MAX)));
  const catalogDepth = options.catalogDepth === "fast" ? "fast" : "full";
  return request(
    `/analytics/artist-detail?artist=${encodeURIComponent(safeArtist)}&songs_limit=${safeLimit}&catalog_depth=${catalogDepth}`
  );
}

async function fetchArtistAlbums(artistName, limit = 100) {
  const safeArtist = normalizeArtistQueryParam(artistName);
  if (!safeArtist) {
    throw new Error("Artist name is required.");
  }
  const safeLimit = Math.max(1, Math.min(200, Number(limit || 100)));
  return request(
    `/analytics/artist-albums?artist=${encodeURIComponent(safeArtist)}&limit=${safeLimit}`
  );
}

async function ensureArtistDetailFullyLoaded() {
  const selectedArtistName = normalizeArtistQueryParam(state.selectedArtistName);
  if (!selectedArtistName) {
    return;
  }
  const willFetchSongs =
    !state.artistDetailCatalogComplete ||
    (state.artistSongsTotalAvailable > state.artistDetailResults.length &&
      state.artistSongsLimit < ARTIST_DETAIL_SONGS_MAX);
  const shouldLoadAllAlbums = state.artistAlbums.length >= 100;
  if (!willFetchSongs && !shouldLoadAllAlbums) {
    return;
  }
  if (willFetchSongs) {
    clearArtistFullCatalogSchedule();
  }
  const shouldLoadAllSongs = willFetchSongs;
  const requests = [];
  if (shouldLoadAllSongs) {
    requests.push(fetchArtistDetailSongs(selectedArtistName, ARTIST_DETAIL_SONGS_MAX, { catalogDepth: "full" }));
  } else {
    requests.push(Promise.resolve(null));
  }
  if (shouldLoadAllAlbums) {
    requests.push(fetchArtistAlbums(selectedArtistName, 200));
  } else {
    requests.push(Promise.resolve(null));
  }
  const [songsPayload, albumsPayload] = await Promise.all(requests);
  if (songsPayload) {
    state.artistSongsLimit = ARTIST_DETAIL_SONGS_MAX;
    state.artistDetailCatalogComplete = songsPayload.catalog_complete !== false;
    state.artistDetailSource = String(songsPayload.source || state.artistDetailSource || "fallback");
    state.artistDetailArtworkUrl = pickArtistDetailArtworkUrl(
      songsPayload.artist_artwork_url || state.artistDetailArtworkUrl || "",
      selectedArtistName,
    );
    state.artistDetailResults = songsPayload.songs || [];
    state.artistSongsTotalAvailable = Number(songsPayload.total_songs_available || state.artistDetailResults.length);
    await preloadSongRelations(state.artistDetailResults);
  }
  if (albumsPayload) {
    state.artistAlbums = albumsPayload || [];
  }
}

async function fetchAlbumTracks(collectionId, limit = 200) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit || 200)));
  return request(`/analytics/album-tracks?collection_id=${encodeURIComponent(collectionId)}&limit=${safeLimit}`);
}

function normalizeAlbumMatchTitle(value) {
  return normalizeText(value || "")
    .replace(/\(([^)]*)\)/g, " ")
    .replace(
      /\b(deluxe|edition|expanded|remaster(?:ed)?|version|bonus|single|ep|radio|edit|explicit|clean)\b/g,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();
}

function getAlbumCollectionId(album) {
  if (!album || typeof album !== "object") {
    return "";
  }
  const raw = album.collection_id ?? album.collectionId ?? "";
  const text = String(raw).trim();
  if (!text) {
    return "";
  }
  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric > 0) {
    return String(Math.trunc(numeric));
  }
  return text;
}

function getAlbumDisplayTitle(album) {
  return String(album?.title || album?.album_title || "Unknown album");
}

function getAlbumDisplayArtist(album) {
  return String(album?.artist || album?.artist_name || state.selectedArtistName || "Unknown artist");
}

function resolveArtistAlbumMatch(albumTitle, collectionId = null) {
  const albums = Array.isArray(state.artistAlbums) ? state.artistAlbums : [];
  if (!albums.length) {
    return null;
  }
  const collectionIdText = collectionId != null ? String(collectionId).trim() : "";
  if (collectionIdText) {
    const byCollection = albums.find((item) => getAlbumCollectionId(item) === collectionIdText) || null;
    if (byCollection) {
      return byCollection;
    }
  }
  const exactNormalizedTitle = normalizeText(albumTitle || "");
  const baseNormalizedTitle = normalizeAlbumMatchTitle(albumTitle || "");
  if (!exactNormalizedTitle && !baseNormalizedTitle) {
    return null;
  }
  let matched = albums.find((item) => normalizeText(item.album_title || item.title || "") === exactNormalizedTitle) || null;
  if (!matched && baseNormalizedTitle) {
    matched =
      albums.find((item) => normalizeAlbumMatchTitle(item.album_title || item.title || "") === baseNormalizedTitle) ||
      albums.find((item) => {
        const candidate = normalizeAlbumMatchTitle(item.album_title || item.title || "");
        return candidate.startsWith(baseNormalizedTitle) || baseNormalizedTitle.startsWith(candidate);
      }) ||
      null;
  }
  return matched;
}

async function openAlbumOnArtistPage(artistName, albumTitle, options = {}) {
  const safeArtistName = String(artistName || "").trim();
  const safeAlbumTitle = String(albumTitle || "").trim();
  if (!safeArtistName) {
    throw new Error("Album artist is not available.");
  }
  await openArtistDetail(safeArtistName);
  switchArtistDetailTab("albums");
  const matchedAlbum = resolveArtistAlbumMatch(safeAlbumTitle, options.collectionId);
  if (getAlbumCollectionId(matchedAlbum)) {
    await openArtistAlbum(matchedAlbum, { anchorElement: options.anchorElement });
    return true;
  }
  const fallbackAlbum = Array.isArray(state.artistAlbums) && state.artistAlbums.length > 0 ? state.artistAlbums[0] : null;
  if (fallbackAlbum && getAlbumCollectionId(fallbackAlbum)) {
    await openArtistAlbum(fallbackAlbum, { anchorElement: options.anchorElement });
    showFlash("Specific album match not found; opened first available album.");
    return true;
  }
  showFlash("Album opened on artist page but no album entries were available.", true);
  return false;
}

async function openArtistAlbum(album, options = {}) {
  const collectionId = getAlbumCollectionId(album);
  if (!album || !collectionId) {
    throw new Error("Album is missing collection id.");
  }
  switchArtistDetailTab("albums");
  state.selectedArtistAlbum = album;
  state.artistAlbumTracks = await fetchAlbumTracks(collectionId, 200);
  renderArtistAlbums();
  renderArtistAlbumTracks();
  focusArtistTracksPanel(options.anchorElement);
}

async function playAlbum(album, options = {}) {
  const collectionId = getAlbumCollectionId(album);
  if (!album || !collectionId) {
    throw new Error("Album is missing collection id.");
  }
  const btn = options.button;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Loading…";
  }
  try {
    const tracks = await fetchAlbumTracks(collectionId, 200);
    if (!tracks || tracks.length === 0) {
      showFlash("No playable tracks found in this album.", true);
      return;
    }
    // Çalınabilir track'leri filtrele (preview_url veya local)
    const playable = tracks.filter(
      (t) => t.preview_url || (t.is_local === true && t.id && t.file_path)
    );
    if (playable.length === 0) {
      showFlash("No playable tracks found in this album.", true);
      return;
    }
    // Queue'yu temizle ve tüm track'leri sırayla ekle
    clearQueue();
    for (const track of playable) {
      enqueueSong(track, { allowDuplicate: true });
    }
    // İlk track'i çal
    await playQueueIndex(0);
    showFlash(`Playing: ${getAlbumDisplayTitle(album)} (${playable.length} tracks)`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Play Album";
    }
  }
}

async function loadArtistFullCatalogIfStillViewing(artistName) {
  const n = normalizeArtistQueryParam(artistName);
  if (!n || normalizeArtistQueryParam(state.selectedArtistName) !== n) {
    return;
  }
  if (state.activeViewId !== "artistDetailView") {
    return;
  }
  if (state.artistDetailCatalogComplete) {
    return;
  }
  try {
    const full = await fetchArtistDetailSongs(n, ARTIST_DETAIL_SONGS_MAX, { catalogDepth: "full" });
    if (normalizeArtistQueryParam(state.selectedArtistName) !== n) {
      return;
    }
    state.artistDetailCatalogComplete = full.catalog_complete !== false;
    state.artistSongsLimit = ARTIST_DETAIL_SONGS_MAX;
    state.artistDetailSource = String(full.source || state.artistDetailSource || "fallback");
    state.artistDetailArtworkUrl = pickArtistDetailArtworkUrl(
      full.artist_artwork_url || state.artistDetailArtworkUrl || "",
      n,
    );
    if (el.artistDetailHeroBg) {
      if (state.artistDetailArtworkUrl) {
        el.artistDetailHeroBg.style.backgroundImage = `url("${String(state.artistDetailArtworkUrl).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}")`;
      } else {
        el.artistDetailHeroBg.style.backgroundImage = "";
      }
    }
    state.artistDetailResults = full.songs || [];
    state.artistSongsTotalAvailable = Number(full.total_songs_available || state.artistDetailResults.length);
    await preloadSongRelations(state.artistDetailResults);
    renderArtistDetailResults();
  } catch {
    /* ignore background catalog errors */
  }
}

function scheduleArtistFullCatalogLoad(artistName) {
  clearArtistFullCatalogSchedule();
  const name = normalizeArtistQueryParam(artistName);
  if (!name) {
    return;
  }
  artistFullCatalogTimerId = window.setTimeout(() => {
    artistFullCatalogTimerId = null;
    void loadArtistFullCatalogIfStillViewing(name);
  }, ARTIST_DETAIL_FULL_CATALOG_DELAY_MS);
}

/** Mirrors backend `ITunesService._normalize_artist_key` for deep-link verification. */
function normalizeArtistKeyForDeepLink(raw) {
  try {
    const s = String(raw ?? "")
      .trim()
      .toLowerCase()
      .normalize("NFKD")
      .replace(/\p{M}/gu, "");
    return s
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .join(" ");
  } catch {
    return String(raw ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .join(" ");
  }
}

/** True when analytics artist-detail has no iTunes match (typo / tampered #artist/… link). */
function isArtistDetailDeepLinkUnresolved(payload) {
  const id = payload?.artist_id;
  if (id != null && Number(id) > 0) {
    return false;
  }
  const songs = payload?.songs;
  return !Array.isArray(songs) || songs.length === 0;
}

/**
 * True when #artist/… should not open: empty catalog, or resolved name ≠ requested (garbage URL
 * that used to map to iTunes' first unrelated hit).
 */
function shouldRejectArtistDeepLink(requestedName, payload) {
  if (isArtistDetailDeepLinkUnresolved(payload)) {
    return true;
  }
  const reqKey = normalizeArtistKeyForDeepLink(requestedName);
  const gotKey = normalizeArtistKeyForDeepLink(payload?.artist ?? "");
  if (!reqKey || !gotKey) {
    return true;
  }
  return reqKey !== gotKey;
}

/**
 * @param options.requireItunesMatch When true (deep links), refuse to open the page if iTunes has no artist match.
 * @returns false when requireItunesMatch and artist could not be resolved.
 */
async function openArtistDetail(artistName, options) {
  const requireItunesMatch = Boolean(options && options.requireItunesMatch);
  const selectedArtistName = normalizeArtistQueryParam(artistName);
  if (!selectedArtistName) {
    throw new Error("Artist name is required.");
  }
  clearArtistFullCatalogSchedule();
  state.selectedArtistName = selectedArtistName;
  state.artistSongsLimit = ARTIST_DETAIL_INITIAL_SONGS;
  state.artistSongsPage = 0;
  state.artistDetailFilterQuery = "";
  if (el.artistDetailFilter) {
    el.artistDetailFilter.value = "";
  }
  state.selectedArtistAlbum = null;
  state.artistAlbumTracks = [];
  const [artistDetailPayload, artistAlbumsPayload, artistVideosPayload] = await Promise.all([
    fetchArtistDetailSongs(selectedArtistName, ARTIST_DETAIL_INITIAL_SONGS, { catalogDepth: "fast" }),
    fetchArtistAlbums(selectedArtistName, 200),
    request(`/discover/by-artist?artist=${encodeURIComponent(selectedArtistName)}`).catch(() => []),
  ]);
  if (requireItunesMatch && shouldRejectArtistDeepLink(selectedArtistName, artistDetailPayload)) {
    state.selectedArtistName = "";
    showFlash("We couldn't find that artist.", true);
    try {
      window.history.replaceState(
        window.history.state,
        document.title,
        `${window.location.pathname}${window.location.search || ""}`,
      );
    } catch {
      /* ignore */
    }
    switchView("browseView");
    return false;
  }
  state.artistDetailCatalogComplete = artistDetailPayload.catalog_complete !== false;
  state.artistDetailSource = String(artistDetailPayload.source || "fallback");
  state.artistDetailArtworkUrl = pickArtistDetailArtworkUrl(
    artistDetailPayload.artist_artwork_url || "",
    selectedArtistName,
  );
  if (el.artistDetailHeroBg) {
    if (state.artistDetailArtworkUrl) {
      el.artistDetailHeroBg.style.backgroundImage = `url("${String(state.artistDetailArtworkUrl).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}")`;
    } else {
      el.artistDetailHeroBg.style.backgroundImage = "";
    }
  }
  state.artistDetailResults = artistDetailPayload.songs || [];
  state.artistSongsTotalAvailable = Number(artistDetailPayload.total_songs_available || state.artistDetailResults.length);
  state.artistAlbums = artistAlbumsPayload || [];
  state.artistDiscoverVideos = Array.isArray(artistVideosPayload) ? artistVideosPayload : [];
  await preloadSongRelations(state.artistDetailResults);
  switchArtistDetailTab("songs");
  renderArtistDetailResults();
  renderArtistDiscoverVideos();
  void loadSearchProfilesForActiveArtist({ force: true });
  try {
    const h = `#artist/${encodeURIComponent(selectedArtistName)}`;
    window.history.replaceState(
      window.history.state,
      document.title,
      `${window.location.pathname}${window.location.search || ""}${h}`,
    );
  } catch {
    /* ignore */
  }
  switchView("artistDetailView");
  if (!state.artistDetailCatalogComplete) {
    scheduleArtistFullCatalogLoad(selectedArtistName);
  }
  return true;
}

async function fetchPlaylists() {
  state.playlists = await request("/playlists");
  renderPlaylists();
}

async function fetchPlaylistDetail(playlistId) {
  state.selectedPlaylistDetail = await request(`/playlists/${playlistId}`);
  state.selectedPlaylistIsOwned = true;
  state.lastKnownPlaylistUpdatedAt = state.selectedPlaylistDetail.updated_at || null;
  clearPlaylistSyncTimer();
  renderPlaylistDetail();
  renderPlaylists();
  renderDiscoverPlaylists();
  renderFollowingPlaylists();
}

async function fetchDiscoverPlaylists(query = "") {
  const qNorm = normalizeSearchQuery(query);
  const suffix = qNorm ? `?q=${encodeURIComponent(qNorm)}` : "";
  state.discoveredPlaylists = await request(`/playlists/discover${suffix}`);
  renderDiscoverPlaylists();
}

async function fetchFollowingPlaylists() {
  state.followingPlaylists = await request("/playlists/following");
  renderFollowingPlaylists();
}

async function openPublicPlaylist(playlistId) {
  state.selectedPlaylistId = playlistId;
  switchView("playlistsView");
  state.selectedPlaylistDetail = await request(`/playlists/${playlistId}/public`);
  state.selectedPlaylistIsOwned = false;
  state.lastKnownPlaylistUpdatedAt = state.selectedPlaylistDetail.updated_at || null;
  clearPlaylistSyncTimer();
  state.syncTimer = window.setInterval(async () => {
    if (!state.selectedPlaylistId || state.selectedPlaylistIsOwned) {
      clearPlaylistSyncTimer();
      return;
    }
    try {
      const latest = await request(`/playlists/${state.selectedPlaylistId}/public`);
      if (latest.updated_at !== state.lastKnownPlaylistUpdatedAt) {
        state.selectedPlaylistDetail = latest;
        state.lastKnownPlaylistUpdatedAt = latest.updated_at;
        renderPlaylistDetail();
        showFlash("Mirror playlist updated from owner.");
      }
    } catch {
      clearPlaylistSyncTimer();
    }
  }, 7000);
  renderPlaylistDetail();
  renderPlaylists();
  renderDiscoverPlaylists();
  renderFollowingPlaylists();
}

async function fetchFavorites() {
  state.favorites = await request("/favorites");
  renderFavorites();
}

async function fetchHistory() {
  state.history = await request("/history?limit=100");
  renderHistory();
}

async function fetchRecentHistory() {
  state.history = await request("/history/recent?limit=50");
  renderHistory();
}

async function fetchRecommendations() {
  const songs = await request("/recommendations?limit=10");
  state.recommendations = (songs || []).map((song) => ({ song, reasons: [] }));
  renderSearchRecommendationRail();
}

async function fetchTopArtistsForSearch() {
  state.topArtists = await request("/analytics/popular-artists?days=30&limit=40");
  renderSearchArtistRail();
  void loadSearchProfilesForActiveArtist();
}

async function fetchAnalytics() {
  const daysInput = el.analyticsDays ? el.analyticsDays.value : state.analytics.days;
  const limitInput = el.analyticsLimit ? el.analyticsLimit.value : state.analytics.limit;
  const days = Math.max(1, Math.min(365, Number(daysInput || state.analytics.days)));
  const limit = Math.max(1, Math.min(50, Number(limitInput || state.analytics.limit)));
  state.analytics.days = days;
  state.analytics.limit = limit;

  try {
    const [topTracks, topGenres] = await Promise.all([
      request(`/analytics/top-tracks?days=${days}&limit=${limit}`),
      request(`/analytics/top-genres?days=${days}&limit=${limit}`),
    ]);
    state.analytics.topTracks = topTracks || [];
    state.analytics.topGenres = topGenres || [];
  } catch {
    state.analytics.topTracks = [];
    state.analytics.topGenres = [];
  } finally {
    state.analytics.initialFetchComplete = true;
  }
  renderAnalytics();
}

async function fetchTrendingTracks() {
  const days = TRENDING_HISTORY_DAYS;
  const limit = TRENDING_TRACK_LIMIT;
  try {
    const tracks = await request(`/analytics/trending-tracks?days=${days}&limit=${limit}`);
    state.trendingTracks = tracks || [];
  } catch {
    state.trendingTracks = [];
  } finally {
    state.trendingFetchComplete = true;
  }
  renderBrowseView();
}

async function refreshAllData() {
  if (refreshAllDataPromise) {
    return refreshAllDataPromise;
  }
  state.dataRefreshBulkInFlight = true;
  refreshAllDataPromise = (async () => {
    try {
      const lightOutcomes = await runRefreshJobsStaggered(getLightDataRefreshJobs(), DATA_REFRESH_LIGHT_STAGGER_MS);
      const heavyOutcomes = await runRefreshJobsStaggered(getHeavyDataRefreshJobs(), DATA_REFRESH_JOB_STAGGER_MS);
      await fetchSocialFollowingUsers({ force: true });
      const outcomes = [...lightOutcomes, ...heavyOutcomes];
      const failedCount = outcomes.filter((item) => item.status === "rejected").length;
      if (failedCount > 0) {
        showFlash(`Some data failed to load (${failedCount}). App is still available.`, true);
      }
      await refreshPlaylistDetailAfterDataLoad();
      try {
        await preloadSongRelations(state.searchResults);
      } catch {
        // Keep UI usable even when relation preload fails.
      }
      renderSearchResults();
      try {
        await loadSearchProfilesForActiveArtist();
      } catch {
        // Keep UI usable even when profiles fail.
      }
    } finally {
      state.dataRefreshBulkInFlight = false;
      refreshAllDataPromise = null;
    }
  })();
  return refreshAllDataPromise;
}

async function updateProfile() {
  const nextUsername = normalizeProfileUsername(el.profileUsername?.value || state.user?.username || "");
  const nextEmail = normalizeProfileEmail(el.profileEmail?.value || state.user?.email || "");
  const nextAvatarUrl = normalizeProfileAvatarUrl(state.profilePrefs.avatarUrl || "");
  const nextBio = normalizeProfileBio(el.profileBio?.value || "");
  const currentAvatarUrl = String(state.user?.avatar_url || "").trim();
  const currentBio = String(state.user?.bio || "").trim();
  const payload = {};
  if (nextUsername && nextUsername !== state.user?.username) {
    payload.username = nextUsername;
  }
  if (nextEmail && nextEmail !== state.user?.email) {
    payload.email = nextEmail;
  }
  if (nextAvatarUrl !== currentAvatarUrl) {
    payload.avatar_url = nextAvatarUrl;
  }
  if (nextBio !== currentBio) {
    payload.bio = nextBio;
  }
  if (Object.keys(payload).length === 0) {
    return;
  }
  state.user = await request("/auth/me", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  loadProfilePrefs();
  el.welcomeTitle.textContent = `Welcome ${state.user.username}`;
  el.welcomeMeta.textContent = state.user.email;
  renderProfileView();
  renderSearchProfiles();
  renderFollowingUsers();
  renderUserProfileView();
  if (state.searchProfilesMode === "self") {
    await fetchSelfProfilePlaylists();
    renderSearchProfiles();
    applySearchFilterVisibility();
  }
  showFlash("Profile updated.");
}

async function saveArtistToLibrary(artistName) {
  const safeName = String(artistName || "").trim();
  if (!safeName) {
    throw new Error("Artist name is required.");
  }
  await request("/library/collections/artists", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ artist_name: safeName }),
  });
  await fetchLibraryCollections();
  showFlash(`Saved artist: ${safeName}`);
}

async function saveAlbumToLibrary(albumTitle, artistName = null) {
  const safeAlbumTitle = String(albumTitle || "").trim();
  if (!safeAlbumTitle) {
    throw new Error("Album title is required.");
  }
  await request("/library/collections/albums", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ album_title: safeAlbumTitle, artist_name: artistName || null }),
  });
  await fetchLibraryCollections();
  showFlash(`Saved album: ${safeAlbumTitle}`);
}

async function followPlaylistOwner(userId) {
  const numericUserId = Number(userId || 0);
  if (!numericUserId) {
    throw new Error("Owner user id not available.");
  }
  await request(`/social/follow/${numericUserId}`, { method: "POST" });
  await fetchSocialFollowingUsers({ force: true });
  showFlash("Owner followed.");
}

async function createPlaylist(name, description, options = {}) {
  const silent = Boolean(options.silent);
  let created = null;
  const safeName = normalizePlaylistName(name);
  const safeDescription = normalizePlaylistDescription(description);
  await withActionLock("create-playlist", async () => {
    created = await request("/playlists", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: toUrlEncoded({ name: safeName, description: safeDescription }),
    });
    await refreshAfterPlaylistMutation(created.id || null);
    if (!silent) {
      showFlash("Playlist created.");
    }
  });
  return created;
}

async function openPlaylist(playlistId) {
  state.selectedPlaylistId = playlistId;
  switchView("playlistsView");
  await fetchPlaylistDetail(playlistId);
}

async function deletePlaylist(playlistId) {
  await withActionLock(`delete-playlist-${playlistId}`, async () => {
    await request(`/playlists/${playlistId}`, { method: "DELETE" });
    if (state.selectedPlaylistId === playlistId) {
      state.selectedPlaylistId = null;
      state.selectedPlaylistDetail = null;
    }
    await refreshAfterPlaylistMutation();
    showFlash("Playlist deleted.");
  });
}

async function renamePlaylist(playlist) {
  const nextName = window.prompt("New playlist name:", playlist.name || "");
  const trimmed = normalizePlaylistName(nextName || "");
  if (!trimmed || trimmed === normalizePlaylistName(playlist.name || "")) {
    return;
  }
  await withActionLock(`rename-playlist-${playlist.id}`, async () => {
    await request(`/playlists/${playlist.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: toUrlEncoded({ name: trimmed }),
    });
    await refreshAfterPlaylistMutation(playlist.id);
    showFlash("Playlist renamed.");
  });
}

async function duplicatePlaylist(playlistId) {
  await withActionLock(`duplicate-playlist-${playlistId}`, async () => {
    const duplicated = await request(`/playlists/${playlistId}/duplicate`, { method: "POST" });
    await refreshAfterPlaylistMutation(duplicated.id || playlistId);
    showFlash("Playlist duplicated.");
  });
}

async function reorderPlaylistSongs(playlistId, songIds) {
  await request(`/playlists/${playlistId}/songs/reorder`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ song_ids: songIds }),
  });
}

async function moveSongInSelectedPlaylist(songId, direction) {
  if (!state.selectedPlaylistIsOwned) {
    showFlash("Followed mirror playlists are read-only.", true);
    return;
  }
  if (!state.selectedPlaylistDetail || !state.selectedPlaylistId) {
    return;
  }
  const currentOrder = state.selectedPlaylistDetail.songs.map((song) => song.id);
  const currentIndex = currentOrder.indexOf(songId);
  const nextIndex = currentIndex + direction;
  if (currentIndex < 0 || nextIndex < 0 || nextIndex >= currentOrder.length) {
    return;
  }
  const [moved] = currentOrder.splice(currentIndex, 1);
  currentOrder.splice(nextIndex, 0, moved);
  await withActionLock(`reorder-${state.selectedPlaylistId}`, async () => {
    await reorderPlaylistSongs(state.selectedPlaylistId, currentOrder);
    await refreshAfterPlaylistMutation(state.selectedPlaylistId);
    showFlash("Playlist order updated.");
  });
}

async function removeSongFromPlaylist(playlistId, songId) {
  if (!state.selectedPlaylistIsOwned) {
    showFlash("Followed mirror playlists are read-only.", true);
    return;
  }
  if (!playlistId || !songId) {
    return;
  }
  await withActionLock(`playlist-remove-${playlistId}-${songId}`, async () => {
    await request(`/playlists/${playlistId}/songs/${songId}`, { method: "DELETE" });
    await refreshAfterPlaylistMutation(playlistId);
    showFlash("Song removed from playlist.");
  });
}

async function addSongToPlaylist(song, playlistId, options = {}) {
  if (!playlistId) {
    showFlash("Select a playlist first.", true);
    return;
  }
  const isOwnedTarget = state.playlists.some(
    (playlist) => String(playlist.id) === String(playlistId),
  );
  if (!isOwnedTarget) {
    showFlash("You can only add songs to your own playlists.", true);
    return;
  }
  const payload = { position: 0 };
  if (song.id) {
    payload.song_id = song.id;
  } else {
    payload.itunes_track_id = song.itunes_track_id;
    payload.title = song.title;
    payload.artist = song.artist;
    payload.album = song.album;
    payload.genre = song.genre;
    payload.duration_ms = song.duration_ms;
    payload.artwork_url = song.artwork_url;
    payload.preview_url = song.preview_url;
  }

  const songIdentity = song.id || song.itunes_track_id || song.title || "song";
  const skipFlash = Boolean(options.skipFlash);
  await withActionLock(`playlist-add-${playlistId}-${songIdentity}`, async () => {
    await request(`/playlists/${playlistId}/songs`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: toUrlEncoded(payload),
    });
    await refreshAfterPlaylistMutation(playlistId);
    if (!skipFlash) {
      showFlash("Added to playlist.");
    }
  });
}

async function followPlaylist(playlistId) {
  await request(`/playlists/${playlistId}/follow`, { method: "POST" });
  await Promise.all([
    fetchDiscoverPlaylists(el.discoverQuery.value || ""),
    fetchFollowingPlaylists(),
  ]);
  showFlash("Playlist followed.");
}

async function unfollowPlaylist(playlistId) {
  await request(`/playlists/${playlistId}/follow`, { method: "DELETE" });
  if (state.selectedPlaylistId === playlistId && !state.selectedPlaylistIsOwned) {
    state.selectedPlaylistId = null;
    state.selectedPlaylistDetail = null;
    clearPlaylistSyncTimer();
    renderPlaylistDetail();
  }
  await Promise.all([
    fetchDiscoverPlaylists(el.discoverQuery.value || ""),
    fetchFollowingPlaylists(),
  ]);
  showFlash("Playlist unfollowed.");
}

async function setPlaylistVisibility(playlistId, isPublic) {
  await request(`/playlists/${playlistId}/visibility`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ is_public: isPublic }),
  });
  await Promise.all([fetchPlaylists(), fetchDiscoverPlaylists(el.discoverQuery.value || "")]);
  showFlash(isPublic ? "Playlist is now public." : "Playlist is now private.");
}

function optimisticAddFavoriteEntry(song, resolvedId) {
  const id = resolvedId != null ? Number(resolvedId) : null;
  if (!id || Number.isNaN(id)) {
    return;
  }
  if (state.favorites.some((f) => String(f.id) === String(id))) {
    return;
  }
  state.favorites.unshift({
    ...song,
    id,
    is_local: song.is_local ?? false,
  });
  syncLikeButtonsUI();
}

async function addFavoriteFromSong(song) {
  const songIdentity = song.id || song.itunes_track_id || song.title || "song";
  await withActionLock(`favorite-add-${songIdentity}`, async () => {
    state.favoriteTogglePending = buildFavoriteTogglePending(song, true);
    syncLikeButtonsUI();
    try {
      if (song.id) {
        await request(`/favorites/${song.id}`, { method: "POST" });
        optimisticAddFavoriteEntry(song, song.id);
      } else {
        const hasTrackId = Boolean(song.itunes_track_id && String(song.itunes_track_id).trim());
        const hasTitleArtist = Boolean(
          song.title && String(song.title).trim() && song.artist && String(song.artist).trim()
        );
        if (!hasTrackId && !hasTitleArtist) {
          throw new Error("Cannot add favorite: iTunes result has no usable identity data.");
        }

        const res = await request("/favorites/by-itunes", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: toUrlEncoded({
            itunes_track_id: song.itunes_track_id,
            title: song.title,
            artist: song.artist,
            album: song.album,
            genre: song.genre,
            duration_ms: song.duration_ms,
            artwork_url: song.artwork_url,
            preview_url: song.preview_url,
          }),
        });
        const sid = res && res.song_id != null ? res.song_id : null;
        if (sid != null) {
          optimisticAddFavoriteEntry(song, sid);
        }
      }
    } catch (err) {
      state.favoriteTogglePending = null;
      syncLikeButtonsUI();
      throw err;
    }
    state.favoriteTogglePending = null;
    syncLikeButtonsUI();
    refreshAfterFavoriteMutation();
    showFlash("Favorite updated.");
  });
}

async function removeFavorite(song) {
  await withActionLock(`favorite-remove-${song.id}`, async () => {
    state.favoriteTogglePending = buildFavoriteTogglePending(song, false);
    state.favorites = (state.favorites || []).filter((f) => String(f.id) !== String(song.id));
    syncLikeButtonsUI();
    renderFavorites();
    try {
      await request(`/favorites/${song.id}`, { method: "DELETE" });
    } catch (err) {
      state.favoriteTogglePending = null;
      await fetchFavorites();
      syncLikeButtonsUI();
      renderFavorites();
      throw err;
    }
    state.favoriteTogglePending = null;
    syncLikeButtonsUI();
    refreshAfterFavoriteMutation();
    showFlash("Favorite removed.");
  });
}

async function deleteHistoryItem(historyId) {
  await withActionLock(`history-delete-${historyId}`, async () => {
    await request(`/history/${historyId}`, { method: "DELETE" });
    await refreshAfterHistoryMutation();
    showFlash("History row deleted.");
  });
}

async function clearHistory() {
  const confirmed = window.confirm("Delete all listening history?");
  if (!confirmed) {
    return;
  }
  await withActionLock("history-clear-all", async () => {
    await request("/history", { method: "DELETE" });
    await refreshAfterHistoryMutation();
    showFlash("History cleared.");
  });
}

async function addHistoryEntry(song, listenedDurationMs, reason = "manual") {
  if (!song || listenedDurationMs < 1000) {
    return;
  }
  const songIdentity = song.id || song.itunes_track_id || song.title || "song";
  await withActionLock(`history-${songIdentity}`, async () => {
    if (song.id) {
      await request("/history", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: toUrlEncoded({ song_id: song.id, listened_duration_ms: listenedDurationMs }),
      });
    } else {
      await request("/history/by-itunes", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: toUrlEncoded({
          itunes_track_id: song.itunes_track_id,
          title: song.title,
          artist: song.artist,
          album: song.album,
          genre: song.genre,
          duration_ms: song.duration_ms,
          artwork_url: song.artwork_url,
          preview_url: song.preview_url,
          listened_duration_ms: listenedDurationMs,
        }),
      });
    }
    await refreshAfterHistoryMutation();
  });
}

async function flushCurrentHistory(reason) {
  if (!state.currentPlayingSong || state.isHistoryPosting) {
    return;
  }

  const listenedDurationMs = pausePlaybackClock();
  if (listenedDurationMs < 1000) {
    return;
  }
  const minDeltaMs = HISTORY_DEFAULT_MIN_DELTA_MS;
  if (reason !== "ended" && listenedDurationMs - state.lastHistorySentMs < minDeltaMs) {
    return;
  }

  state.isHistoryPosting = true;
  try {
    await addHistoryEntry(state.currentPlayingSong, listenedDurationMs, reason);
    state.lastHistorySentMs = listenedDurationMs;
  } finally {
    state.isHistoryPosting = false;
  }
}

async function playQueueIndex(index) {
  if (index < 0 || index >= state.queue.length) {
    return;
  }
  state.queueIndex = index;
  const song = state.queue[index];
  await playSong(song, { fromQueue: true });
  renderQueue();
}

function enqueueSong(song, options = {}) {
  const allowDuplicate = Boolean(options.allowDuplicate);
  const existingIndex = allowDuplicate ? -1 : queueHasSong(song);
  const shouldPlayNow = Boolean(options.playNow);
  if (!allowDuplicate && existingIndex >= 0) {
    if (shouldPlayNow) {
      state.queueIndex = existingIndex;
    }
    renderQueue();
    return existingIndex;
  }
  if (options.insertAfterCurrent && state.queueIndex >= 0) {
    const insertAt = state.queueIndex + 1;
    const queuedSong = { ...song };
    state.queue.splice(insertAt, 0, queuedSong);
    void syncQueueAdd(queuedSong, insertAt).then((created) => {
      if (created?.id) {
        queuedSong.queue_item_id = created.id;
      }
      if (created?.duration_ms != null) {
        queuedSong.duration_ms = Number(created.duration_ms);
      }
    });
    renderQueue();
    return insertAt;
  }
  const queuedSong = { ...song };
  state.queue.push(queuedSong);
  const nextIndex = state.queue.length - 1;
  void syncQueueAdd(queuedSong, nextIndex).then((created) => {
    if (created?.id) {
      queuedSong.queue_item_id = created.id;
    }
    if (created?.duration_ms != null) {
      queuedSong.duration_ms = Number(created.duration_ms);
    }
  });
  if (shouldPlayNow || state.queueIndex < 0) {
    state.queueIndex = nextIndex;
  }
  renderQueue();
  return nextIndex;
}

function isTrackPlayableForShuffle(song) {
  return Boolean(
    song && (song.preview_url || (song.is_local === true && song.id && song.file_path))
  );
}

function shuffleSongsArrayInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function shuffleSongsIntoQueue(songs, options = {}) {
  const maxItems = Math.max(1, Math.min(50, Number(options.maxItems) || 20));
  const playable = (songs || []).filter(isTrackPlayableForShuffle);
  if (playable.length === 0) {
    showFlash("No playable tracks found for shuffle.", true);
    return false;
  }
  const shuffled = [...playable];
  shuffleSongsArrayInPlace(shuffled);
  const queueBatch = [];
  for (let i = 0; i < maxItems; i += 1) {
    queueBatch.push({ ...shuffled[i % shuffled.length] });
  }
  const firstSong = queueBatch[0];
  const firstIndex = enqueueSong(firstSong, { playNow: true, allowDuplicate: true });
  await playQueueIndex(firstIndex);
  for (let i = queueBatch.length - 1; i >= 1; i -= 1) {
    enqueueSong(queueBatch[i], { insertAfterCurrent: true, allowDuplicate: true });
  }
  showFlash(`Shuffle queue: ${queueBatch.length} tracks added.`);
  return true;
}

async function playNextInQueue() {
  if (state.queue.length === 0) {
    return;
  }
  let nextIndex = state.queueIndex + 1;
  if (state.shuffleQueue && state.queue.length > state.queueIndex + 1) {
    const from = state.queueIndex + 1;
    const to = state.queue.length - 1;
    if (from <= to) {
      nextIndex = from + Math.floor(Math.random() * (to - from + 1));
    }
  }
  if (nextIndex < state.queue.length) {
    await playQueueIndex(nextIndex);
    return;
  }
  if (state.repeatQueue) {
    await playQueueIndex(0);
    return;
  }
  state.queueIndex = -1;
  state.currentPlayingSong = null;
  el.nowPlayingTitle.textContent = "Queue finished";
  el.nowPlayingArtist.textContent = "Add songs to continue";
  el.playerToggleBtn.innerHTML = '<i class="material-icons">play_arrow</i>';
  updateNowPlayingArtwork(null);
  updatePlayerProgressUI();
  renderQueue();
}

async function playPrevInQueue() {
  if (state.queue.length === 0) {
    return;
  }
  const prevIndex = state.queueIndex - 1;
  if (prevIndex >= 0) {
    await playQueueIndex(prevIndex);
    return;
  }
  if (state.repeatQueue) {
    await playQueueIndex(Math.max(0, state.queue.length - 1));
  }
}

let playRequestSeq = 0;

async function ensureSongInDb(song) {
  if (song.id) {
    return song;
  }
  const hasTrackId = Boolean(song.itunes_track_id && String(song.itunes_track_id).trim());
  const hasTitleArtist = Boolean(
    song.title && String(song.title).trim() && song.artist && String(song.artist).trim()
  );
  if (!hasTrackId && !hasTitleArtist) {
    return song;
  }
  try {
    const updatedSong = await request("/songs/by-itunes", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: toUrlEncoded({
        itunes_track_id: song.itunes_track_id,
        title: song.title,
        artist: song.artist,
        album: song.album,
        genre: song.genre,
        duration_ms: song.duration_ms,
        artwork_url: song.artwork_url,
        preview_url: song.preview_url,
      }),
    });
    return updatedSong || song;
  } catch (err) {
    console.warn("Failed to ensure song in DB:", err);
    return song;
  }
}

async function playSong(song, options = {}) {
  const currentSeq = ++playRequestSeq;

  song = await ensureSongInDb(song);

  if (state.favoriteTogglePending && !favoritePendingMatchesSong(song, state.favoriteTogglePending)) {
    state.favoriteTogglePending = null;
  }

  if (!options.fromQueue) {
    const qi = queueHasSong(song);
    if (qi >= 0) {
      state.queueIndex = qi;
    }
  }

  if (state.syncSession.sessionId && !state.syncSession.isHost && !options.isInternal) {
    showFlash("Only the host can change or play songs.", true);
    return;
  }

  clearPlaybackVideoPrimary();

  // Persist progress of previous track. 
  // We do NOT await here to keep the current execution tick for .play()
  const historyFlushPromise = flushCurrentHistory("switch");

  // Immediately stop and reset the current player
  el.audioPlayer.pause();
  el.audioPlayer.removeAttribute("src");
  el.audioPlayer.load();

  resetHistoryPlaybackTracking();
  state.currentPlayingSong = song;
  state.lastHistorySentMs = 0;
  syncLikeButtonsUI();

  el.nowPlayingTitle.textContent = song.title || "Unknown";
  el.nowPlayingArtist.textContent = song.artist || "Unknown";
  el.playerToggleBtn.innerHTML = '<i class="material-icons">pause</i>';
  if (el.fullPlayerPlayIcon) el.fullPlayerPlayIcon.textContent = "pause";
  if (el.fullPlayerTitle) el.fullPlayerTitle.textContent = song.title || "Unknown";
  if (el.fullPlayerArtist) el.fullPlayerArtist.textContent = song.artist || "Unknown";

  if (state.uiPrefs.fullPlayerOpen) {
    if (state.activeFpTab === "queue") {
      renderFullPlayerQueue();
    }
    if (state.activeFpTab === "lyrics") {
      renderFullPlayerLyrics();
    }
    if (state.activeFpTab === "related") {
      void renderFullPlayerRelated();
    }
  }
  updateNowPlayingArtwork(song);

  let discoverBundle = null;
  if (song.id) {
    try {
      discoverBundle = await request(`/discover/video-for-song/${song.id}`);
    } catch {
      discoverBundle = null;
    }
  }
  const dvUrl = discoverBundle
    ? resolveDiscoverVideoUrl(String(discoverBundle.video_url || "").trim())
    : "";
  const dvHlsRaw = discoverBundle?.hls_url
    ? resolveDiscoverVideoUrl(String(discoverBundle.hls_url || "").trim())
    : "";
  const useDiscoverVideo = Boolean(dvUrl || dvHlsRaw);

  if (useDiscoverVideo) {
    state.fullPlayerMediaMode = "song";
    document.querySelectorAll(".fp-media-seg").forEach((s) => {
      const isSong = s.getAttribute("data-fpmedia") === "song";
      s.classList.toggle("active", isSong);
      s.setAttribute("aria-selected", isSong ? "true" : "false");
    });
    state.playbackVideoPrimary = {
      videoUrl: dvUrl || dvHlsRaw || "",
      hlsUrl: dvHlsRaw || null,
    };
    syncFullPlayerMedia();
    attachFullPlayerVideoProgressSync();
    const vid = el.fullPlayerVideo;
    if (vid) {
      vid.volume = state.audioPrefs.volume;
      const tryPlay = () => void vid.play().catch(() => {});
      if (vid.readyState >= 2) {
        tryPlay();
      } else {
        vid.addEventListener("canplay", () => tryPlay(), { once: true });
      }
    }
    updatePlayerProgressUI();
  } else {
    let streamUrl = "";
    if (song.is_local === true && song.id && song.file_path) {
      streamUrl = streamUrlForSong(song.id);
    } else if (song.preview_url) {
      streamUrl = song.preview_url;
    }

    if (!streamUrl) {
      throw new Error("Song has no streamable source.");
    }

    el.audioPlayer.src = streamUrl;
    try {
      const playPromise = el.audioPlayer.play();
      if (playPromise !== undefined) {
        playPromise.catch((err) => {
          if (currentSeq === playRequestSeq && err.name !== "AbortError") {
            console.warn("Playback failed:", err);
          }
        });
      }
    } catch (err) {
      console.error("Critical play error:", err);
    }

    if (song.is_local === true && streamUrl) {
      queueLocalTrackForCache(streamUrl);
    }

    updatePlayerProgressUI();
  }

  savePlaybackSnapshot();

  // EKLEMEN GEREKEN KISIM:
  if (state.syncSession.sessionId && state.syncSession.isHost) {
      const playbackState = {
        song_id: song.id,
        is_playing: true,
        progress_ms: 0,
        timestamp: Date.now()
      };
      state.syncSession.ws.send(JSON.stringify({
        type: "STATE_UPDATE",
        state: playbackState
      }));
  }

  // Wait for history flush in the background
  historyFlushPromise.catch(console.error);
}

// ============================================================
// FULL SCREEN PLAYER (must be global scope: playSong calls these)
// ============================================================
const FP_PLAYLIST_PICKER_ROOT_ID = "fpPlaylistPickerRoot";
const FP_ACTION_SHEET_ROOT_ID = "fpTrackActionSheetRoot";

const FP_TAB_PANEL_IDS = {
  related: "fpTabRelated",
  lyrics: "fpTabLyrics",
  queue: "fpTabQueue",
};

function fpPanelElementIdForTab(tab) {
  return FP_TAB_PANEL_IDS[tab] || `fpTab${String(tab).charAt(0).toUpperCase() + String(tab).slice(1)}`;
}

function syncFullPlayerTabChrome() {
  const tab = state.activeFpTab || "related";
  el.fpTabButtons.forEach((btn) => {
    const targetTab = btn.getAttribute("data-fptab");
    btn.classList.toggle("active", targetTab === tab);
  });
  el.fpPanels.forEach((p) => {
    p.classList.remove("active");
  });
  const targetPanel = document.getElementById(fpPanelElementIdForTab(tab));
  if (targetPanel) {
    targetPanel.classList.add("active");
  }
}

function removeFpPlaylistMenu() {
  document.getElementById(FP_PLAYLIST_PICKER_ROOT_ID)?.remove();
}

function removeFpTrackActionSheet() {
  document.getElementById(FP_ACTION_SHEET_ROOT_ID)?.remove();
}

function attachFpOverlayOutsideClose(root, anchorBtn, onClose) {
  const ignoreOutsideUntil = performance.now() + 750;
  const onPointerDown = (e) => {
    if (performance.now() < ignoreOutsideUntil) {
      return;
    }
    if (!root.isConnected) {
      document.removeEventListener("pointerdown", onPointerDown, true);
      return;
    }
    const path = typeof e.composedPath === "function" ? e.composedPath() : [];
    const inRoot = path.some((n) => n === root) || (e.target instanceof Node && root.contains(e.target));
    const inAnchor =
      anchorBtn &&
      (path.some((n) => n === anchorBtn) || (e.target instanceof Node && anchorBtn.contains(e.target)));
    if (inRoot || inAnchor) {
      return;
    }
    onClose();
    document.removeEventListener("pointerdown", onPointerDown, true);
  };
  window.setTimeout(() => document.addEventListener("pointerdown", onPointerDown, true), 80);
}

function attachFpPlaylistOutsideClose(root, anchorBtn) {
  attachFpOverlayOutsideClose(root, anchorBtn, removeFpPlaylistMenu);
}

function attachFpActionSheetOutsideClose(root, anchorBtn) {
  attachFpOverlayOutsideClose(root, anchorBtn, removeFpTrackActionSheet);
}

function ensureFpPlaylistAnchorId(anchorBtn) {
  if (!anchorBtn.dataset.fpPickerAid) {
    anchorBtn.dataset.fpPickerAid = `fpaid-${Math.random().toString(36).slice(2, 11)}`;
  }
  return anchorBtn.dataset.fpPickerAid;
}

function ensureFpActionSheetAnchorId(anchorBtn) {
  if (!anchorBtn.dataset.fpActionAid) {
    anchorBtn.dataset.fpActionAid = `fpact-${Math.random().toString(36).slice(2, 11)}`;
  }
  return anchorBtn.dataset.fpActionAid;
}


function mountFpPlaylistFooterWithNewButton(footer, sheet, song) {
  footer.replaceChildren();
  const newPlBtn = document.createElement("button");
  newPlBtn.type = "button";
  newPlBtn.className = "btn fp-playlist-new-btn";
  newPlBtn.innerHTML = '<i class="material-icons">add</i> New playlist';
  newPlBtn.addEventListener("click", () => {
    showFpNewPlaylistInlineForm(footer, sheet, song);
  });
  footer.appendChild(newPlBtn);
}

function showFpNewPlaylistInlineForm(footer, sheet, song) {
  footer.replaceChildren();
  const wrap = document.createElement("div");
  wrap.className = "fp-playlist-new-form";
  const label = document.createElement("label");
  label.className = "fp-playlist-new-label";
  const nameSpan = document.createElement("span");
  nameSpan.textContent = "Playlist name";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Name your playlist";
  input.setAttribute("aria-label", "Playlist name");
  input.autocomplete = "off";
  label.append(nameSpan, input);
  const actions = document.createElement("div");
  actions.className = "fp-playlist-new-form-actions";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "btn ghost";
  cancelBtn.textContent = "Cancel";
  const createBtn = document.createElement("button");
  createBtn.type = "button";
  createBtn.className = "btn btn-primary";
  createBtn.textContent = "Create";
  cancelBtn.addEventListener("click", () => {
    mountFpPlaylistFooterWithNewButton(footer, sheet, song);
  });
  const submit = async () => {
    const name = input.value.trim();
    if (!name) {
      showFlash("Enter a playlist name.", true);
      return;
    }
    removeFpPlaylistMenu();
    try {
      const created = await createPlaylist(name, "", { silent: true });
      if (!created?.id) {
        showFlash("Could not create playlist.", true);
        return;
      }
      await fetchPlaylists();
      await addSongToPlaylist(song, created.id, { skipFlash: true });
      closeFullPlayer();
      await openPlaylist(created.id);
      switchView("playlistsView");
      showFlash("Added to playlist.");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showFlash(message, true);
    }
  };
  createBtn.addEventListener("click", () => {
    void submit();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void submit();
    }
  });
  actions.append(cancelBtn, createBtn);
  wrap.append(label, actions);
  footer.appendChild(wrap);
  window.requestAnimationFrame(() => {
    input.focus();
  });
}

function rebuildPlaylistSheetBody(sheet, song) {
  sheet.replaceChildren();

  const header = document.createElement("div");
  header.className = "fp-playlist-sheet-header";
  const titleEl = document.createElement("span");
  titleEl.className = "fp-playlist-sheet-title";
  titleEl.textContent = "Save to playlist";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "fp-playlist-sheet-close btn ghost icon-btn";
  closeBtn.innerHTML = '<i class="material-icons">close</i>';
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.addEventListener("click", () => removeFpPlaylistMenu());
  header.appendChild(titleEl);
  header.appendChild(closeBtn);

  const sub = document.createElement("div");
  sub.className = "fp-playlist-sheet-sub muted";
  sub.textContent = "All playlists";

  const scroll = document.createElement("div");
  scroll.className = "fp-playlist-sheet-scroll";

  if (state.playlists.length === 0) {
    const empty = document.createElement("p");
    empty.className = "fp-playlist-sheet-empty muted";
    empty.textContent = "You have no playlists yet. Create one below.";
    scroll.appendChild(empty);
  } else {
    for (const p of state.playlists) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "fp-playlist-sheet-row";
      const iconWrap = document.createElement("span");
      iconWrap.className = "fp-playlist-sheet-row-icon";
      iconWrap.innerHTML = '<i class="material-icons">queue_music</i>';
      const textWrap = document.createElement("span");
      textWrap.className = "fp-playlist-sheet-row-text";
      const nameEl = document.createElement("span");
      nameEl.className = "fp-playlist-sheet-row-name";
      nameEl.textContent = p.name;
      const metaEl = document.createElement("span");
      metaEl.className = "fp-playlist-sheet-row-meta muted";
      metaEl.textContent = "Your playlist · Tap to add";
      textWrap.appendChild(nameEl);
      textWrap.appendChild(metaEl);
      row.appendChild(iconWrap);
      row.appendChild(textWrap);
      row.addEventListener("click", () => {
        void (async () => {
          try {
            await addSongToPlaylist(song, p.id);
          } finally {
            removeFpPlaylistMenu();
          }
        })();
      });
      scroll.appendChild(row);
    }
  }

  const footer = document.createElement("div");
  footer.className = "fp-playlist-sheet-footer";
  mountFpPlaylistFooterWithNewButton(footer, sheet, song);

  sheet.append(header, sub, scroll, footer);
}

function openSongPlaylistPicker(song, anchorBtn) {
  if (!song || !anchorBtn) {
    return;
  }
  const aid = ensureFpPlaylistAnchorId(anchorBtn);
  const existing = document.getElementById(FP_PLAYLIST_PICKER_ROOT_ID);
  if (existing) {
    const prevAid = existing.dataset.fpPickerAid || "";
    removeFpPlaylistMenu();
    if (prevAid === aid) {
      return;
    }
  }
  removeFpTrackActionSheet();

  const root = document.createElement("div");
  root.id = FP_PLAYLIST_PICKER_ROOT_ID;
  root.dataset.fpPickerAid = aid;
  root.className = "fp-playlist-picker-root";

  const backdrop = document.createElement("div");
  backdrop.className = "fp-playlist-picker-backdrop";
  backdrop.addEventListener("click", () => removeFpPlaylistMenu());

  const sheet = document.createElement("div");
  sheet.className = "fp-playlist-sheet";
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-label", "Save to playlist");
  sheet.addEventListener("click", (e) => e.stopPropagation());

  rebuildPlaylistSheetBody(sheet, song);

  root.append(backdrop, sheet);
  document.body.appendChild(root);
  attachFpPlaylistOutsideClose(root, anchorBtn);
}

function openTrackActionSheet(track, anchorBtn) {
  if (!track || !anchorBtn) {
    return;
  }
  const aid = ensureFpActionSheetAnchorId(anchorBtn);
  const existing = document.getElementById(FP_ACTION_SHEET_ROOT_ID);
  if (existing) {
    const prevAid = existing.dataset.fpActionAid || "";
    removeFpTrackActionSheet();
    if (prevAid === aid) {
      return;
    }
  }
  removeFpPlaylistMenu();

  const root = document.createElement("div");
  root.id = FP_ACTION_SHEET_ROOT_ID;
  root.dataset.fpActionAid = aid;
  root.className = "fp-action-sheet-root";

  const backdrop = document.createElement("div");
  backdrop.className = "fp-action-sheet-backdrop";
  backdrop.addEventListener("click", () => removeFpTrackActionSheet());

  const sheet = document.createElement("div");
  sheet.className = "fp-action-sheet";
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-label", "Track actions");
  sheet.addEventListener("click", (e) => e.stopPropagation());

  const head = document.createElement("div");
  head.className = "fp-action-sheet-header";
  head.textContent = track.title || "Track";
  sheet.appendChild(head);

  const addRow = (icon, label, handler) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "fp-action-sheet-row";
    b.innerHTML = `<i class="material-icons" aria-hidden="true">${icon}</i><span>${label}</span>`;
    b.addEventListener("click", () => {
      removeFpTrackActionSheet();
      handler();
    });
    sheet.appendChild(b);
  };

  addRow("playlist_play", "Play next", () => {
    enqueueSong(track, { insertAfterCurrent: true, allowDuplicate: true });
    showFlash("Playing next in queue.");
  });
  addRow("playlist_add", "Add to queue", () => {
    enqueueSong(track, { allowDuplicate: true });
    showFlash("Added to queue.");
  });
  addRow("queue_music", "Save to playlist", () => {
    openSongPlaylistPicker(track, anchorBtn);
  });
  const artistName = String(track.artist || "").trim();
  if (artistName) {
    addRow("person", "Go to artist", () => {
      void (async () => {
        closeFullPlayer();
        await openArtistDetail(artistName);
      })();
    });
  }
  const albumTitle = String(track.album || "").trim();
  if (albumTitle && artistName) {
    addRow("album", "Go to album", () => {
      void (async () => {
        try {
          closeFullPlayer();
          await openAlbumOnArtistPage(artistName, albumTitle, {
            collectionId: track.collection_id,
          });
        } catch (err) {
          showFlash(err instanceof Error ? err.message : String(err), true);
        }
      })();
    });
  }
  addRow("share", "Share", () => {
    void (async () => {
      try {
        const s = await ensureSongInDb(track);
        await shareSong(s);
      } catch (err) {
        showFlash(err instanceof Error ? err.message : String(err), true);
      }
    })();
  });
  const qi = queueHasSong(track);
  if (qi >= 0) {
    addRow("remove_circle_outline", "Remove from queue", () => {
      removeFromQueue(qi);
      showFlash("Removed from queue.");
    });
  }

  root.append(backdrop, sheet);
  document.body.appendChild(root);
  attachFpActionSheetOutsideClose(root, anchorBtn);
}

function initFullPlayer() {
  if (!el.fullPlayerOverlay) {
    return;
  }

  const playerNowPlaying = document.querySelector(".player-now-playing");
  if (playerNowPlaying) {
    playerNowPlaying.style.cursor = "pointer";
    playerNowPlaying.addEventListener("click", () => openFullPlayer());
  }

  el.fullPlayerCloseBtn?.addEventListener("click", () => closeFullPlayer());

  el.fullPlayerToggleBtn?.addEventListener("click", () => el.playerToggleBtn?.click());
  el.fullPlayerNextBtn?.addEventListener("click", () => el.playerNextBtn?.click());
  el.fullPlayerPrevBtn?.addEventListener("click", () => el.playerPrevBtn?.click());
  el.fullPlayerShuffleBtn?.addEventListener("click", () => {
    const turningOn = !state.shuffleQueue;
    state.shuffleQueue = turningOn;
    syncRepeatButtonsUI();
    if (turningOn) {
      if (state.queueIndex + 1 >= state.queue.length) {
        showFlash("Add more songs to the queue to shuffle.", true);
      } else {
        const remaining = state.queue.slice(state.queueIndex + 1);
        for (let i = remaining.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
        }
        state.queue = [...state.queue.slice(0, state.queueIndex + 1), ...remaining];
        if (state.activeFpTab === "queue") {
          renderFullPlayerQueue();
        }
        showFlash("Shuffle on.");
      }
    } else {
      showFlash("Shuffle off.");
    }
  });

  document.querySelectorAll(".fp-media-seg").forEach((seg) => {
    seg.addEventListener("click", () => {
      const mode = seg.getAttribute("data-fpmedia");
      if (!mode || (mode !== "song" && mode !== "video")) {
        return;
      }
      state.fullPlayerMediaMode = mode;
      document.querySelectorAll(".fp-media-seg").forEach((s) => {
        const active = s === seg;
        s.classList.toggle("active", active);
        s.setAttribute("aria-selected", active ? "true" : "false");
      });
      syncFullPlayerMedia();
    });
  });

  el.fullPlayerRepeatBtn?.addEventListener("click", () => el.playerRepeatBtn?.click());

  const onFullPlayerVolume = () => {
    if (el.fullPlayerVolume) {
      applyVolumePercent(Number(el.fullPlayerVolume.value));
    }
  };
  el.fullPlayerVolume?.addEventListener("input", onFullPlayerVolume);
  el.fullPlayerVolume?.addEventListener("change", onFullPlayerVolume);
  bindRangeVolumeTouchSync(el.fullPlayerVolume);

  document.getElementById("fullPlayerVolumeDown")?.addEventListener("click", (e) => {
    e.stopPropagation();
    bumpVolumePercent(-10);
  });
  document.getElementById("fullPlayerVolumeUp")?.addEventListener("click", (e) => {
    e.stopPropagation();
    bumpVolumePercent(10);
  });

  el.fullPlayerLikeBtn?.addEventListener("click", () => el.playerLikeBtn?.click());
  el.fullPlayerShareBtn?.addEventListener("click", () => {
    if (!state.currentPlayingSong) {
      return;
    }
    void safeAsyncAction(() => shareSong(state.currentPlayingSong), { button: el.fullPlayerShareBtn })();
  });

  const fpListenTogetherBtn = document.getElementById("fullPlayerListenTogetherBtn");
  fpListenTogetherBtn?.addEventListener("click", () => {
    closeFullPlayer();
    el.listenTogetherBtn?.click();
  });

  const fpSaveBtn = document.getElementById("fullPlayerSaveBtn");
  if (fpSaveBtn) {
    fpSaveBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!state.currentPlayingSong) {
        return;
      }
      openSongPlaylistPicker(state.currentPlayingSong, fpSaveBtn);
    });
  }

  if (el.fullPlayerProgress) {
    let fpPointerActive = false;
    const scrubFPProgress = (clientX) => {
      if (state.syncSession.sessionId && !state.syncSession.isHost) {
        return;
      }
      const rect = el.fullPlayerProgress.getBoundingClientRect();
      const media = isDiscoverVideoPrimaryActive() ? el.fullPlayerVideo : el.audioPlayer;
      if (!rect.width || !media || !Number.isFinite(media.duration) || media.duration <= 0) {
        return;
      }
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      media.currentTime = media.duration * ratio;
      updatePlayerProgressUI();
    };
    el.fullPlayerProgress.addEventListener("pointerdown", (e) => {
      if (state.syncSession.sessionId && !state.syncSession.isHost) {
        showFlash("Only the host can seek.", true);
        return;
      }
      fpPointerActive = true;
      scrubFPProgress(e.clientX);
    });
    el.fullPlayerProgress.addEventListener("pointermove", (e) => {
      if (fpPointerActive) {
        scrubFPProgress(e.clientX);
      }
    });
    window.addEventListener("pointerup", () => {
      fpPointerActive = false;
    });
  }

  el.fpTabButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetTab = btn.getAttribute("data-fptab");
      if (!targetTab) {
        return;
      }

      el.fpTabButtons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");

      el.fpPanels.forEach((p) => p.classList.remove("active"));
      const targetPanel = document.getElementById(fpPanelElementIdForTab(targetTab));
      if (targetPanel) {
        targetPanel.classList.add("active");
      }

      state.activeFpTab = targetTab;
      if (state.activeFpTab === "queue") {
        renderFullPlayerQueue();
      }
      if (state.activeFpTab === "lyrics") {
        renderFullPlayerLyrics();
      }
      if (state.activeFpTab === "related") {
        void renderFullPlayerRelated();
      }
    });
  });
}

function openFullPlayer() {
  if (!el.fullPlayerOverlay) {
    return;
  }
  const wasSoftHidden = el.fullPlayerOverlay.classList.contains("fp-soft-hidden");
  state.uiPrefs.fullPlayerOpen = true;
  el.fullPlayerOverlay.classList.remove("fp-soft-hidden");
  el.fullPlayerOverlay.classList.remove("hidden");
  document.body.style.overflow = "hidden";

  if (state.currentPlayingSong) {
    if (el.fullPlayerTitle) {
      el.fullPlayerTitle.textContent = state.currentPlayingSong.title || "Unknown";
    }
    if (el.fullPlayerArtist) {
      el.fullPlayerArtist.textContent = state.currentPlayingSong.artist || "Unknown artist";
    }
  }

  const canFastResumeDiscoverVideo =
    wasSoftHidden &&
    fullPlayerVideoResumeState.pending &&
    fullPlayerVideoResumeState.wasVideoMode &&
    Boolean(state.playbackVideoPrimary) &&
    Boolean(el.fullPlayerVideo) &&
    isDiscoverVideoPrimaryActive();
  if (canFastResumeDiscoverVideo) {
    state.fullPlayerMediaMode = "video";
    document.querySelectorAll(".fp-media-seg").forEach((s) => {
      const isVideo = s.getAttribute("data-fpmedia") === "video";
      s.classList.toggle("active", isVideo);
      s.setAttribute("aria-selected", isVideo ? "true" : "false");
    });
    syncFullPlayerTabChrome();
    if (fullPlayerVideoResumeState.wasPlaying && el.fullPlayerVideo?.paused) {
      void el.fullPlayerVideo.play().catch(() => {});
    }
    updatePlayerProgressUI();
    fullPlayerVideoResumeState.pending = false;
    return;
  }

  syncFullPlayerTabChrome();

  if (state.activeFpTab === "queue") {
    renderFullPlayerQueue();
  }
  if (state.activeFpTab === "lyrics") {
    renderFullPlayerLyrics();
  }
  if (state.activeFpTab === "related") {
    void renderFullPlayerRelated();
  }
  if (fullPlayerVideoResumeState.pending && fullPlayerVideoResumeState.wasVideoMode) {
    const currentSongId = Number(state.currentPlayingSong?.id);
    const resumeSongId = Number(fullPlayerVideoResumeState.songId);
    if (
      !state.playbackVideoPrimary &&
      currentSongId > 0 &&
      resumeSongId > 0 &&
      currentSongId === resumeSongId &&
      (fullPlayerVideoResumeState.videoUrl || fullPlayerVideoResumeState.hlsUrl)
    ) {
      state.playbackVideoPrimary = {
        videoUrl: String(fullPlayerVideoResumeState.videoUrl || fullPlayerVideoResumeState.hlsUrl || ""),
        hlsUrl: fullPlayerVideoResumeState.hlsUrl || null,
      };
      attachFullPlayerVideoProgressSync();
    }
    state.fullPlayerMediaMode = "video";
    document.querySelectorAll(".fp-media-seg").forEach((s) => {
      const isVideo = s.getAttribute("data-fpmedia") === "video";
      s.classList.toggle("active", isVideo);
      s.setAttribute("aria-selected", isVideo ? "true" : "false");
    });
  }
  const hasWarmVideoElement = Boolean(
    el.fullPlayerVideo &&
      (el.fullPlayerVideo.currentSrc || el.fullPlayerVideo.getAttribute("src")) &&
      el.fullPlayerVideo.readyState >= 1
  );
  const shouldForceVideoReload =
    fullPlayerVideoResumeState.pending &&
    fullPlayerVideoResumeState.wasVideoMode &&
    Boolean(state.playbackVideoPrimary) &&
    Boolean(el.fullPlayerVideo) &&
    !hasWarmVideoElement;
  if (shouldForceVideoReload && el.fullPlayerVideo) {
    // Hidden overlays may drop media internals; force a clean source rebind before sync.
    delete el.fullPlayerVideo.dataset.fpPrimaryLoadKey;
    teardownDiscoverMedia("fpPrimary");
    el.fullPlayerVideo.removeAttribute("src");
    try {
      el.fullPlayerVideo.load();
    } catch {
      /* ignore */
    }
  }
  syncFullPlayerMedia();
  if (
    state.fullPlayerMediaMode === "video" &&
    !isDiscoverVideoPrimaryActive() &&
    state.currentPlayingSong?.id &&
    !hasWarmVideoElement
  ) {
    void (async () => {
      const restored = await restoreDiscoverPrimaryVideoForCurrentSong();
      if (!restored) {
        return;
      }
      syncFullPlayerMedia();
      const vid = el.fullPlayerVideo;
      if (!vid) {
        return;
      }
      const resumeTime =
        Number.isFinite(fullPlayerVideoResumeState.time) && fullPlayerVideoResumeState.time > 0
          ? Number(fullPlayerVideoResumeState.time)
          : 0;
      const applyResumeTime = () => {
        if (!(resumeTime > 0)) {
          return;
        }
        try {
          const max = Number.isFinite(vid.duration) && vid.duration > 0 ? Math.max(0, vid.duration - 0.1) : resumeTime;
          vid.currentTime = Math.max(0, Math.min(resumeTime, max));
        } catch {
          /* ignore */
        }
      };
      if (vid.readyState >= 1) {
        applyResumeTime();
      } else {
        vid.addEventListener("loadedmetadata", applyResumeTime, { once: true });
      }
      if (fullPlayerVideoResumeState.wasPlaying) {
        const tryResumePlay = () => {
          void vid.play().catch(() => {});
        };
        if (vid.readyState >= 2) {
          tryResumePlay();
        } else {
          vid.addEventListener("canplay", tryResumePlay, { once: true });
        }
      }
      updatePlayerProgressUI();
    })();
  }
  if (fullPlayerVideoResumeState.pending && isDiscoverVideoPrimaryActive() && el.fullPlayerVideo) {
    const vid = el.fullPlayerVideo;
    const { time, wasPlaying } = fullPlayerVideoResumeState;
    const applyResumeTime = () => {
      if (!(Number.isFinite(time) && time > 0)) {
        return;
      }
      try {
        const max = Number.isFinite(vid.duration) && vid.duration > 0 ? Math.max(0, vid.duration - 0.1) : time;
        vid.currentTime = Math.max(0, Math.min(time, max));
      } catch {
        /* ignore */
      }
    };
    if (vid.readyState >= 1) {
      applyResumeTime();
    } else {
      vid.addEventListener("loadedmetadata", applyResumeTime, { once: true });
    }
    if (wasPlaying) {
      const tryResumePlay = () => {
        void vid.play().catch(() => {});
      };
      if (vid.readyState >= 2) {
        tryResumePlay();
      } else {
        vid.addEventListener("canplay", tryResumePlay, { once: true });
      }
    }
    updatePlayerProgressUI();
  }
  fullPlayerVideoResumeState.pending = false;
}

function closeFullPlayer() {
  if (!el.fullPlayerOverlay) {
    return;
  }
  if (isDiscoverVideoPrimaryActive() && el.fullPlayerVideo) {
    const currentSongId = Number(state.currentPlayingSong?.id);
    fullPlayerVideoResumeState.pending = true;
    fullPlayerVideoResumeState.wasVideoMode = state.fullPlayerMediaMode === "video";
    fullPlayerVideoResumeState.wasPlaying = !el.fullPlayerVideo.paused;
    fullPlayerVideoResumeState.time =
      Number.isFinite(el.fullPlayerVideo.currentTime) && el.fullPlayerVideo.currentTime > 0
        ? Number(el.fullPlayerVideo.currentTime)
        : 0;
    fullPlayerVideoResumeState.songId = Number.isFinite(currentSongId) && currentSongId > 0 ? currentSongId : null;
    fullPlayerVideoResumeState.videoUrl = String(state.playbackVideoPrimary?.videoUrl || "");
    fullPlayerVideoResumeState.hlsUrl = state.playbackVideoPrimary?.hlsUrl || null;
  } else {
    fullPlayerVideoResumeState.pending = false;
    fullPlayerVideoResumeState.wasVideoMode = false;
    fullPlayerVideoResumeState.wasPlaying = false;
    fullPlayerVideoResumeState.time = 0;
    fullPlayerVideoResumeState.songId = null;
    fullPlayerVideoResumeState.videoUrl = "";
    fullPlayerVideoResumeState.hlsUrl = null;
  }
  state.uiPrefs.fullPlayerOpen = false;
  if (isDiscoverVideoPrimaryActive()) {
    // Keep overlay mounted so the active video element doesn't lose media pipeline/state.
    el.fullPlayerOverlay.classList.remove("hidden");
    el.fullPlayerOverlay.classList.add("fp-soft-hidden");
  } else {
    el.fullPlayerOverlay.classList.remove("fp-soft-hidden");
    el.fullPlayerOverlay.classList.add("hidden");
  }
  document.body.style.overflow = "";
  removeFpPlaylistMenu();
  removeFpTrackActionSheet();
}

function renderFullPlayerQueue() {
  if (!el.fpQueueList || state.activeFpTab !== "queue") {
    return;
  }

  if (el.fpPlayingFrom) {
    if (state.selectedPlaylistDetail && state.currentPlayingSong) {
      el.fpPlayingFrom.textContent = state.selectedPlaylistDetail.name || "Library";
    } else {
      el.fpPlayingFrom.textContent = "Library";
    }
  }

  if (state.queue.length === 0) {
    renderEmpty(el.fpQueueList, "Queue is empty.");
    return;
  }

  el.fpQueueList.innerHTML = "";
  const remainingQueue = state.queue.slice(Math.max(0, state.queueIndex));

  remainingQueue.forEach((song, idx) => {
    const actualIndex = Math.max(0, state.queueIndex) + idx;
    const row = document.createElement("article");
    row.className = `list-item${actualIndex === state.queueIndex ? " active" : ""}`;
    const artworkUrl = resolveArtworkUrl(song.artwork_url);
    const artHtml = artworkUrl
      ? `<img src="${artworkUrl}" style="width:40px; height:40px; border-radius:4px; object-fit:cover; margin-right:12px; flex-shrink:0;">`
      : `<div style="width:40px; height:40px; border-radius:4px; background:rgba(255,255,255,0.1); display:grid; place-items:center; margin-right:12px; flex-shrink:0;"><i class="material-icons">music_note</i></div>`;
    const nowPlayingIcon =
      actualIndex === state.queueIndex
        ? '<i class="material-icons" style="font-size:14px;color:var(--accent);flex-shrink:0;">volume_up</i>'
        : "";

    row.innerHTML = `
        <div style="display:flex; align-items:center; flex:1; min-width:0; overflow:hidden;">
          ${artHtml}
          <div style="min-width:0; overflow:hidden; flex:1;">
            <div class="song-title" style="display:flex; align-items:center; gap:4px; min-width:0;">
              <span style="flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${song.title || "Unknown"}</span>
              ${nowPlayingIcon}
            </div>
            <div class="song-meta" style="font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${song.artist || "Unknown artist"}</div>
          </div>
        </div>
        <div class="muted" style="font-size:12px; flex-shrink:0; margin-left:8px;">${formatQueueSongDurationLabel(song)}</div>
      `;

    row.addEventListener("click", () => {
      void safeAsyncAction(async () => {
        await playQueueIndex(actualIndex);
      })();
    });
    el.fpQueueList.appendChild(row);
  });
}

function renderFullPlayerLyrics() {
  if (!el.fpLyricsContent || state.activeFpTab !== "lyrics") {
    return;
  }

  const song = state.currentPlayingSong;
  if (!song) {
    return;
  }

  if (song.lyrics && song.lyrics.trim() !== "") {
    el.fpLyricsContent.innerHTML = song.lyrics.replace(/\n/g, "<br>");
  } else {
    el.fpLyricsContent.innerHTML = `
        <div class="muted" style="text-align:center; padding-top:40px; border-radius:12px; height: 100%; display:flex; flex-direction:column; justify-content:center;">
          <i class="material-icons" style="font-size:48px; opacity:0.5; margin-bottom:8px;">lyrics</i>
          <p>No lyrics found for this song.</p>
          <p style="font-size:14px; opacity:0.7; margin-top:8px;">Custom lyrics support is coming soon.</p>
        </div>
      `;
  }
}

async function renderFullPlayerRelated() {
  if (!el.fpRelatedList || state.activeFpTab !== "related") {
    return;
  }
  const fpRelatedPanel = document.getElementById("fpTabRelated");
  let fpRelatedToolbar = document.getElementById("fpRelatedToolbar");
  if (fpRelatedPanel && !fpRelatedToolbar) {
    fpRelatedToolbar = document.createElement("div");
    fpRelatedToolbar.id = "fpRelatedToolbar";
    fpRelatedToolbar.className = "fp-related-toolbar hidden";
    fpRelatedPanel.insertBefore(fpRelatedToolbar, el.fpRelatedList);
  }

  const setRelatedToolbarVisible = (visible) => {
    if (fpRelatedToolbar) {
      fpRelatedToolbar.classList.toggle("hidden", !visible);
      if (!visible) {
        fpRelatedToolbar.innerHTML = "";
      }
    }
  };

  const song = state.currentPlayingSong;

  if (!song || !song.artist) {
    setRelatedToolbarVisible(false);
    renderEmpty(el.fpRelatedList, "No related tracks found.");
    return;
  }

  setRelatedToolbarVisible(false);
  el.fpRelatedList.innerHTML = `<div class="list-item" style="justify-content:center;"><i class="material-icons sync-icon-pulse" style="margin-right:8px;">sync</i> Loading related tracks...</div>`;

  try {
    const rawResult = await request(`/search?q=${encodeURIComponent(normalizeSearchQuery(song.artist))}`);
    const relatedSongs = (rawResult.songs || []).filter((s) => !isSameTrackAsPlaying(s, song)).slice(0, 10);

    if (relatedSongs.length === 0) {
      setRelatedToolbarVisible(false);
      renderEmpty(el.fpRelatedList, "No related tracks found.");
      return;
    }

    if (fpRelatedToolbar) {
      fpRelatedToolbar.innerHTML = "";
      fpRelatedToolbar.classList.remove("hidden");
      const shuffleRelatedBtn = document.createElement("button");
      shuffleRelatedBtn.type = "button";
      shuffleRelatedBtn.className = "btn ghost";
      shuffleRelatedBtn.textContent = "Shuffle related";
      shuffleRelatedBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        void safeAsyncAction(() => shuffleSongsIntoQueue(relatedSongs, { maxItems: 20 }), {
          button: shuffleRelatedBtn,
        })();
      });
      fpRelatedToolbar.appendChild(shuffleRelatedBtn);
    }

    el.fpRelatedList.innerHTML = "";
    for (const track of relatedSongs) {
      const row = document.createElement("article");
      row.className = "list-item fp-related-row";
      const artworkUrl = resolveArtworkUrl(track.artwork_url);
      const artHtml = artworkUrl
        ? `<img src="${artworkUrl}" style="width:40px; height:40px; border-radius:4px; object-fit:cover; margin-right: 12px; flex-shrink:0;">`
        : `<div style="width:40px; height:40px; border-radius:4px; background:rgba(255,255,255,0.1); display:grid; place-items:center; margin-right: 12px; flex-shrink:0;"><i class="material-icons">music_note</i></div>`;

      row.innerHTML = `
          <div style="display:flex; align-items:center; flex:1; min-width:0; overflow:hidden;">
            ${artHtml}
            <div style="min-width:0; overflow:hidden; flex:1;">
              <div class="song-title" style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${track.title || "Unknown"}</div>
              <div class="song-meta" style="font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${track.artist || "Unknown artist"}</div>
            </div>
          </div>
          <div class="fp-related-row-actions">
            <button type="button" class="btn ghost icon-btn fp-play-related" title="Play"><i class="material-icons">play_arrow</i></button>
            <button type="button" class="btn ghost icon-btn fp-related-more" title="More"><i class="material-icons">more_vert</i></button>
          </div>
        `;

      const playBtn = row.querySelector(".fp-play-related");
      const moreBtn = row.querySelector(".fp-related-more");

      playBtn?.addEventListener("click", (e) => {
        e.stopPropagation();
        void safeAsyncAction(async () => {
          await playSong(track);
        }, { button: playBtn })();
      });

      moreBtn?.addEventListener("click", (e) => {
        e.stopPropagation();
        if (moreBtn) {
          openTrackActionSheet(track, moreBtn);
        }
      });

      row.addEventListener("click", (event) => {
        if (event.target instanceof HTMLElement && (event.target.closest("a") || event.target.closest("button"))) {
          return;
        }
        void safeAsyncAction(async () => {
          await playSong(track);
        })();
      });
      el.fpRelatedList.appendChild(row);
    }
  } catch (err) {
    console.error("Failed to load related tracks:", err);
    setRelatedToolbarVisible(false);
    renderEmpty(el.fpRelatedList, "Failed to load related tracks.");
  }
}

function bindEvents() {
  let viewportResizeTimer = null;
  const scheduleViewportSync = () => {
    if (viewportResizeTimer) {
      window.clearTimeout(viewportResizeTimer);
    }
    viewportResizeTimer = window.setTimeout(() => {
      syncSidebarViewportMode();
    }, 120);
  };
  window.addEventListener("resize", scheduleViewportSync);
  window.addEventListener("orientationchange", scheduleViewportSync);

  el.authTabLogin?.addEventListener("click", () => setAuthMode("login"));
  el.authTabRegister?.addEventListener("click", () => setAuthMode("register"));
  el.authTabForgot?.addEventListener("click", () => setAuthMode("forgot"));
  el.goForgotPasswordBtn?.addEventListener("click", () => setAuthMode("forgot"));

  el.loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      if (!applyApiBaseUrlFromForm()) {
        return;
      }
      await login(el.loginEmail.value.trim(), el.loginPassword.value);
      el.loginPassword.value = "";
    } catch (error) {
      showFlash(String(error), true);
    }
  });

  el.registerForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      if (!applyApiBaseUrlFromForm()) {
        return;
      }
      await register(
        el.registerUsername.value.trim(),
        el.registerEmail.value.trim(),
        el.registerPassword.value
      );
      el.registerPassword.value = "";
      setAuthMode("login");
      showFlash("Registration successful. You can login now.");
    } catch (error) {
      showFlash(String(error), true);
    }
  });

  el.forgotPasswordForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      if (!applyApiBaseUrlFromForm()) {
        return;
      }
      await requestPasswordReset(el.forgotEmail.value.trim());
      showFlash("If the email exists, reset instructions were sent. Open the link in the email to set a new password.");
      setAuthMode("login");
    } catch (error) {
      showFlash(String(error), true);
    }
  });

  el.resetPasswordForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const tok = el.resetToken?.value?.trim() || "";
      if (!tok) {
        showFlash("Reset link is missing or expired. Request a new reset email.", true);
        return;
      }
      if (!applyApiBaseUrlFromForm()) {
        return;
      }
      await resetPassword(tok, el.resetNewPassword.value);
      el.resetNewPassword.value = "";
      if (el.resetToken) {
        el.resetToken.value = "";
      }
      teardownMediaAndSyncSession();
      clearAccessTokenOnly();
      setAuthMode("login");
      showFlash("Password reset successful. Please login.");
    } catch (error) {
      showFlash(String(error), true);
    }
  });

  el.logoutBtn.addEventListener("click", () => {
    teardownMediaAndSyncSession();
    clearSession();
    showLogin();
    showFlash("Logged out.");
  });

  el.sidebarToggleBtn?.addEventListener("click", () => {
    state.uiPrefs.sidebarCollapsed = !state.uiPrefs.sidebarCollapsed;
    applySidebarVisibility();
    saveUiPrefs();
  });
  el.sidebarShowBtn?.addEventListener("click", () => {
    state.uiPrefs.sidebarCollapsed = false;
    applySidebarVisibility();
    saveUiPrefs();
  });

  el.quickFavoritesBtn?.addEventListener("click", () => {
    switchView("favoritesView");
  });
  el.quickPlaylistsBtn?.addEventListener("click", () => {
    switchView("playlistsView");
  });
  el.quickFollowingArtistsBtn?.addEventListener("click", () => {
    switchView("libraryArtistsView");
  });

  for (const button of el.menuButtons) {
    button.addEventListener("click", () => switchView(button.dataset.view));
  }

  el.editProfileBtn.addEventListener("click", () => {
    void safeAsyncAction(openCurrentUserProfileView, { button: el.editProfileBtn })();
  });
  if (el.profileForm) {
    el.profileForm.addEventListener("submit", (event) => {
      event.preventDefault();
      void safeAsyncAction(updateProfile, {})();
    });
  }
  if (el.profileEditPhotoBtn && el.profilePhotoInput) {
    el.profileEditPhotoBtn.addEventListener("click", () => {
      el.profilePhotoInput.click();
    });
  }
  if (el.profilePhotoInput) {
    el.profilePhotoInput.addEventListener("change", () => {
      const selectedFile = el.profilePhotoInput.files?.[0];
      if (!selectedFile) {
        return;
      }
      void safeAsyncAction(async () => {
        const dataUrl = await readImageFileAsDataUrl(selectedFile);
        state.profilePrefs.avatarUrl = normalizeProfileAvatarUrl(dataUrl);
        renderProfileAvatarPreview(state.profilePrefs.avatarUrl);
        await updateProfile();
        el.profilePhotoInput.value = "";
      }, {})();
    });
  }
  if (el.profileRemovePhotoBtn) {
    el.profileRemovePhotoBtn.addEventListener(
      "click",
      safeAsyncAction(async () => {
        state.profilePrefs.avatarUrl = "";
        renderProfileAvatarPreview("");
        await updateProfile();
      }, { button: el.profileRemovePhotoBtn })
    );
  }
  if (el.profileAvatarPreview) {
    el.profileAvatarPreview.addEventListener("error", () => {
      if (el.profileAvatarFallback) {
        el.profileAvatarFallback.classList.remove("hidden");
      }
      el.profileAvatarPreview.classList.add("hidden");
    });
  }

  el.searchForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      if (state.searchDebounceTimer) {
        window.clearTimeout(state.searchDebounceTimer);
        state.searchDebounceTimer = null;
      }
      await searchSongs(el.searchQuery.value);
    } catch (error) {
      showFlash(String(error), true);
    }
  });
  el.searchQuery.addEventListener("input", () => {
    if (state.searchDebounceTimer) {
      window.clearTimeout(state.searchDebounceTimer);
    }
    state.searchDebounceTimer = window.setTimeout(() => {
      state.searchDebounceTimer = null;
      void safeAsyncAction(() => searchSongs(el.searchQuery.value), {})();
    }, 300);
  });
  for (const button of el.searchFilterButtons) {
    button.addEventListener("click", () => {
      setSearchFilter(button.dataset.searchFilter);
    });
  }
  el.artistDetailBackBtn.addEventListener("click", () => {
    switchView("searchView");
  });
  el.artistDetailShareBtn?.addEventListener("click", () => {
    void safeAsyncAction(() => shareArtist(state.selectedArtistName), { button: el.artistDetailShareBtn })();
  });
  el.discoverCloseBtn?.addEventListener("click", () => {
    switchView("searchView");
  });
  el.discoverMuteBtn?.addEventListener("click", () => {
    state.discoverReelMuted = !state.discoverReelMuted;
    if (el.discoverMainVideo) {
      el.discoverMainVideo.muted = !!state.discoverReelMuted;
    }
    updateDiscoverMuteButtonUI();
  });
  el.discoverLikeBtn?.addEventListener("click", () => {
    void toggleDiscoverLike();
  });
  el.discoverSaveBtn?.addEventListener("click", () => {
    void toggleDiscoverSave();
  });
  el.discoverShareBtn?.addEventListener("click", () => {
    shareActiveDiscoverSample();
  });
  el.discoverPlayFullBtn?.addEventListener("click", () => {
    void safeAsyncAction(() => playDiscoverSampleInFullPlayer(), { button: el.discoverPlayFullBtn })();
  });
  el.discoverCommentBtn?.addEventListener("click", () => {
    void openDiscoverCommentsPanel();
  });
  el.discoverTabForYou?.addEventListener("click", () => {
    void switchDiscoverListMode("forYou");
  });
  el.discoverTabSaved?.addEventListener("click", () => {
    void switchDiscoverListMode("saved");
  });
  el.discoverCommentsClose?.addEventListener("click", () => closeDiscoverCommentsPanel());
  el.discoverCommentsBackdrop?.addEventListener("click", () => closeDiscoverCommentsPanel());
  el.discoverCommentForm?.addEventListener("submit", (e) => {
    void submitDiscoverComment(e);
  });
  el.discoverCommentReplyCancel?.addEventListener("click", () => clearDiscoverCommentReply());
  el.discoverFullCloseBtn?.addEventListener("click", () => {
    closeDiscoverFullVideo();
  });
  el.discoverArtistBtn?.addEventListener("click", () => {
    const s = getActiveDiscoverSample();
    if (!s || !s.artist_name) {
      return;
    }
    void safeAsyncAction(() => openArtistDetail(s.artist_name), { button: el.discoverArtistBtn })();
  });
  el.artistVideosPrevBtn?.addEventListener("click", () => scrollArtistVideosRail(-1));
  el.artistVideosNextBtn?.addEventListener("click", () => scrollArtistVideosRail(1));
  el.userProfileBackBtn?.addEventListener("click", () => {
    const targetView = state.userProfileBackView || "followingUsersView";
    switchView(targetView);
  });
  el.userProfileShareBtn?.addEventListener("click", () => {
    if (!state.userProfileUsername) return;
    void safeAsyncAction(() => shareUserProfile(state.userProfileUsername), { button: el.userProfileShareBtn })();
  });

  el.artistDetailFilter?.addEventListener("input", () => {
    state.artistDetailFilterQuery = normalizeSearchQuery(el.artistDetailFilter.value || "");
    void safeAsyncAction(async () => {
      if (state.artistDetailFilterQuery) {
        await ensureArtistDetailFullyLoaded();
      }
      renderArtistDetailSongs();
      renderArtistAlbums();
    })();
  });
  el.artistSaveBtn.addEventListener(
    "click",
    safeAsyncAction(() => saveArtistToLibrary(state.selectedArtistName), { button: el.artistSaveBtn })
  );
  el.artistSongsTabBtn?.addEventListener("click", () => {
    switchArtistDetailTab("songs");
  });
  el.artistAlbumsTabBtn?.addEventListener("click", () => {
    switchArtistDetailTab("albums");
  });
  el.artistSongsLoadMoreBtn.addEventListener(
    "click",
    safeAsyncAction(async () => {
      if (!state.selectedArtistName) {
        return;
      }
      clearArtistFullCatalogSchedule();
      const nextLimit = Math.min(ARTIST_DETAIL_SONGS_MAX, state.artistSongsLimit + 500);
      if (nextLimit === state.artistSongsLimit) {
        return;
      }
      state.artistSongsLimit = nextLimit;
      const payload = await fetchArtistDetailSongs(state.selectedArtistName, state.artistSongsLimit, {
        catalogDepth: "full",
      });
      state.artistDetailCatalogComplete = payload.catalog_complete !== false;
      state.artistDetailSource = String(payload.source || state.artistDetailSource || "fallback");
      state.artistDetailArtworkUrl = pickArtistDetailArtworkUrl(
        payload.artist_artwork_url || state.artistDetailArtworkUrl || "",
        state.selectedArtistName,
      );
      state.artistDetailResults = payload.songs || [];
      state.artistSongsTotalAvailable = Number(payload.total_songs_available || state.artistDetailResults.length);
      await preloadSongRelations(state.artistDetailResults);
      renderArtistDetailResults();
      showFlash(`Loaded ${state.artistDetailResults.length} songs.`);
    }, { button: el.artistSongsLoadMoreBtn })
  );

  if (el.artistSongsPrevBtn) el.artistSongsPrevBtn.addEventListener("click", () => changeArtistSongsPage(-1));
  if (el.artistSongsNextBtn) el.artistSongsNextBtn.addEventListener("click", () => changeArtistSongsPage(1));
  if (el.artistAlbumsPrevBtn) el.artistAlbumsPrevBtn.addEventListener("click", () => changeArtistAlbumsPage(-1));
  if (el.artistAlbumsNextBtn) el.artistAlbumsNextBtn.addEventListener("click", () => changeArtistAlbumsPage(1));

  el.createPlaylistForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await createPlaylist(el.playlistName.value.trim(), el.playlistDescription.value.trim());
      el.playlistName.value = "";
      el.playlistDescription.value = "";
      el.createPlaylistForm.closest("details")?.removeAttribute("open");
    } catch (error) {
      showFlash(String(error), true);
    }
  });

  el.discoverPlaylistsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await fetchDiscoverPlaylists(normalizeSearchQuery(el.discoverQuery.value || ""));
      showFlash("Public playlists refreshed.");
    } catch (error) {
      showFlash(String(error), true);
    }
  });
  for (const tabButton of el.playlistTabButtons) {
    tabButton.addEventListener("click", () => {
      setActivePlaylistTab(tabButton.dataset.playlistTab);
    });
  }

  el.clearHistoryBtn.addEventListener("click", () => {
    void safeAsyncAction(clearHistory, { button: el.clearHistoryBtn })();
  });

  el.historySourceFilter.addEventListener("change", () => {
    state.historyFilters.source = el.historySourceFilter.value;
    renderHistory();
  });

  el.historyPeriodFilter.addEventListener("change", () => {
    state.historyFilters.period = el.historyPeriodFilter.value;
    renderHistory();
  });

  if (el.analyticsForm) {
    el.analyticsForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await fetchAnalytics();
        showFlash("Analytics loaded.");
      } catch (error) {
        showFlash(String(error), true);
      }
    });
  }

  el.playerToggleBtn.addEventListener("click", () => {
    if (state.syncSession.sessionId && !state.syncSession.isHost) {
      showFlash("Only the host can control playback.", true);
      return;
    }
    if (!state.currentPlayingSong) {
      return;
    }
    if (isDiscoverVideoPrimaryActive()) {
      const vid = el.fullPlayerVideo;
      if (vid.paused) {
        void vid.play();
      } else {
        vid.pause();
      }
      return;
    }
    if (!el.audioPlayer.src) {
      return;
    }
    if (el.audioPlayer.paused) {
      void el.audioPlayer.play();
      return;
    }
    el.audioPlayer.pause();
  });

  el.playerPrevBtn.addEventListener(
    "click",
    safeAsyncAction(async () => {
      if (state.syncSession.sessionId && !state.syncSession.isHost) {
        showFlash("Only the host can skip tracks.", true);
        return;
      }
      await playPrevInQueue();
    }, { button: el.playerPrevBtn })
  );
  el.playerNextBtn.addEventListener(
    "click",
    safeAsyncAction(async () => {
      if (state.syncSession.sessionId && !state.syncSession.isHost) {
        showFlash("Only the host can skip tracks.", true);
        return;
      }
      await playNextInQueue();
    }, { button: el.playerNextBtn })
  );
  el.playerRepeatBtn.addEventListener("click", () => {
    if (state.syncSession.sessionId && !state.syncSession.isHost) {
      showFlash("Only the host can control repeat settings.", true);
      return;
    }
    state.repeatSong = !state.repeatSong;
    syncRepeatButtonsUI();
    showFlash(state.repeatSong ? "Song repeat enabled." : "Song repeat disabled.");
  });
  el.queueRepeatBtn?.addEventListener("click", () => {
    if (state.syncSession.sessionId && !state.syncSession.isHost) {
      showFlash("Only the host can control repeat settings.", true);
      return;
    }
    state.repeatQueue = !state.repeatQueue;
    syncRepeatButtonsUI();
    showFlash(state.repeatQueue ? "Queue repeat enabled." : "Queue repeat disabled.");
  });
  el.playerLikeBtn.addEventListener(
    "click",
    safeAsyncAction(async () => {
      if (!state.currentPlayingSong) {
        return;
      }
      const isFav = state.favorites && state.favorites.some(f => String(f.id) === String(state.currentPlayingSong.id));
      if (isFav) {
        await removeFavorite(state.currentPlayingSong);
      } else {
        await addFavoriteFromSong(state.currentPlayingSong);
      }
    }, { button: el.playerLikeBtn })
  );
  el.playerShareBtn?.addEventListener("click", () => {
    if (!state.currentPlayingSong) {
      return;
    }
    void safeAsyncAction(() => shareSong(state.currentPlayingSong), { button: el.playerShareBtn })();
  });

  el.queueClearBtn.addEventListener("click", () => {
    clearQueue();
    showFlash("Queue cleared.");
  });

  // Queue drawer toggle
  const queueToggleBtn = document.getElementById("queueToggleBtn");
  const queueDrawer = document.getElementById("queueDrawer");
  const queueDrawerCloseBtn = document.getElementById("queueDrawerCloseBtn");
  const setQueueDrawerOpen = (isOpen) => {
    if (!queueDrawer) {
      return;
    }
    queueDrawer.classList.toggle("open", isOpen);
    queueToggleBtn?.classList.toggle("active", isOpen);
    document.body.classList.toggle("queue-open", isOpen && isCompactViewport());
  };
  if (queueToggleBtn && queueDrawer) {
    queueToggleBtn.addEventListener("click", () => {
      const isOpen = !queueDrawer.classList.contains("open");
      setQueueDrawerOpen(isOpen);
    });
  }
  if (queueDrawerCloseBtn && queueDrawer) {
    queueDrawerCloseBtn.addEventListener("click", () => {
      setQueueDrawerOpen(false);
    });
  }
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && queueDrawer?.classList.contains("open")) {
      setQueueDrawerOpen(false);
    }
  });
  document.addEventListener("click", (ev) => {
    if (!queueDrawer || !queueDrawer.classList.contains("open")) return;
    const t = ev.target;
    if (!(t instanceof HTMLElement)) return;
    // If the clicked element was removed from DOM (e.g. by renderQueue re-render),
    // don't treat it as an outside click.
    if (!t.isConnected) return;
    if (!queueDrawer.contains(t) && !queueToggleBtn?.contains(t)) {
      setQueueDrawerOpen(false);
    }
  });

  el.playerHideBtn?.addEventListener("click", () => {
    state.uiPrefs.playerHidden = true;
    applyPlayerBarVisibility();
    saveUiPrefs();
  });
  el.playerShowBtn?.addEventListener("click", () => {
    if (state.activeViewId === "discoverView") {
      return;
    }
    state.uiPrefs.playerHidden = false;
    applyPlayerBarVisibility();
    saveUiPrefs();
  });
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    if (target.id !== "playerShowBtn") {
      return;
    }
    if (state.activeViewId === "discoverView") {
      return;
    }
    state.uiPrefs.playerHidden = false;
    applyPlayerBarVisibility();
    saveUiPrefs();
  });

  el.playerVolume.addEventListener("input", () => {
    applyVolumePercent(Number(el.playerVolume.value));
  });
  bindRangeVolumeTouchSync(el.playerVolume);
  window.addEventListener("online", renderOfflineState);
  window.addEventListener("offline", renderOfflineState);

  el.audioPlayer.addEventListener("pause", () => {
    if (state.playbackVideoPrimary) {
      return;
    }
    el.playerToggleBtn.innerHTML = '<i class="material-icons">play_arrow</i>';
    if (el.fullPlayerPlayIcon) el.fullPlayerPlayIcon.textContent = "play_arrow";
    void safeAsyncAction(() => flushCurrentHistory("pause"))();
  });

  const syncProgress = () => {
    updatePlayerProgressUI();
  };
  el.audioPlayer.addEventListener("timeupdate", syncProgress);
  el.audioPlayer.addEventListener("progress", syncProgress);
  el.audioPlayer.addEventListener("loadedmetadata", syncProgress);
  el.audioPlayer.addEventListener("durationchange", syncProgress);
  el.audioPlayer.addEventListener("seeking", syncProgress);
  el.audioPlayer.addEventListener("playing", syncProgress);
  el.audioPlayer.addEventListener("playing", () => {
    if (state.playbackVideoPrimary) {
      return;
    }
    startPlaybackClock();
    el.playerToggleBtn.innerHTML = '<i class="material-icons">pause</i>';
    if (el.fullPlayerPlayIcon) el.fullPlayerPlayIcon.textContent = "pause";
  });
  el.audioPlayer.addEventListener("waiting", syncProgress);

  el.audioPlayer.addEventListener("error", () => {
    const source = String(el.audioPlayer.currentSrc || "");
    if (source.includes("/stream/")) {
      const fallbackUrl = String(state.currentPlayingSong?.preview_url || "").trim();
      if (fallbackUrl) {
        el.audioPlayer.src = fallbackUrl;
        void el.audioPlayer.play()
          .then(() => {
            showFlash("Local stream unavailable. Switched to server URL.");
          })
          .catch(() => {
            showFlash("Cannot play this song source.", true);
          });
        return;
      }
      showFlash("Local stream unavailable for this song.", true);
    }
  });

  el.playerProgress.addEventListener("click", (event) => {
    if (state.syncSession.sessionId && !state.syncSession.isHost) {
      showFlash("Only the host can seek.", true);
      return;
    }
    const rect = el.playerProgress.getBoundingClientRect();
    const media = isDiscoverVideoPrimaryActive() ? el.fullPlayerVideo : el.audioPlayer;
    if (!rect.width || !media || !Number.isFinite(media.duration) || media.duration <= 0) {
      return;
    }
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    media.currentTime = media.duration * ratio;
    updatePlayerProgressUI();
  });
  let progressPointerActive = false;
  const scrubPlayerProgress = (clientX) => {
    const rect = el.playerProgress.getBoundingClientRect();
    const media = isDiscoverVideoPrimaryActive() ? el.fullPlayerVideo : el.audioPlayer;
    if (!rect.width || !media || !Number.isFinite(media.duration) || media.duration <= 0) {
      return;
    }
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    media.currentTime = media.duration * ratio;
    updatePlayerProgressUI();
  };
  el.playerProgress.addEventListener("pointerdown", (event) => {
    if (state.syncSession.sessionId && !state.syncSession.isHost) {
      showFlash("Only the host can seek.", true);
      return;
    }
    progressPointerActive = true;
    scrubPlayerProgress(event.clientX);
  });
  el.playerProgress.addEventListener("pointermove", (event) => {
    if (!progressPointerActive) {
      return;
    }
    scrubPlayerProgress(event.clientX);
  });
  el.playerProgress.addEventListener("pointerup", () => {
    progressPointerActive = false;
  });
  el.playerProgress.addEventListener("pointercancel", () => {
    progressPointerActive = false;
  });

  el.audioPlayer.addEventListener("ended", () => {
    void safeAsyncAction(async () => {
      flushCurrentHistory("ended").catch(console.error);
      if (state.syncSession.sessionId && !state.syncSession.isHost) {
        // Participants wait for host SYNC message
        return;
      }
      if (state.repeatSong && state.currentPlayingSong && el.audioPlayer.src) {
        resetHistoryPlaybackTracking();
        state.lastHistorySentMs = 0;
        el.audioPlayer.currentTime = 0;
        await el.audioPlayer.play();
        updatePlayerProgressUI();
        return;
      }
      await playNextInQueue();
    })();
  });

  syncRepeatButtonsUI();

  initFullPlayer();

  document.addEventListener("visibilitychange", onDocumentVisibilityForDataRefresh);
  window.addEventListener("hashchange", handleHash);
}


function consumePasswordResetTokenFromNavigation() {
  const fromQuery = new URLSearchParams(window.location.search).get("reset_token");
  const hashPart = window.location.hash.replace(/^#/, "");
  let fromHash = null;
  if (hashPart) {
    fromHash = new URLSearchParams(hashPart).get("reset_token");
  }
  const token = String(fromQuery || fromHash || "").trim();
  if (!token || !el.resetToken) {
    return;
  }
  el.resetToken.value = token;
  setAuthMode("reset");
  const cleanUrl = `${window.location.origin}${window.location.pathname}`;
  window.history.replaceState({}, document.title, cleanUrl);
  queueMicrotask(() => el.resetNewPassword?.focus());
}

async function boot() {
  initPerfFromUrl();
  loadSession();
  syncAudioPrefsUI();
  applySidebarVisibility();
  applyPlayerBarVisibility();
  setAuthMode("login");
  consumePasswordResetTokenFromNavigation();
  renderOfflineState();
  renderQueue();
  void registerServiceWorker();
  bindEvents();
  setActivePlaylistTab(state.activePlaylistTab);
  updatePlayerProgressUI();
  renderSearchResults();
  renderSearchArtistRail();
  renderSearchRecommendationRail();
  void loadSearchProfilesForActiveArtist();
  renderArtistDetailResults();
  renderFavorites();
  renderHistory();
  renderFollowingUsers();
  renderAnalytics();
  renderPlaylists();
  renderDiscoverPlaylists();
  renderFollowingPlaylists();
  renderPlaylistDetail();

  if (!state.token) {

    showLogin();
    return;
  }

  try {
    await loadAudioPrefs();
    await loadProfile();
    showApp();
    startSocialSyncTimer();
    startDataRefreshTimer();
    const navigatedFromHash = await handleHash();
    if (!navigatedFromHash) {
      switchView("searchView");
    }
    await refreshAllData();
    if (!state.queue.length) {
      await restorePlaybackFromStorage();
    }
  } catch (error) {
    clearSession();
    showLogin();
    showFlash(String(error), true);
  }
}

/* ============================================================
   NEW VIEWS — Browse, For You, Library Albums/Artists, Sidebar Playlists
   ============================================================ */


async function fetchTopTracksByGenre(genre, limit) {
  const safeGenre = normalizeGenreQueryParam(genre);
  if (!safeGenre) {
    return [];
  }
  const safeLimit = Math.max(1, Math.min(50, Number(limit || state.analytics.limit || 10)));
  const safeDays = Math.max(1, Math.min(365, Number(state.analytics.days || 30)));
  return request(
    `/analytics/top-tracks-by-genre?genre=${encodeURIComponent(safeGenre)}&days=${safeDays}&limit=${safeLimit}`
  );
}

async function hydrateSongRowsById(rows) {
  const entries = Array.isArray(rows) ? rows : [];
  if (entries.length === 0) {
    return [];
  }
  const hydrated = await Promise.allSettled(
    entries.map(async (entry) => {
      const songId = Number(entry.song_id || 0);
      if (!songId) {
        return null;
      }
      const fullSong = await request(`/songs/${songId}`);
      return {
        ...fullSong,
        plays: Number(entry.plays || 0),
      };
    })
  );
  return hydrated
    .filter((result) => result.status === "fulfilled" && result.value)
    .map((result) => result.value);
}

function focusBrowseGenreTracksPanel() {
  const target = elNew.browseGenreTracksTitle || elNew.browseGenreTracksList;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const scrollBehavior = prefersReducedMotion() ? "auto" : "smooth";
  const scrollBlock = isCompactViewport() ? "nearest" : "start";
  window.requestAnimationFrame(() => {
    target.scrollIntoView({ behavior: scrollBehavior, block: scrollBlock, inline: "nearest" });
  });
}

function renderBrowseGenreTracksPanel() {
  if (!elNew.browseGenreTracksList || !elNew.browseGenreTracksMeta || !elNew.browseGenreTracksTitle) {
    return;
  }
  const selectedGenre = String(state.browseGenreName || "").trim();
  const selectedLimit = Number(state.browseGenreTracksLimit || 0);
  const tracks = Array.isArray(state.browseGenreTracks) ? state.browseGenreTracks : [];
  if (!selectedGenre) {
    elNew.browseGenreTracksTitle.textContent = "Genre Tracks";
    elNew.browseGenreTracksMeta.textContent = "Select a genre to list top tracks.";
    renderEmpty(elNew.browseGenreTracksList, "No genre selected.");
    return;
  }
  elNew.browseGenreTracksTitle.textContent = `Top ${selectedLimit || tracks.length || 0} • ${selectedGenre}`;
  if (state.browseGenreLoading) {
    elNew.browseGenreTracksMeta.textContent = "Loading tracks...";
    renderEmpty(elNew.browseGenreTracksList, "Loading tracks...");
    return;
  }
  if (tracks.length === 0) {
    elNew.browseGenreTracksMeta.textContent = `No tracks found for ${selectedGenre}.`;
    renderEmpty(elNew.browseGenreTracksList, "No tracks found.");
    return;
  }
  elNew.browseGenreTracksMeta.textContent = `Most played tracks for ${selectedGenre}.`;
  elNew.browseGenreTracksList.innerHTML = "";
  for (const song of tracks) {
    const row = buildSongItem(song, {
      onFavorite: addFavoriteFromSong,
      favoriteLabel: "Add Favorite",
      onPlaylistAdd: addSongToPlaylist,
      relation: null,
    });
    row.classList.add("clickable");
    row.addEventListener("click", (event) => {
      if (event.target instanceof HTMLElement && event.target.closest("button, select, input, a")) {
        return;
      }
      if (!song.preview_url && !(song.is_local === true && song.id && song.file_path)) {
        showFlash("This track has no preview/playable source.", true);
        return;
      }
      void safeAsyncAction(async () => {
        await playSong(song);
      })();
    });
    elNew.browseGenreTracksList.appendChild(row);
  }
}

/* Moods & Activities data — genre-like categories with colors and icons */
const MOODS_DATA = [
  { name: "Workout", icon: "fitness_center", bg: "linear-gradient(135deg, #e53935, #b71c1c)" },
  { name: "Focus", icon: "psychology", bg: "linear-gradient(135deg, #1e88e5, #0d47a1)" },
  { name: "Party", icon: "celebration", bg: "linear-gradient(135deg, #f9a825, #e65100)" },
  { name: "Chill", icon: "spa", bg: "linear-gradient(135deg, #26a69a, #00695c)" },
  { name: "Driving", icon: "directions_car", bg: "linear-gradient(135deg, #5e35b1, #311b92)" },
  { name: "Romance", icon: "favorite", bg: "linear-gradient(135deg, #ec407a, #880e4f)" },
  { name: "Sleep", icon: "bedtime", bg: "linear-gradient(135deg, #3949ab, #1a237e)" },
  { name: "Pop", icon: "star", bg: "linear-gradient(135deg, #00bcd4, #006064)" },
  { name: "Rock", icon: "music_note", bg: "linear-gradient(135deg, #ff7043, #bf360c)" },
  { name: "Hip Hop", icon: "headphones", bg: "linear-gradient(135deg, #ab47bc, #4a148c)" },
  { name: "Electronic", icon: "equalizer", bg: "linear-gradient(135deg, #00e676, #1b5e20)" },
  { name: "Jazz", icon: "piano", bg: "linear-gradient(135deg, #8d6e63, #3e2723)" },
];

function renderSkeletonRail(container, count, type) {
  container.innerHTML = "";
  for (let i = 0; i < count; i++) {
    if (type === "jumpback") {
      container.innerHTML += '<div class="skeleton-jumpback skeleton-rect"></div>';
    } else if (type === "circle") {
      container.innerHTML += '<div class="skeleton-circle"><div class="skeleton-rect skeleton-circle-artwork"></div><div class="skeleton-rect skeleton-text"></div></div>';
    } else {
      container.innerHTML += '<div class="skeleton-card"><div class="skeleton-rect skeleton-artwork"></div><div class="skeleton-rect skeleton-text"></div><div class="skeleton-rect skeleton-text-sm"></div></div>';
    }
  }
}

function buildMediaCard(song, opts = {}) {
  const artworkUrl = resolveArtworkUrl(song.artwork_url);
  const card = document.createElement("article");
  card.className = opts.className || "media-card";
  card.innerHTML = `
    <div class="media-card-artwork">
      ${artworkUrl
        ? `<img src="${artworkUrl}" alt="Artwork" loading="lazy" referrerpolicy="no-referrer">`
        : artworkFallbackMarkup(song)}
      <button class="media-card-play" type="button"><i class="material-icons">play_arrow</i></button>
    </div>
    <div class="media-card-title">${song.title || "Unknown"}</div>
    <div class="media-card-meta">${song.artist || "Unknown artist"}${opts.extraMeta ? " • " + opts.extraMeta : ""}</div>
  `;
  const artworkContainer = card.querySelector(".media-card-artwork");
  const artworkImage = artworkContainer ? artworkContainer.querySelector("img") : null;
  if (artworkContainer && artworkImage) {
    artworkImage.addEventListener("error", () => {
      artworkContainer.innerHTML = artworkFallbackMarkup(song) + '<button class="media-card-play" type="button"><i class="material-icons">play_arrow</i></button>';
    });
  }
  card.addEventListener("click", () => {
    void safeAsyncAction(async () => {
      if (typeof opts.onClick === "function") {
        await opts.onClick(song);
      } else {
        await playSong(song);
      }
    })();
  });
  return card;
}

function renderBrowseHeroBanner() {
  if (!elNew.browseHeroBanner) return;
  const tracks = (state.analytics.topTracks || []).slice(0, 5);
  const artists = (state.topArtists || []).slice(0, 5);
  const items = [];

  for (const track of tracks) {
    items.push({
      title: track.title,
      meta: `${track.artist} • ${track.plays} plays`,
      artwork: resolveArtworkUrl(track.artwork_url) || "",
      onClick: async () => {
        const songId = Number(track.song_id || 0);
        if (!songId) return;
        const song = await request(`/songs/${songId}`);
        await playSong(song);
      },
    });
  }
  for (const artist of artists.slice(0, Math.max(0, 5 - items.length))) {
    const name = String(artist.artist || "");
    items.push({
      title: name,
      meta: artist.source === "trending" ? "Trending" : "For you",
      artwork: resolveStableArtistArtworkUrl(name, artist.artwork_url) || "",
      onClick: async () => {
        el.searchQuery.value = name;
        await openArtistDetail(name);
      },
    });
  }

  if (items.length === 0) {
    elNew.browseHeroBanner.innerHTML = "<div class='empty'>No featured content yet.</div>";
    return;
  }

  const bannerItems = items.slice(0, 5);
  elNew.browseHeroBanner.innerHTML = "";
  const track = document.createElement("div");
  track.className = "hero-banner-track";
  for (const item of bannerItems) {
    const slide = document.createElement("div");
    slide.className = "hero-banner-card";
    slide.innerHTML = `
      ${item.artwork ? `<img src="${item.artwork}" alt="${item.title}" loading="lazy" referrerpolicy="no-referrer">` : ""}
      <div class="hero-banner-overlay">
        <div class="hero-banner-title">${item.title}</div>
        <div class="hero-banner-meta">${item.meta}</div>
        <button class="hero-banner-btn" type="button"><i class="material-icons" style="font-size:18px">play_arrow</i> Listen Now</button>
      </div>
    `;
    slide.addEventListener("click", () => { void safeAsyncAction(item.onClick)(); });
    track.appendChild(slide);
  }
  elNew.browseHeroBanner.appendChild(track);

  // Dots sit below the track (not inside the horizontal scroller)
  if (bannerItems.length > 1) {
    const dotsRow = document.createElement("div");
    dotsRow.className = "hero-dots";
    bannerItems.forEach((_, idx) => {
      const dot = document.createElement("button");
      dot.className = "hero-dot" + (idx === 0 ? " active" : "");
      dot.type = "button";
      dot.setAttribute("aria-label", `Featured slide ${idx + 1}`);
      dot.addEventListener("click", (e) => {
        e.stopPropagation();
        const cards = track.querySelectorAll(".hero-banner-card");
        const card = cards[idx];
        if (card) {
          track.scrollTo({ left: card.offsetLeft, behavior: "smooth" });
        }
      });
      dotsRow.appendChild(dot);
    });
    elNew.browseHeroBanner.appendChild(dotsRow);

    let scrollTimer;
    track.addEventListener("scroll", () => {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        const cards = track.querySelectorAll(".hero-banner-card");
        const containerLeft = track.scrollLeft;
        const containerWidth = track.offsetWidth;
        let activeIdx = 0;
        cards.forEach((card, i) => {
          if (Math.abs(card.offsetLeft - containerLeft) < containerWidth * 0.5) activeIdx = i;
        });
        dotsRow.querySelectorAll(".hero-dot").forEach((d, i) => d.classList.toggle("active", i === activeIdx));
      }, 80);
    });
  }
}

function renderBrowseMoodsGrid() {
  if (!elNew.browseMoodsGrid) return;
  elNew.browseMoodsGrid.innerHTML = "";
  for (const mood of MOODS_DATA) {
    const card = document.createElement("div");
    card.className = "mood-card";
    card.style.background = mood.bg;
    card.innerHTML = `
      <i class="material-icons mood-card-icon">${mood.icon}</i>
      <span class="mood-card-name">${mood.name}</span>
    `;
    card.addEventListener("click", () => {
      void safeAsyncAction(async () => {
        const genreName = mood.name;
        state.browseGenreName = genreName;
        state.browseGenreTracksLimit = 10;
        state.browseGenreTracks = [];
        state.browseGenreLoading = true;
        if (elNew.browseGenreSection) elNew.browseGenreSection.style.display = "";
        renderBrowseGenreTracksPanel();
        focusBrowseGenreTracksPanel();
        try {
          const tracks = await fetchTopTracksByGenre(genreName, 10);
          state.browseGenreTracks = await hydrateSongRowsById(tracks);
        } finally {
          state.browseGenreLoading = false;
        }
        renderBrowseGenreTracksPanel();
      })();
    });
    elNew.browseMoodsGrid.appendChild(card);
  }
}

function renderBrowseNewReleases() {
  if (!elNew.browseNewReleases) return;
  // Use recommendations as "new releases" proxy (most recently added/recommended)
  const songs = (state.recommendations || []).map((e) => e.song || e).slice(0, 15);
  if (songs.length === 0) {
    renderSkeletonRail(elNew.browseNewReleases, 5);
    return;
  }
  elNew.browseNewReleases.innerHTML = "";
  for (const song of songs) {
    elNew.browseNewReleases.appendChild(buildMediaCard(song));
  }
}

function renderBrowseTrendingRail() {
  if (!elNew.browseTopTracks) return;
  if (!state.trendingFetchComplete) {
    renderSkeletonRail(elNew.browseTopTracks, 5);
    return;
  }
  const tracks = state.trendingTracks || [];
  if (tracks.length === 0) {
    elNew.browseTopTracks.innerHTML =
      "<div class='empty'>No trending tracks yet. Listening history from the community will appear here.</div>";
    return;
  }
  elNew.browseTopTracks.innerHTML = "";
  for (const item of tracks) {
    const song = {
      id: item.song_id,
      title: item.title,
      artist: item.artist,
      artwork_url: item.artwork_url || "",
      preview_url: item.preview_url || "",
    };
    elNew.browseTopTracks.appendChild(
      buildMediaCard(song, {
        extraMeta: `${item.plays} plays`,
        onClick: async () => {
          const songId = Number(item.song_id || 0);
          if (!songId) return;
          const fullSong = await request(`/songs/${songId}`);
          await playSong(fullSong);
        },
      })
    );
  }
}

function renderBrowseView() {
  renderBrowseHeroBanner();
  renderBrowseTrendingRail();

  // Popular Artists rail
  if (!elNew.browseArtistRail) return;
  if (state.topArtists.length === 0) {
    elNew.browseArtistRail.innerHTML = "<div class='empty'>No popular artists yet.</div>";
  } else {
    elNew.browseArtistRail.innerHTML = "";
    for (const artistItem of state.topArtists) {
      const artistName = String(artistItem.artist || "Unknown artist");
      const artworkUrl = resolveStableArtistArtworkUrl(artistName, artistItem.artwork_url);
      const source = String(artistItem.source || "");
      const sourceText = source === "personal" ? "For you" : source === "trending" ? "Trending" : "";
      const card = document.createElement("article");
      card.className = "artist-rail-card";
      card.tabIndex = 0;
      card.innerHTML = `
        <div class="artist-rail-artwork">
          ${artworkUrl
            ? `<img src="${artworkUrl}" alt="${artistName}" loading="lazy" referrerpolicy="no-referrer">`
            : artworkFallbackMarkup({ title: artistName, artist: artistName })}
        </div>
        <div class="artist-rail-name">${artistName}</div>
        <div class="artist-rail-meta">${sourceText}</div>
      `;
      const artworkContainer = card.querySelector(".artist-rail-artwork");
      const artworkImage = artworkContainer ? artworkContainer.querySelector("img") : null;
      if (artworkContainer && artworkImage) {
        artworkImage.addEventListener("error", () => {
          artworkContainer.innerHTML = artworkFallbackMarkup({ title: artistName, artist: artistName });
        });
      }
      card.addEventListener("click", () => {
        void safeAsyncAction(async () => {
          el.searchQuery.value = artistName;
          await openArtistDetail(artistName);
        })();
      });
      elNew.browseArtistRail.appendChild(card);
    }
  }

  // Hidden browseTopGenres — keep for data compatibility
  if (elNew.browseTopGenres) {
    elNew.browseTopGenres.innerHTML = "";
  }

  renderBrowseGenreTracksPanel();
}

function getForYouGreeting() {
  const hour = new Date().getHours();
  const name = (state.user && state.user.username) ? state.user.username : "";
  let greeting;
  if (hour < 6) greeting = "Good Night";
  else if (hour < 12) greeting = "Good Morning";
  else if (hour < 18) greeting = "Good Afternoon";
  else greeting = "Good Evening";
  return name ? `${greeting}, ${name}!` : `${greeting}!`;
}

function renderForYouGreeting() {
  if (!elNew.forYouGreeting) return;
  elNew.forYouGreeting.textContent = getForYouGreeting();
}

function renderForYouJumpBackIn() {
  if (!elNew.forYouJumpBackIn) return;
  // Use recent history entries as "jump back in"
  const recent = (state.history || []).slice(0, 6);
  if (recent.length === 0) {
    renderSkeletonRail(elNew.forYouJumpBackIn, 3, "jumpback");
    return;
  }
  elNew.forYouJumpBackIn.innerHTML = "";
  // Deduplicate by title+artist
  const seen = new Set();
  const items = [];
  for (const entry of recent) {
    const song = entry.song || {
      id: entry.song_id,
      title: entry.track_title || "Unknown",
      artist: entry.track_artist || "",
      artwork_url: entry.track_artwork_url || "",
      preview_url: entry.track_preview_url || "",
      is_local: entry.source_type === "local",
    };
    const key = `${(song.title || "").toLowerCase()}|${(song.artist || "").toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(song);
    if (items.length >= 4) break;
  }
  for (const song of items) {
    const artworkUrl = resolveArtworkUrl(song.artwork_url);
    const card = document.createElement("article");
    card.className = "jumpback-card";
    card.innerHTML = `
      <div class="jumpback-artwork">
        ${artworkUrl
          ? `<img src="${artworkUrl}" alt="Artwork" loading="lazy" referrerpolicy="no-referrer">`
          : artworkFallbackMarkup(song)}
      </div>
      <div class="jumpback-info">
        <div class="jumpback-title">${song.title || "Unknown"}</div>
        <div class="jumpback-meta">${song.artist || "Unknown artist"}</div>
        <button class="jumpback-play" type="button"><i class="material-icons">play_arrow</i></button>
      </div>
    `;
    const artworkContainer = card.querySelector(".jumpback-artwork");
    const artworkImage = artworkContainer ? artworkContainer.querySelector("img") : null;
    if (artworkContainer && artworkImage) {
      artworkImage.addEventListener("error", () => {
        artworkContainer.innerHTML = artworkFallbackMarkup(song);
      });
    }
    card.addEventListener("click", () => {
      void safeAsyncAction(async () => { await playSong(song); })();
    });
    elNew.forYouJumpBackIn.appendChild(card);
  }
}

function renderForYouMixes() {
  if (!elNew.forYouMixes) return;
  // Group recommendations by genre to create "daily mixes"
  const songs = (state.recommendations || []).map((e) => e.song || e);
  if (songs.length === 0) {
    renderSkeletonRail(elNew.forYouMixes, 4);
    return;
  }
  // Group by genre
  const genreMap = new Map();
  for (const song of songs) {
    const genre = String(song.genre || "Mix").trim() || "Mix";
    if (!genreMap.has(genre)) genreMap.set(genre, []);
    genreMap.get(genre).push(song);
  }
  const mixColors = ["#e53935", "#1e88e5", "#43a047", "#f9a825", "#8e24aa", "#00acc1"];
  elNew.forYouMixes.innerHTML = "";
  let colorIdx = 0;
  if (elNew.forYouMixesTitle && state.user && state.user.username) {
    elNew.forYouMixesTitle.textContent = `Made For ${state.user.username}`;
  }
  for (const [genre, genreSongs] of genreMap) {
    const card = document.createElement("article");
    card.className = "mix-card";
    // Build 2x2 collage from up to 4 songs
    const collageImgs = genreSongs.slice(0, 4).map((s) => {
      const url = resolveArtworkUrl(s.artwork_url);
      return url ? `<img src="${url}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<div style="background:${mixColors[colorIdx % mixColors.length]};width:100%;height:100%"></div>`;
    });
    // Fill remaining slots
    while (collageImgs.length < 4) {
      collageImgs.push(`<div style="background:${mixColors[(colorIdx + collageImgs.length) % mixColors.length]};width:100%;height:100%"></div>`);
    }
    card.innerHTML = `
      <div class="mix-card-artwork">${collageImgs.join("")}</div>
      <div class="mix-card-title">${genre} Mix</div>
      <div class="mix-card-meta">${genreSongs.map((s) => s.artist).filter(Boolean).slice(0, 3).join(", ")}</div>
    `;
    card.addEventListener("click", () => {
      void safeAsyncAction(async () => {
        if (genreSongs[0]) await playSong(genreSongs[0]);
      })();
    });
    elNew.forYouMixes.appendChild(card);
    colorIdx++;
  }
}

function renderForYouRecentlyPlayed() {
  if (!elNew.forYouRecentlyPlayed) return;
  const seen = new Set();
  const recent = (state.history || []).filter((entry) => {
    const key =
      (entry.song && entry.song.id) ||
      entry.song_id ||
      `${entry.track_title || ""}|${entry.track_artist || ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  }).slice(0, 20);
  if (recent.length === 0) {
    renderSkeletonRail(elNew.forYouRecentlyPlayed, 5, "circle");
    return;
  }
  elNew.forYouRecentlyPlayed.innerHTML = "";
  for (const entry of recent) {
    const song = entry.song || {
      id: entry.song_id,
      title: entry.track_title || "Unknown",
      artist: entry.track_artist || "",
      artwork_url: entry.track_artwork_url || "",
      preview_url: entry.track_preview_url || "",
      is_local: entry.source_type === "local",
    };
    const artworkUrl = resolveArtworkUrl(song.artwork_url);
    const card = document.createElement("article");
    card.className = "recent-circle-card";
    card.innerHTML = `
      <div class="recent-circle-artwork">
        ${artworkUrl
          ? `<img src="${artworkUrl}" alt="Artwork" loading="lazy" referrerpolicy="no-referrer">`
          : artworkFallbackMarkup(song)}
      </div>
      <div class="recent-circle-title">${song.title || "Unknown"}</div>
      <div class="recent-circle-meta">${song.artist || ""}</div>
    `;
    const artworkContainer = card.querySelector(".recent-circle-artwork");
    const artworkImage = artworkContainer ? artworkContainer.querySelector("img") : null;
    if (artworkContainer && artworkImage) {
      artworkImage.addEventListener("error", () => {
        artworkContainer.innerHTML = artworkFallbackMarkup(song);
      });
    }
    card.addEventListener("click", () => {
      void safeAsyncAction(async () => { await playSong(song); })();
    });
    elNew.forYouRecentlyPlayed.appendChild(card);
  }
}

function renderForYouView() {
  renderForYouGreeting();
  renderForYouJumpBackIn();

  // Because You Listen — recommendation rail
  if (!elNew.forYouRecommendations) return;
  if (state.recommendations.length === 0) {
    elNew.forYouRecommendations.innerHTML =
      "<div class='empty'>No recommendations yet. Listen to music or save favorites so we can suggest similar tracks.</div>";
  } else {
    elNew.forYouRecommendations.innerHTML = "";
    const songs = state.recommendations.map((entry) => entry.song || entry);
    for (const song of songs) {
      const artworkUrl = resolveArtworkUrl(song.artwork_url);
      const card = document.createElement("article");
      card.className = "recommendation-rail-card";
      card.innerHTML = `
        <div class="recommendation-rail-artwork">
          ${artworkUrl
            ? `<img src="${artworkUrl}" alt="Artwork" loading="lazy" referrerpolicy="no-referrer">`
            : artworkFallbackMarkup(song)}
        </div>
        <div class="recommendation-rail-title">${song.title || "Unknown"}</div>
        <div class="recommendation-rail-artist">${song.artist || "Unknown artist"}</div>
      `;
      const artworkContainer = card.querySelector(".recommendation-rail-artwork");
      const artworkImage = artworkContainer ? artworkContainer.querySelector("img") : null;
      if (artworkContainer && artworkImage) {
        artworkImage.addEventListener("error", () => {
          artworkContainer.innerHTML = artworkFallbackMarkup(song);
        });
      }
      card.addEventListener("click", () => {
        void safeAsyncAction(async () => {
          await playSong(song);
        })();
      });
      elNew.forYouRecommendations.appendChild(card);
    }
  }

  renderForYouRecentlyPlayed();
}

function renderLibraryAlbums() {
  if (!elNew.libraryAlbumsGrid) return;
  const albums = state.libraryCollections.albums || [];

  if (albums.length === 0) {
    elNew.libraryAlbumsGrid.innerHTML = "<div class='empty'>No saved albums yet. Save albums from artist pages.</div>";
    return;
  }

  elNew.libraryAlbumsGrid.innerHTML = "";
  for (const album of albums) {
    const artworkUrl = resolveArtworkUrl(album.artwork_url);
    const card = document.createElement("article");
    card.className = "library-card";
    card.innerHTML = `
      <div class="library-card-artwork">
        ${
          artworkUrl
            ? `<img src="${artworkUrl}" alt="${album.album_title || "Album artwork"}" loading="lazy" referrerpolicy="no-referrer">`
            : '<i class="material-icons">album</i>'
        }
      </div>
      <div class="library-card-title">${album.album_title || "Unknown Album"}</div>
      <div class="library-card-meta">${album.artist_name || "Unknown Artist"}</div>
    `;
    card.addEventListener("click", () => {
      void safeAsyncAction(async () => {
        if (!album.artist_name) {
          throw new Error("Album artist is not available.");
        }
        el.searchQuery.value = album.artist_name;
        await openAlbumOnArtistPage(album.artist_name, album.album_title || "", { anchorElement: card });
      })();
    });
    elNew.libraryAlbumsGrid.appendChild(card);
  }
}

function renderLibraryArtists() {
  if (!elNew.libraryArtistsGrid) return;
  const artists = state.libraryCollections.artists || [];

  if (artists.length === 0) {
    elNew.libraryArtistsGrid.innerHTML = "<div class='empty'>No saved artists yet. Save artists from artist detail pages.</div>";
    return;
  }

  elNew.libraryArtistsGrid.innerHTML = "";
  for (const artist of artists) {
    const artworkUrl = resolveArtworkUrl(artist.artwork_url);
    const card = document.createElement("article");
    card.className = "library-card";
    card.innerHTML = `
      <div class="library-card-artwork round">
        ${
          artworkUrl
            ? `<img src="${artworkUrl}" alt="${artist.artist_name || "Artist artwork"}" loading="lazy" referrerpolicy="no-referrer">`
            : '<i class="material-icons">person</i>'
        }
      </div>
      <div class="library-card-title">${artist.artist_name || "Unknown Artist"}</div>
      <div class="library-card-meta">Saved artist</div>
    `;
    card.addEventListener("click", () => {
      void safeAsyncAction(async () => {
        el.searchQuery.value = artist.artist_name;
        await openArtistDetail(artist.artist_name);
      })();
    });
    elNew.libraryArtistsGrid.appendChild(card);
  }
}

function renderSidebarPlaylists() {
  if (!elNew.sidebarPlaylistList) return;

  if (state.playlists.length === 0) {
    elNew.sidebarPlaylistList.innerHTML = "";
    return;
  }

  elNew.sidebarPlaylistList.innerHTML = "";
  for (const playlist of state.playlists) {
    const item = document.createElement("div");
    item.className = "sidebar-playlist-item";
    item.innerHTML = `<i class="material-icons">queue_music</i> ${playlist.name || "Untitled"}`;
    item.addEventListener("click", () => {
      switchView("playlistsView");
      void safeAsyncAction(() => openPlaylist(playlist.id))();
    });
    elNew.sidebarPlaylistList.appendChild(item);
  }
}

function renderAllNewViews() {
  renderBrowseView();
  renderForYouView();
  renderLibraryAlbums();
  renderLibraryArtists();
  renderSidebarPlaylists();
}

// Hook into existing render lifecycle
const _origRenderPlaylists = renderPlaylists;
renderPlaylists = function() {
  _origRenderPlaylists();
  renderSidebarPlaylists();
};

const _origRenderSearchArtistRail = renderSearchArtistRail;
renderSearchArtistRail = function() {
  _origRenderSearchArtistRail();
  renderBrowseView();
};

const _origRenderSearchRecommendationRail = renderSearchRecommendationRail;
renderSearchRecommendationRail = function() {
  _origRenderSearchRecommendationRail();
  renderForYouView();
};

const _origRenderFavorites = renderFavorites;
renderFavorites = function() {
  _origRenderFavorites();
  renderLibraryAlbums();
  renderLibraryArtists();
};

const _origRenderHistory = renderHistory;
renderHistory = function() {
  _origRenderHistory();
  renderForYouJumpBackIn();
  renderForYouRecentlyPlayed();
};

const _origRenderAnalytics = renderAnalytics;
renderAnalytics = function() {
  _origRenderAnalytics();
  renderBrowseView();
};

// ============================================================
//  MOBILE BOTTOM NAV & MENU OVERLAY
// ============================================================
(function initMobileNav() {
  const bottomNav = document.getElementById("mobileBottomNav");
  const menuOverlay = document.getElementById("mobileMenuOverlay");
  const menuCloseBtn = document.getElementById("mobileMenuCloseBtn");

  if (!bottomNav || !menuOverlay) return;

  // Mobile bottom nav — view buttons
  for (const btn of bottomNav.querySelectorAll(".mobile-nav-btn[data-view]")) {
    btn.addEventListener("click", () => {
      switchView(btn.dataset.view);
      // Close menu overlay if open
      closeMobileMenu();
    });
  }

  // Mobile bottom nav — "More" button opens overlay
  const moreBtn = bottomNav.querySelector("[data-mobile-menu]");
  if (moreBtn) {
    moreBtn.addEventListener("click", () => {
      openMobileMenu();
    });
  }

  // Mobile menu overlay — item clicks
  for (const item of menuOverlay.querySelectorAll(".mobile-menu-item[data-view]")) {
    item.addEventListener("click", () => {
      switchView(item.dataset.view);
      closeMobileMenu();
    });
  }

  // Close button
  if (menuCloseBtn) {
    menuCloseBtn.addEventListener("click", closeMobileMenu);
  }

  // Close on backdrop click
  menuOverlay.addEventListener("click", (e) => {
    if (e.target === menuOverlay) {
      closeMobileMenu();
    }
  });

  function openMobileMenu() {
    menuOverlay.style.display = "block";
    // Force reflow for animation
    void menuOverlay.offsetHeight;
    menuOverlay.classList.add("open");
  }

  function closeMobileMenu() {
    menuOverlay.classList.remove("open");
    setTimeout(() => {
      if (!menuOverlay.classList.contains("open")) {
        menuOverlay.style.display = "none";
      }
    }, 300);
  }

  // ---- Mobile Volume Popup (− / + stepper, z-index üstte) ----
  const mobileVolBtn = document.getElementById("mobileVolumeBtn");
  const mobileVolPopup = document.getElementById("mobileVolumePopup");
  const mobileVolDown = document.getElementById("mobileVolumeDown");
  const mobileVolUp = document.getElementById("mobileVolumeUp");

  if (mobileVolBtn && mobileVolPopup && mobileVolDown && mobileVolUp) {
    const syncMobileVolumePopupFromState = () => {
      updateMobileVolumeIcon(Math.round(state.audioPrefs.volume * 100));
    };

    syncMobileVolumePopupFromState();

    mobileVolPopup.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
    });

    mobileVolBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      mobileVolPopup.classList.toggle("open");
      syncMobileVolumePopupFromState();
    });

    mobileVolDown.addEventListener("click", (e) => {
      e.stopPropagation();
      bumpVolumePercent(-10);
    });
    mobileVolUp.addEventListener("click", (e) => {
      e.stopPropagation();
      bumpVolumePercent(10);
    });

    document.addEventListener("click", (e) => {
      const t = e.target;
      if (!(t instanceof Node)) {
        return;
      }
      if (!mobileVolPopup.contains(t) && t !== mobileVolBtn && !mobileVolBtn.contains(t)) {
        mobileVolPopup.classList.remove("open");
      }
    });
  }

  // ---- Listen Together Manager ----
  class ListenTogetherManager {
    constructor() {
      this.initEventListeners();
    }

    initEventListeners() {
      el.listenTogetherBtn?.addEventListener("click", () => this.toggleOverlay());
      el.syncOverlayCloseBtn?.addEventListener("click", () => this.toggleOverlay());
      el.startSyncSessionBtn?.addEventListener("click", () => this.createSession());
      el.endSyncSessionBtn?.addEventListener("click", () => this.endSession());
      el.leaveSyncSessionBtn?.addEventListener("click", () => this.leaveSession());
      el.copySyncLinkBtn?.addEventListener("click", () => this.copyId());
      el.syncJoinBtn?.addEventListener("click", () => this.joinById());
      el.syncStartScannerBtn?.addEventListener("click", () => this.startScanning());
      el.syncStopScannerBtn?.addEventListener("click", () => this.stopScanning());
      el.syncTapToListenBtn?.addEventListener("click", () => this.onTapToListen());

      // Playback event listeners for host sync
      el.audioPlayer.addEventListener("play", () => this.sendStateUpdate());
      el.audioPlayer.addEventListener("pause", () => this.sendStateUpdate());
      el.audioPlayer.addEventListener("seeked", () => this.sendStateUpdate());

      // Chat form
      el.syncChatForm?.addEventListener("submit", (e) => {
        e.preventDefault();
        this.sendChatMessage();
      });

      el.syncChatInput?.addEventListener("focus", () => {
        // Scroll grid layout to bottom when keyboard opens
        setTimeout(() => {
          const gridLayout = document.querySelector(".sync-grid-layout");
          if (gridLayout && window.innerWidth < 800) {
            gridLayout.scrollTo({ top: gridLayout.scrollHeight, behavior: "smooth" });
          }
        }, 300);
      });
    }

    toggleOverlay() {
      const wasHidden = el.syncOverlay.classList.contains("hidden");
      el.syncOverlay.classList.toggle("hidden");
      if (wasHidden) {
        void loadSyncVendorScripts().catch(() => {});
      }
      this.updateUI();
    }

    updateUI() {
      el.syncJoinView.classList.add("hidden");
      el.syncHostView.classList.add("hidden");
      el.syncParticipantView.classList.add("hidden");
      el.syncSharedView.classList.add("hidden");
      el.syncCurrentSongInfo.classList.add("hidden");

      if (!state.syncSession.sessionId) {
        el.syncJoinView.classList.remove("hidden");
        document.getElementById("playerBar")?.classList.remove("player-controls-restricted");
      } else {
        // Show shared chat view regardless of host status if in session
        el.syncSharedView.classList.remove("hidden");
        
        // Show current song info if available
        if (state.currentPlayingSong) {
          this.updateParticipantStatus(state.currentPlayingSong);
        }

        if (state.syncSession.isHost) {
          el.syncHostView.classList.remove("hidden");
          el.syncSessionIdText.textContent = state.syncSession.sessionId;
          this.renderQrCode();
          document.getElementById("playerBar")?.classList.remove("player-controls-restricted");
        } else {
          el.syncParticipantView.classList.remove("hidden");
          document.getElementById("playerBar")?.classList.add("player-controls-restricted");
          if (el.syncTapToListenWrap) {
            el.syncTapToListenWrap.classList.toggle("hidden", !state.syncPlaybackBlocked);
          }
        }
      }
    }

    setSyncPlaybackBlocked(blocked) {
      state.syncPlaybackBlocked = !!blocked;
      if (el.syncTapToListenWrap && state.syncSession.sessionId && !state.syncSession.isHost) {
        el.syncTapToListenWrap.classList.toggle("hidden", !state.syncPlaybackBlocked);
      }
    }

    onTapToListen() {
      if (!state.syncSession.sessionId || state.syncSession.isHost) return;
      el.audioPlayer
        .play()
        .then(() => this.setSyncPlaybackBlocked(false))
        .catch((e) => {
          const blocked = e && e.name === "NotAllowedError";
          showFlash(
            blocked ? "Playback was blocked. Tap again or interact with the page, then retry." : "Could not start playback.",
            true
          );
        });
    }

    renderQrCode() {
      if (!el.qrcode) return;
      el.qrcode.innerHTML = "";
      const joinUrl = `${window.location.origin}/ui/index.html?join=${state.syncSession.sessionId}`;
      void loadSyncVendorScripts()
        .then(() => {
          if (!window.QRCode || !el.qrcode) return;
          el.qrcode.innerHTML = "";
          new window.QRCode(el.qrcode, {
            text: joinUrl,
            width: 100,
            height: 100,
            colorDark: "#000000",
            colorLight: "#ffffff",
            correctLevel: window.QRCode.Level ? window.QRCode.Level.H : 1,
          });
        })
        .catch(() => {
          showFlash("Could not load QR code library.", true);
        });
    }

    async createSession() {
      if (el.startSyncSessionBtn) el.startSyncSessionBtn.disabled = true;
      const originalText = el.startSyncSessionBtn ? el.startSyncSessionBtn.innerText : "Start New Session";
      if (el.startSyncSessionBtn) el.startSyncSessionBtn.innerText = "Creating...";

      console.log("[Sync] Creating new session...");
      try {
        this.clearSessionState();
        const data = await request("/sessions/create", { method: "POST" });
        console.log("[Sync] Session created:", data.session_id);
        
        state.syncSession.sessionId = data.session_id;
        state.syncSession.isHost = true;
        this.connect();
        this.updateUI();
      } catch (err) {
        console.error("[Sync] Failed to create session:", err);
        showFlash(err.message || "Failed to create session", true);
      } finally {
        if (el.startSyncSessionBtn) {
          el.startSyncSessionBtn.disabled = false;
          el.startSyncSessionBtn.innerText = originalText;
        }
      }
    }

    clearSessionState() {
        if (state.syncSession.ws) {
            state.syncSession.ws.onclose = null;
            state.syncSession.ws.onmessage = null;
            state.syncSession.ws.onerror = null;
            state.syncSession.ws.close();
            state.syncSession.ws = null;
        }
        state.syncSession.sessionId = null;
        state.syncSession.isHost = false;
        if (el.syncChatMessages) el.syncChatMessages.innerHTML = "";
        if (el.syncParticipantsList) el.syncParticipantsList.innerHTML = "";
    }

    joinById() {
      const id = el.syncJoinIdInput.value.trim();
      if (!id) return;
      this.join(id);
    }

    join(id) {
      const safeId = sanitizeListenTogetherJoinId(id);
      if (!safeId) {
        showFlash("Invalid session id.", true);
        return;
      }
      this.clearSessionState(); // Reset UI before join
      this.stopScanning();
      state.syncSession.sessionId = safeId;
      state.syncSession.isHost = false;
      this.connect();
      this.updateUI();
    }

    connect() {
      if (state.syncSession.ws) state.syncSession.ws.close();

      const token = state.token || localStorage.getItem("spotify_api_token") || "";
      let wsUrl;
      try {
        wsUrl = sessionWebSocketUrl(state.syncSession.sessionId, token);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        showFlash(msg || "Could not open sync connection.", true);
        return;
      }

      state.syncSession.ws = new WebSocket(wsUrl);

      state.syncSession.ws.onopen = () => {
        // Push current playback once so server gets song_id if music was already playing before the session/WS opened.
        if (state.syncSession.isHost) {
          this.sendStateUpdate();
        }
      };

      state.syncSession.ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === "SYNC" && !state.syncSession.isHost) {
          this.handleSync(data.state);
        } else if (data.type === "PARTICIPANT_LIST") {
          this.renderParticipants(data.participants);
        } else if (data.type === "CHAT_MESSAGE") {
          this.addChatMessage(data);
        } else if (data.type === "CHAT_HISTORY") {
          this.renderChatHistory(data.messages);
        } else if (data.type === "DELETE_MESSAGE") {
          this.removeChatMessage(data.message_id);
        } else if (data.type === "MUTE_UPDATE") {
          // No special action needed, participants list refresh handles it
        }
      };

      state.syncSession.ws.onclose = (e) => {
        if (state.syncSession.sessionId) {
          const reason = e.reason || "Connection lost";
          if (e.code === 1008) {
            showFlash(`Removed from session: ${reason}`, true);
          } else {
            showFlash(`Sync session closed: ${reason}`);
          }
          this.leaveSession();
        }
      };
    }

    async handleSync(serverState) {
      if (!state.token) {
        return;
      }
      if (!serverState.song_id) return;

      const currentId = state.currentPlayingSong?.id;
      const isSameSong = String(currentId) === String(serverState.song_id);

      if (!isSameSong) {
        try {
          const song = await request(`/songs/${serverState.song_id}`);
          if (song) {
            // Wait for playSong to finish loading and starting
            await playSong(song, { isInternal: true });
            this.updateParticipantStatus(song);
          }
        } catch (err) {
          console.error("Failed to sync song:", err);
          const msg = err instanceof Error ? err.message : String(err);
          showFlash(msg || "Could not load synced song.", true);
          return;
        }
      }

      // After song is potentially changed and started, sync play/pause state
      if (serverState.is_playing) {
        if (el.audioPlayer.paused) {
          try {
            await el.audioPlayer.play();
            this.setSyncPlaybackBlocked(false);
          } catch (e) {
            console.warn("Failed to trigger play during sync:", e);
            if (e && e.name === "NotAllowedError") {
              this.setSyncPlaybackBlocked(true);
            }
          }
        } else {
          this.setSyncPlaybackBlocked(false);
        }
      } else {
        if (!el.audioPlayer.paused) {
          el.audioPlayer.pause();
        }
        this.setSyncPlaybackBlocked(false);
      }

      // Sync progress if difference is significant (> 2s)
      const localProgress = el.audioPlayer.currentTime;
      const serverProgress = (Number(serverState.progress_ms) || 0) / 1000;
      if (Math.abs(localProgress - serverProgress) > 2) {
        el.audioPlayer.currentTime = serverProgress;
      }
    }

    updateParticipantStatus(song) {
      if (!song || !el.syncCurrentSongInfo) return;
      el.syncCurrentSongInfo.classList.remove("hidden");
      if (el.syncSongArtwork) el.syncSongArtwork.src = song.artwork_url || "";
      if (el.syncSongTitle) el.syncSongTitle.textContent = song.title || "Unknown Title";
      if (el.syncSongArtist) el.syncSongArtist.textContent = song.artist || "Unknown Artist";
    }

    renderParticipants(participants) {
      if (!el.syncParticipantsList) return;
      el.syncParticipantsList.innerHTML = "";

      const currentUser = participants.find((p) => p.conn_id === state.syncSession.connId) || 
                          participants.find((p) => p.user_id === state.user?.id);
      const isMuted = currentUser?.is_muted || false;

      // Update chat input state if muted
      if (el.syncChatInput) {
        el.syncChatInput.disabled = isMuted;
        el.syncChatInput.placeholder = isMuted ? "You are muted by host" : "";
      }


      participants.forEach((p) => {
        const div = document.createElement("div");
        div.className = "sync-participant-item";

        const img = document.createElement("img");
        img.className = "sync-participant-avatar";
        img.src = p.avatar_url || "https://www.gravatar.com/avatar/000?d=mp";
        img.alt = p.username;
        div.appendChild(img);

        const info = document.createElement("div");
        info.className = "sync-participant-info";

        const name = document.createElement("div");
        name.className = "sync-participant-name" + (p.user_id ? " clickable" : "");
        name.textContent = p.username;

        if (p.user_id) {
          name.addEventListener("click", () => {
            const profileObj = {
              user_id: p.user_id,
              username: p.username,
              avatar_url: p.avatar_url,
            };
            void safeAsyncAction(() => openPublicUserProfile(profileObj, { backView: "searchView" }), {})();
            this.toggleOverlay();
          });
        }
        info.appendChild(name);

        const badges = document.createElement("div");
        badges.className = "sync-participant-badges";
        if (p.is_host) {
          const b = document.createElement("span");
          b.className = "badge badge-host";
          b.textContent = "Host";
          badges.appendChild(b);
        }
        if (p.is_muted) {
          const b = document.createElement("span");
          b.className = "badge badge-muted";
          b.textContent = "Muted";
          badges.appendChild(b);
        }
        info.appendChild(badges);
        div.appendChild(info);

        const actions = document.createElement("div");
        actions.className = "sync-participant-actions";

        if (state.syncSession.isHost && !p.is_host) {
          // Mute/Unmute
          const muteBtn = document.createElement("button");
          muteBtn.className = "btn ghost icon-btn";
          muteBtn.innerHTML = `<i class="material-icons">${p.is_muted ? "volume_up" : "volume_off"}</i>`;
          muteBtn.title = p.is_muted ? "Unmute" : "Mute";
          muteBtn.onclick = () => this.toggleMute(p.user_id, p.is_muted);
          actions.appendChild(muteBtn);

          // Kick
          const kickBtn = document.createElement("button");
          kickBtn.className = "btn ghost icon-btn danger";
          kickBtn.innerHTML = '<i class="material-icons">gavel</i>';
          kickBtn.title = "Kick";
          kickBtn.onclick = () => this.sendKick(p.conn_id);
          actions.appendChild(kickBtn);
        }
        div.appendChild(actions);

        el.syncParticipantsList.appendChild(div);
      });

      const host = participants.find((p) => p.is_host);
      if (host && el.syncHostName) {
        el.syncHostName.textContent = host.username;
      }
    }

    renderChatHistory(messages) {
      if (!el.syncChatMessages) return;
      el.syncChatMessages.innerHTML = "";
      messages.forEach((msg) => this.addChatMessage(msg));
    }

    addChatMessage(msg) {
      if (!el.syncChatMessages) return;

      const isOwn = msg.user_id === state.user?.id;
      const div = document.createElement("div");
      div.className = `chat-msg ${isOwn ? "chat-msg-own" : ""}`;
      div.dataset.messageId = msg.message_id;

      const header = document.createElement("div");
      header.className = "chat-msg-header";

      const author = document.createElement("span");
      author.className = "chat-msg-author";
      author.textContent = msg.username;
      header.appendChild(author);

      const timeStr = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
      const time = document.createElement("span");
      time.className = "chat-msg-time";
      time.textContent = timeStr;
      header.appendChild(time);

      div.appendChild(header);

      const bubble = document.createElement("div");
      bubble.className = "chat-msg-bubble";

      if (msg.subtype === "sticker" && isTrustedStickerUrl(String(msg.content || ""))) {
        const wrap = document.createElement("span");
        wrap.className = "rich-msg-sticker-wrap";
        const img = document.createElement("img");
        img.className = "rich-msg-sticker chat-msg-sticker";
        img.src = String(msg.content || "");
        img.alt = "GIF";
        img.loading = "lazy";
        img.referrerPolicy = "no-referrer";
        wrap.appendChild(img);
        bubble.appendChild(wrap);
      } else {
        appendRichMessageContent(bubble, String(msg.content || ""));
      }

      if (state.syncSession.isHost) {
        const delBtn = document.createElement("button");
        delBtn.className = "btn ghost icon-btn chat-msg-delete-btn";
        delBtn.innerHTML = '<i class="material-icons" style="font-size:14px">delete</i>';
        delBtn.onclick = () => this.sendDeleteMessage(msg.message_id);
        div.appendChild(delBtn);
      }

      div.appendChild(bubble);
      el.syncChatMessages.appendChild(div);
      
      // Internal scroll for chat container
      el.syncChatMessages.scrollTop = el.syncChatMessages.scrollHeight;
      
      // If we are in mobile stack mode, scroll the parent grid layout to ensure input is visible
      const gridLayout = document.querySelector(".sync-grid-layout");
      if (gridLayout && window.innerWidth < 800) {
        gridLayout.scrollTo({
          top: gridLayout.scrollHeight,
          behavior: "smooth"
        });
      }
    }

    removeChatMessage(messageId) {
      const msgEl = el.syncChatMessages?.querySelector(`[data-message-id="${messageId}"]`);
      if (msgEl) msgEl.remove();
    }



    sendChatMessage(content, subtype = "text") {
      if (!state.syncSession.ws || state.syncSession.ws.readyState !== WebSocket.OPEN) return;

      let finalContent = content || el.syncChatInput?.value.trim();
      if (!finalContent) return;
      if (subtype === "text") {
        finalContent = normalizeSyncChatText(finalContent);
      } else {
        finalContent = normalizeSyncChatStickerUrl(finalContent);
      }
      if (!finalContent) return;

      state.syncSession.ws.send(JSON.stringify({
        type: "CHAT_MESSAGE",
        subtype: subtype,
        content: finalContent
      }));

      if (subtype === "text" && el.syncChatInput) {
        el.syncChatInput.value = "";
      }
    }

    toggleMute(userId, isCurrentlyMuted) {
      if (!state.syncSession.ws) return;
      state.syncSession.ws.send(JSON.stringify({
        type: isCurrentlyMuted ? "UNMUTE_USER" : "MUTE_USER",
        user_id: userId
      }));
    }

    sendDeleteMessage(messageId) {
      if (!state.syncSession.ws) return;
      state.syncSession.ws.send(JSON.stringify({
        type: "DELETE_MESSAGE",
        message_id: messageId
      }));
    }

    sendKick(connId) {
      if (state.syncSession.ws && state.syncSession.ws.readyState === WebSocket.OPEN) {
        state.syncSession.ws.send(JSON.stringify({
          type: "KICK",
          conn_id: connId
        }));
      }
    }

    sendStateUpdate() {
      if (!state.syncSession.isHost || !state.syncSession.ws || state.syncSession.ws.readyState !== WebSocket.OPEN) return;

      const playbackState = {
        song_id: state.currentPlayingSong?.id,
        is_playing: !el.audioPlayer.paused,
        progress_ms: Math.round(el.audioPlayer.currentTime * 1000),
        timestamp: Date.now()
      };

      state.syncSession.ws.send(JSON.stringify({
        type: "STATE_UPDATE",
        state: playbackState
      }));
    }

    copyId() {
      if (!state.syncSession.sessionId) return;
      navigator.clipboard.writeText(state.syncSession.sessionId).then(() => {
        showFlash("Session ID copied to clipboard!");
      });
    }

    async startScanning() {
      try {
        await loadSyncVendorScripts();
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        el.syncScannerVideo.srcObject = stream;
        el.syncScannerVideo.setAttribute("playsinline", true);
        el.syncScannerVideo.play();
        
        el.syncScannerView.classList.remove("hidden");
        el.syncStartScannerBtn.classList.add("hidden");
        
        this.scanning = true;
        requestAnimationFrame(() => this.scanLoop());
      } catch (err) {
        showFlash("Camera access denied or not available.", true);
      }
    }

    stopScanning() {
      this.scanning = false;
      if (el.syncScannerVideo.srcObject) {
        el.syncScannerVideo.srcObject.getTracks().forEach(track => track.stop());
        el.syncScannerVideo.srcObject = null;
      }
      el.syncScannerView.classList.add("hidden");
      el.syncStartScannerBtn.classList.remove("hidden");
    }

    scanLoop() {
      if (!this.scanning) return;

      if (el.syncScannerVideo.readyState === el.syncScannerVideo.HAVE_ENOUGH_DATA) {
        const canvas = document.createElement("canvas");
        canvas.width = el.syncScannerVideo.videoWidth;
        canvas.height = el.syncScannerVideo.videoHeight;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(el.syncScannerVideo, 0, 0, canvas.width, canvas.height);
        
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = window.jsQR(imageData.data, imageData.width, imageData.height, {
          inversionAttempts: "dontInvert",
        });

        if (code) {
          console.log("Found QR code", code.data);
          try {
            let sessionId = sanitizeListenTogetherJoinId(code.data);
            if (!sessionId && code.data.includes("join=") && isSafeHttpMediaUrl(code.data)) {
              const url = new URL(code.data);
              sessionId = sanitizeListenTogetherJoinId(url.searchParams.get("join"));
            }

            if (sessionId) {
              showFlash(`QR Scanned: ${sessionId}`);
              this.join(sessionId);
              return;
            }
          } catch (e) {
            console.error("Invalid QR code data", e);
          }
        }
      }
      requestAnimationFrame(() => this.scanLoop());
    }

    endSession() {
      this.setSyncPlaybackBlocked(false);
      this.clearSessionState();
      this.updateUI();
    }

    leaveSession() {
      this.endSession();
    }
  }

  // Initialize ListenTogetherManager
  const syncManager = new ListenTogetherManager();
  window.__yiroListenTogetherTeardown = () => {
    syncManager.endSession();
  };

  // Handle URL join parameter
  window.addEventListener("load", () => {
    const params = new URLSearchParams(window.location.search);
    const joinId = sanitizeListenTogetherJoinId(params.get("join"));
    if (joinId) {
      state.syncSession.sessionId = joinId;
      state.syncSession.isHost = false;
      syncManager.connect();
      syncManager.toggleOverlay();
    }
  });

  // Sync mobile bottom nav + hide login-state elements
  window.addEventListener("resize", () => {
    syncSidebarViewportMode();
  });

})();

// renderAnalytics() uses onclick="... shareSong(...) / shareArtist(...)" — must be on window after bundling.
window.shareSong = shareSong;
window.shareArtist = shareArtist;
window.shareAlbum = shareAlbum;

boot();

/* Double-tap zoom mitigation — do NOT add another document touchmove listener here:
   Android Chrome often has no event.scale; `scale !== 1` would block all scrolling.
   Pinch is handled at the top of this file (multi-touch + numeric scale only). */
// Çift tıklayarak büyütmeyi (double tap zoom) engelle — range / ses kontrollerinde preventDefault kullanma (iOS ses kaydırıcısını kırar)
let lastTouchEnd = 0;
document.addEventListener("touchend", function (event) {
  const t = event.target;
  if (t instanceof HTMLInputElement && t.type === "range") {
    lastTouchEnd = 0;
    return;
  }
  if (
    t instanceof Element &&
    (t.closest(".full-player-volume") ||
      t.closest(".mobile-volume-popup") ||
      t.closest(".full-player-meta-actions") ||
      t.closest(".fp-related-toolbar") ||
      t.closest(".fp-related-row-actions") ||
      t.closest(".fp-playlist-picker-root") ||
      t.closest(".fp-action-sheet-root"))
  ) {
    lastTouchEnd = 0;
    return;
  }
  const now = Date.now();
  if (now - lastTouchEnd <= 300) {
    event.preventDefault();
  }
  lastTouchEnd = now;
}, false);