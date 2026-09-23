'use strict';

/**
 * LyricVision LCD — Electron shell v0.1 (LV-05).
 *
 * Owns: settings (+ safeStorage token migration), Spotify PKCE auth +
 * adaptive polling, LRCLIB lyrics (+ disk LRU/TTL cache), sidecar
 * lifecycle (versioned envelopes + ack pairing + exit 2/3 mapping),
 * lcdStatus, single-instance, tray-with-hide, per-user Startup .lnk
 * (create/remove only, no elevation), TRCC/SignalRGB detect-and-warn.
 *
 * Hardening requirements this shell must keep:
 *  - tokens NEVER in plaintext, NEVER to the renderer (only {connected,expiresAt})
 *  - settings:save validates whitelist + types (main writes tokens, never renderer)
 *  - every fetch uses AbortSignal.timeout(8000)
 *  - OAuth redirect port 17321 fixed is dead: fallback 17322-17331 + actionable error
 *  - no Atomics.wait anywhere (async only)
 *  - renderer loads with meta CSP + setWindowOpenHandler(deny)
 */

const { app, dialog, BrowserWindow, ipcMain, Tray, Menu, shell, safeStorage } = require('electron');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { spawnBridge, buildPreviewRequest } = require('./bridge-spawn');
const hardening = require('./hardening');
const { createPreviewCorrelator, previewError, PREVIEW_REASON } = require('./preview-correlator');

// ---------------------------------------------------------------------------
// Constants (locked LV-01/LV-02)
// ---------------------------------------------------------------------------

const SPOTIFY_SCOPES = 'user-read-currently-playing user-read-playback-state';
const SPOTIFY_AUTH_URL = 'https://accounts.spotify.com/authorize';
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_NOW_PLAYING_URL = 'https://api.spotify.com/v1/me/player/currently-playing';

const OAUTH_PORT_START = 17321;
const OAUTH_PORT_END = 17331;

const FETCH_TIMEOUT_MS = 8000;
const REFRESH_MARGIN_MS = 60 * 1000;
// LV-08: 2s while playing ~= 1800 req/h, far from Spotify rate limits.
const POLL_PLAYING_MS = 2000;
const POLL_IDLE_MS = 15000;

const MIN_FPS = 5;
const MAX_FPS = 30;
const DEFAULT_FPS = 10;

const LRC_BASE = 'https://lrclib.net';
const LRC_RETRIES = 2; // + initial attempt = up to 3 tries
const LRC_BACKOFF_BASE_MS = 500;
const LYRICS_CACHE_MAX = 200;
const LYRICS_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d

// Manual sync correction (LV-08): shifts the extrapolated progress the
// bridge computes. UI step is 100ms; validation enforces type + range.
const DEFAULT_SYNC_OFFSET_MS = 0;
const SYNC_OFFSET_MIN_MS = -2000;
const SYNC_OFFSET_MAX_MS = 2000;
const SYNC_OFFSET_STEP_MS = 100;

// Unified layout (LV-09 producto: UNA sola vista, no modos separados).
// `layout` guardado viejo ('lyrics'|'cover') se SIGUE aceptando en la
// whitelist (compat: no rompe settings.json existentes) pero se IGNORA al
// renderizar: el bridge siempre pinta la vista unificada (ver lcd_bridge.py).
const DEFAULT_LAYOUT = 'lyrics';
const LAYOUT_VALUES = new Set(['lyrics', 'cover']);

// settings.json whitelist: key -> expected type ('fps' = clamped number,
// 'syncOffset' = finite number inside [SYNC_OFFSET_MIN_MS, SYNC_OFFSET_MAX_MS],
// 'layout' = exact 'lyrics'|'cover', 'scene' = whole object via
// hardening.validateScene (accepted or rejected as one unit), else rejected).
// Token keys are NEVER accepted here, even if sent (main writes tokens only).
const SETTINGS_SCHEMA = {
  spotifyClientId: 'string',
  lcdFps: 'fps',
  syncOffsetMs: 'syncOffset',
  layout: 'layout',
  serial: 'string',
  runAtStartup: 'boolean',
  scene: 'scene',
};
const TOKEN_KEYS = new Set(['accessToken', 'refreshToken', 'expiresAt', 'token']);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// LV-06 ring log: in-memory buffer of the last 200 {ts, level, msg} entries.
// log()/logError() are the SOLE entry points — every message is redacted on
// entry, and nothing PII is written to disk outside this buffer.
const ring = new hardening.RingLog(hardening.RING_CAP);

function log(...args) {
  const safe = args.map((a) => (typeof a === 'string' ? hardening.redact(a) : a));
  ring.push('info', safe.map((a) => String(a)).join(' '));
  console.log('[shell]', ...safe);
}

function logError(...args) {
  const safe = args.map((a) => (typeof a === 'string' ? hardening.redact(a) : a));
  ring.push('error', safe.map((a) => String(a)).join(' '));
  console.error('[shell]', ...safe);
}

/**
 * Central redaction (LV-06): tokens, client secrets, OAuth codes, USB
 * serials. Single regex home in src/hardening.js; log()/logError() and the
 * ring apply it, so secrets never reach console, disk, or the renderer.
 */
function redact(value) {
  return hardening.redact(value);
}

function clampFps(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_FPS;
  return Math.min(MAX_FPS, Math.max(MIN_FPS, Math.round(n)));
}

/**
 * Clamp a sync-offset value into [SYNC_OFFSET_MIN_MS, SYNC_OFFSET_MAX_MS]
 * (LV-08). Garbage -> default (0). Used for user files / bridge state;
 * settings:save instead REJECTS out-of-range values (see validateSettingsPatch).
 */
function clampSyncOffset(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_SYNC_OFFSET_MS;
  return Math.min(SYNC_OFFSET_MAX_MS, Math.max(SYNC_OFFSET_MIN_MS, Math.round(n)));
}

/**
 * Normalize a layout value (LV-09 unified, compat only): exact
 * 'lyrics'|'cover', else default ('lyrics'). The result is ACCEPTED (old
 * settings.json files keep validating) but IGNORED at render time (single
 * view). Used for user files / bridge state; settings:save instead REJECTS
 * anything else (see validateSettingsPatch).
 */
function normalizeLayout(raw) {
  return typeof raw === 'string' && LAYOUT_VALUES.has(raw) ? raw : DEFAULT_LAYOUT;
}

/**
 * Pick the best artwork URL from Spotify `item.album.images` (LV-09, pure).
 * Largest area wins; entries without a string url are skipped. Returns the
 * URL string only (main NEVER downloads images) or '' when unusable.
 */
function pickBestArtworkUrl(images) {
  if (!Array.isArray(images) || images.length === 0) return '';
  let best = '';
  let bestArea = -1;
  let firstUrl = '';
  for (const img of images) {
    if (!img || typeof img.url !== 'string' || !img.url) continue;
    if (!firstUrl) firstUrl = img.url;
    const w = Number(img.width);
    const h = Number(img.height);
    const area = Number.isFinite(w) && Number.isFinite(h) ? w * h : -1;
    if (area > bestArea) {
      bestArea = area;
      best = img.url;
    }
  }
  return best || firstUrl;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(ms) {
  return ms + Math.floor(Math.random() * ms);
}

function base64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

// ---------------------------------------------------------------------------
// Paths + settings (whitelist-validated; tokens live in safeStorage, never here)
// ---------------------------------------------------------------------------

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function tokensPath() {
  return path.join(app.getPath('userData'), 'tokens.bin');
}

function lyricsCachePath() {
  return path.join(app.getPath('userData'), 'lyrics-cache.json');
}

function loadSettings() {
  // scene is deep-cloned per call so a caller mutating settings.scene can
  // never corrupt the shared hardening.DEFAULT_SCENE constant.
  const defaults = { spotifyClientId: '', lcdFps: DEFAULT_FPS, syncOffsetMs: DEFAULT_SYNC_OFFSET_MS, layout: DEFAULT_LAYOUT, serial: '', runAtStartup: false, scene: structuredClone(hardening.DEFAULT_SCENE) };
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    return defaults; // first run: no file yet
  }
  const out = { ...defaults };
  for (const [key, kind] of Object.entries(SETTINGS_SCHEMA)) {
    const value = raw[key];
    if (kind === 'string' && typeof value === 'string') out[key] = value;
    else if (kind === 'boolean' && typeof value === 'boolean') out[key] = value;
    else if (kind === 'fps' && (typeof value === 'number' || typeof value === 'string')) {
      out[key] = clampFps(value);
    }     else if (kind === 'syncOffset' && (typeof value === 'number' || typeof value === 'string')) {
      out[key] = clampSyncOffset(value);
    } else if (kind === 'layout') {
      out[key] = normalizeLayout(value);
    } else if (kind === 'scene') {
      // Absent/invalid file value keeps the fresh default already in `out` —
      // a scene is accepted whole or not at all (never a partial object).
      const result = hardening.validateScene(value);
      if (result.ok) out[key] = result.scene;
    }
    // wrong types fall back to defaults (validated, never throw on user files)
  }
  return out;
}

function persistSettings(settings) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf8');
}

/**
 * Validate a renderer-supplied patch: whitelist + types only.
 * Token keys are dropped (main is the sole token writer).
 * @returns {{accepted:object, rejected:string[]}}
 */
function validateSettingsPatch(patch) {
  const accepted = {};
  const rejected = [];
  if (!patch || typeof patch !== 'object') return { accepted, rejected: ['<non-object>'] };
  for (const [key, value] of Object.entries(patch)) {
    if (TOKEN_KEYS.has(key)) {
      rejected.push(key);
      continue;
    }
    const kind = SETTINGS_SCHEMA[key];
    if (!kind) {
      rejected.push(key);
      continue;
    }
    if (kind === 'string' && typeof value === 'string') accepted[key] = value;
    else if (kind === 'boolean' && typeof value === 'boolean') accepted[key] = value;
    else if (kind === 'fps' && (typeof value === 'number' || typeof value === 'string')) {
      accepted[key] = clampFps(value);
    } else if (kind === 'syncOffset' && (typeof value === 'number' || typeof value === 'string')) {
      const n = Number(value);
      if (Number.isFinite(n) && n >= SYNC_OFFSET_MIN_MS && n <= SYNC_OFFSET_MAX_MS) {
        accepted[key] = Math.round(n);
      } else {
        rejected.push(key);
      }
    } else if (kind === 'layout') {
      if (typeof value === 'string' && LAYOUT_VALUES.has(value)) accepted[key] = value;
      else rejected.push(key);
    } else if (kind === 'scene') {
      // Whole-object gate: one bad field rejects the entire key (no partial scenes).
      const result = hardening.validateScene(value);
      if (result.ok) accepted[key] = result.scene;
      else rejected.push(key);
    } else {
      rejected.push(key);
    }
  }
  return { accepted, rejected };
}

// ---------------------------------------------------------------------------
// Token vault (safeStorage) + plaintext migration
// ---------------------------------------------------------------------------

let memoryTokens = null; // {accessToken, refreshToken, expiresAt} — runtime only

function readVault() {
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    const blob = fs.readFileSync(tokensPath());
    return JSON.parse(safeStorage.decryptString(blob).toString());
  } catch {
    return null;
  }
}

function writeVault(tokens) {
  memoryTokens = tokens;
  if (!safeStorage.isEncryptionAvailable()) {
    logError('safeStorage unavailable: tokens kept in memory only (restart will require re-auth)');
    return false;
  }
  fs.mkdirSync(path.dirname(tokensPath()), { recursive: true });
  fs.writeFileSync(tokensPath(), safeStorage.encryptString(JSON.stringify(tokens)));
  return true;
}

function getTokens() {
  return memoryTokens || readVault();
}

/**
 * One-way migration: plaintext tokens in settings.json -> safeStorage vault,
 * then wipe the plaintext keys and rewrite the file. Returns migrated count.
 */
function migratePlaintextTokens() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    return 0;
  }
  const found = {};
  for (const key of ['accessToken', 'refreshToken', 'expiresAt']) {
    if (raw[key] !== undefined) found[key] = raw[key];
  }
  if (Object.keys(found).length === 0) return 0;
  const tokens = {
    accessToken: typeof found.accessToken === 'string' ? found.accessToken : '',
    refreshToken: typeof found.refreshToken === 'string' ? found.refreshToken : '',
    expiresAt: typeof found.expiresAt === 'number' ? found.expiresAt : 0,
  };
  const persisted = writeVault(tokens);
  for (const key of ['accessToken', 'refreshToken', 'expiresAt', 'token']) delete raw[key];
  // LV-06: persist only whitelisted keys (never echo unknown/token keys back).
  const cleaned = {};
  for (const key of Object.keys(SETTINGS_SCHEMA)) {
    if (raw[key] !== undefined) cleaned[key] = raw[key];
  }
  persistSettings({ ...loadSettings(), ...cleaned });
  log(`migrated ${Object.keys(found).length} plaintext token field(s) to safeStorage${persisted ? '' : ' (memory-only: encryption unavailable)'}; plaintext wiped from settings.json`);
  return Object.keys(found).length;
}

function spotifyStatus() {
  const tokens = getTokens();
  if (!tokens || !tokens.accessToken) return { connected: false, expiresAt: 0 };
  return { connected: true, expiresAt: tokens.expiresAt || 0 };
}

// ---------------------------------------------------------------------------
// HTTP with timeout (every fetch in this file uses AbortSignal.timeout)
// ---------------------------------------------------------------------------

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return res;
}

// ---------------------------------------------------------------------------
// Spotify OAuth PKCE S256 (redirect http://127.0.0.1:{port}/callback)
// ---------------------------------------------------------------------------

let oauthServer = null;
let oauthState = null;

function closeOAuthServer() {
  if (oauthServer) {
    oauthServer.close();
    oauthServer = null;
    oauthState = null;
  }
}

function listenOnFirstFreePort(server) {
  return new Promise((resolve, reject) => {
    let port = OAUTH_PORT_START;
    const tryNext = () => {
      if (port > OAUTH_PORT_END) {
        reject(
          new Error(
            `no free OAuth callback port in ${OAUTH_PORT_START}-${OAUTH_PORT_END}: ` +
              'close the app holding 127.0.0.1:17321-17331 (another LyricVision instance?) and retry'
          )
        );
        return;
      }
      const onError = (err) => {
        if (err && err.code === 'EADDRINUSE') {
          port += 1;
          tryNext();
          return;
        }
        reject(err);
      };
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', onError);
        resolve(port);
      });
    };
    tryNext();
  });
}

async function exchangeCode({ clientId, code, verifier, redirectUri }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  });
  const res = await fetchJson(SPOTIFY_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`token exchange failed (HTTP ${res.status})`);
  const data = await res.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || (getTokens() || {}).refreshToken || '',
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  };
}

async function refreshTokens() {
  const tokens = getTokens();
  if (!tokens || !tokens.refreshToken) throw new Error('no refresh token (connect Spotify first)');
  const settings = loadSettings();
  if (!settings.spotifyClientId) throw new Error('no Spotify client ID configured');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
    client_id: settings.spotifyClientId,
  });
  const res = await fetchJson(SPOTIFY_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`token refresh failed (HTTP ${res.status})`);
  const data = await res.json();
  const next = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || tokens.refreshToken,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  };
  writeVault(next);
  return next;
}

async function ensureAccessToken() {
  let tokens = getTokens();
  if (!tokens || !tokens.accessToken) throw new Error('not connected (connect Spotify first)');
  if (Date.now() > (tokens.expiresAt || 0) - REFRESH_MARGIN_MS) {
    tokens = await refreshTokens(); // 60s margin
  }
  return tokens.accessToken;
}

/**
 * Start the PKCE flow: local callback server (port fallback 17321-17331),
 * browser opened via shell. Resolves via renderer push, NOT via invoke
 * return (the user completes the browser step asynchronously).
 */
async function startSpotifyAuth(clientIdOverride) {
  const clientId = (clientIdOverride || loadSettings().spotifyClientId || '').trim();
  if (!clientId) throw new Error('set your Spotify client ID first');
  if (oauthServer) throw new Error('authorization already in progress (finish or restart the app)');

  const verifier = base64url(crypto.randomBytes(64));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const state = base64url(crypto.randomBytes(16));

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname !== '/callback') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    const code = url.searchParams.get('code');
    const returnedState = url.searchParams.get('state');
    const error = url.searchParams.get('error');
    (async () => {
      if (error || !code || returnedState !== oauthState) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<h1>Authorization failed. You can close this tab and retry in LyricVision.</h1>');
        pushAuthResult({ ok: false, error: error || 'state mismatch (CSRF check failed)' });
      } else {
        const port = server.address().port;
        const tokens = await exchangeCode({
          clientId,
          code,
          verifier,
          redirectUri: `http://127.0.0.1:${port}/callback`,
        });
        writeVault(tokens);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>LyricVision connected. You can close this tab.</h1>');
        pushAuthResult({ ok: true });
        void pollNow(); // immediate first poll after connect
      }
    })()
      .catch((err) => {
        try {
          res.writeHead(500, { 'Content-Type': 'text/html' });
          res.end('<h1>Authorization failed. You can close this tab and retry in LyricVision.</h1>');
        } catch {
          // response already sent
        }
        pushAuthResult({ ok: false, error: String((err && err.message) || err) });
      })
      .finally(() => {
        setTimeout(closeOAuthServer, 1000);
      });
  });

  const port = await listenOnFirstFreePort(server);
  oauthServer = server;
  oauthState = state;
  // Safety: never leave the callback listener open forever.
  setTimeout(() => {
    if (oauthServer === server) {
      closeOAuthServer();
      pushAuthResult({ ok: false, error: 'authorization timed out (5 min)' });
    }
  }, 5 * 60 * 1000).unref();

  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const authUrl =
    `${SPOTIFY_AUTH_URL}?response_type=code` +
    `&client_id=${encodeURIComponent(clientId)}` +
    `&scope=${encodeURIComponent(SPOTIFY_SCOPES)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${encodeURIComponent(state)}` +
    `&code_challenge_method=S256&code_challenge=${encodeURIComponent(challenge)}`;
  await shell.openExternal(authUrl);
  return { started: true };
}

// ---------------------------------------------------------------------------
// Spotify polling (adaptive 2s playing / 15s idle, pollInFlight guard)
// ---------------------------------------------------------------------------

let pollTimer = null;
let pollInFlight = false;
let lastPlayer = { isPlaying: false }; // sanitized, renderer-safe
let lastPollError = null;
let authBroken = false;

function currentTrackKey(player) {
  const track = player.track || {};
  return `${track.title || ''} — ${track.artist || ''}`;
}

function scheduleNextPoll() {
  if (pollTimer) clearTimeout(pollTimer);
  const delay = lastPlayer.isPlaying ? POLL_PLAYING_MS : POLL_IDLE_MS;
  pollTimer = setTimeout(() => void pollNow(), delay);
  pollTimer.unref();
}

async function spotifyGetNowPlaying(accessToken) {
  const res = await fetchJson(SPOTIFY_NOW_PLAYING_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 204) return { data: null, receivedAtMs: Date.now() }; // nothing playing
  if (res.status === 401) {
    const err = new Error('spotify unauthorized (HTTP 401)');
    err.code = 'auth';
    throw err;
  }
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after') || '5');
    const err = new Error(`spotify rate-limited (HTTP 429, retry after ${retryAfter}s)`);
    err.code = 'rate';
    err.retryAfterMs = (Number.isFinite(retryAfter) ? retryAfter : 5) * 1000;
    throw err;
  }
  if (!res.ok) throw new Error(`spotify poll failed (HTTP ${res.status})`);
  const data = await res.json();
  return { data, receivedAtMs: Date.now() };
}

function toPlayerState(data, receivedAtMs) {
  // LV-08: the progress base is Spotify's `timestamp`, not the local poll
  // moment. Without it, fall back to the local receipt time.
  const receiptMs =
    typeof receivedAtMs === 'number' && Number.isFinite(receivedAtMs) ? receivedAtMs : Date.now();
  if (!data || !data.item) return { isPlaying: false, progressMs: 0, durationMs: 0, measuredAt: receiptMs };
  const item = data.item;
  const artists = Array.isArray(item.artists) ? item.artists.map((a) => a.name).filter(Boolean) : [];
  const measuredAt =
    typeof data.timestamp === 'number' && Number.isFinite(data.timestamp) ? data.timestamp : receiptMs;
  // LV-09: plumb the best album image URL only (main never downloads art;
  // the bridge sidecar fetches + caches it).
  const album = item.album && typeof item.album === 'object' ? item.album : null;
  return {
    isPlaying: data.is_playing === true,
    progressMs: typeof data.progress_ms === 'number' ? data.progress_ms : 0,
    measuredAt,
    durationMs: typeof item.duration_ms === 'number' ? item.duration_ms : 0,
    track: {
      title: item.name || 'Unknown Track',
      artist: artists.join(', '),
      album: (album && album.name) || '',
      artworkUrl: pickBestArtworkUrl(album && album.images),
    },
  };
}

async function pollNow() {
  if (pollInFlight) return lastPlayer; // guard: never overlap polls
  pollInFlight = true;
  try {
    let accessToken;
    try {
      accessToken = await ensureAccessToken();
    } catch (err) {
      authBroken = true;
      lastPollError = String((err && err.message) || err);
      updateLcdStatus();
      scheduleNextPoll();
      return lastPlayer;
    }

    let data;
    let receivedAtMs = Date.now();
    try {
      const nowPlaying = await spotifyGetNowPlaying(accessToken);
      data = nowPlaying.data;
      receivedAtMs = nowPlaying.receivedAtMs;
    } catch (err) {
      if (err && err.code === 'auth') {
        // One refresh + one retry, then auth-error.
        try {
          accessToken = (await refreshTokens()).accessToken;
          const nowPlaying = await spotifyGetNowPlaying(accessToken);
          data = nowPlaying.data;
          receivedAtMs = nowPlaying.receivedAtMs;
          authBroken = false;
        } catch (retryErr) {
          authBroken = true;
          lastPollError = String((retryErr && retryErr.message) || retryErr);
          updateLcdStatus();
          scheduleNextPoll();
          return lastPlayer;
        }
      } else if (err && err.code === 'rate') {
        lastPollError = String(err.message);
        updateLcdStatus();
        if (pollTimer) clearTimeout(pollTimer);
        pollTimer = setTimeout(() => void pollNow(), err.retryAfterMs || 5000);
        pollTimer.unref();
        return lastPlayer;
      } else {
        lastPollError = String((err && err.message) || err);
        updateLcdStatus();
        scheduleNextPoll();
        return lastPlayer;
      }
    }

    authBroken = false;
    lastPollError = null;
    const player = toPlayerState(data, receivedAtMs);
    const trackChanged = currentTrackKey(player) !== currentTrackKey(lastPlayer);
    lastPlayer = player;

    if (player.track) {
      try {
        const lyric = await resolveLyric(player);
        player.lyric = lyric; // {current_line, next_line}
      } catch (err) {
        lastPollError = `lyrics: ${String((err && err.message) || err)}`;
      }
    }

    void trackChanged; // lyrics resolve per poll; cache makes repeats cheap
    pushPlayerState();
    sendStateToBridge();
    updateLcdStatus();
    scheduleNextPoll();
    return lastPlayer;
  } finally {
    pollInFlight = false;
  }
}

// ---------------------------------------------------------------------------
// LRCLIB (timeout + 2 retries backoff+jitter, respects 429, LRU 200 + 30d TTL)
// ---------------------------------------------------------------------------

let lyricsCache = null; // Map preserves insertion order (LRU via delete+set)

function loadLyricsCache() {
  if (lyricsCache) return lyricsCache;
  lyricsCache = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(lyricsCachePath(), 'utf8'));
    const now = Date.now();
    for (const [key, entry] of Object.entries(raw.entries || {})) {
      if (entry && now - entry.ts < LYRICS_CACHE_TTL_MS) lyricsCache.set(key, entry);
    }
  } catch {
    // no cache yet
  }
  return lyricsCache;
}

function persistLyricsCache() {
  try {
    fs.mkdirSync(path.dirname(lyricsCachePath()), { recursive: true });
    fs.writeFileSync(
      lyricsCachePath(),
      JSON.stringify({ version: 1, entries: Object.fromEntries(loadLyricsCache()) }),
      'utf8'
    );
  } catch (err) {
    logError('lyrics cache write failed:', String((err && err.message) || err));
  }
}

function lyricsCacheKey(title, artist, durationMs) {
  const bucket = Math.round((Number(durationMs) || 0) / 5000); // 5s buckets
  return `${String(artist || '').toLowerCase().trim()}|${String(title || '').toLowerCase().trim()}|${bucket}`;
}

function cacheGet(key) {
  const cache = loadLyricsCache();
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts >= LYRICS_CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  cache.delete(key); // LRU touch
  cache.set(key, entry);
  return entry.data;
}

function cacheSet(key, data) {
  const cache = loadLyricsCache();
  cache.delete(key);
  cache.set(key, { ts: Date.now(), data });
  while (cache.size > LYRICS_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  persistLyricsCache();
}

async function lrclibFetch(url) {
  let attempt = 0;
  for (;;) {
    const res = await fetchJson(url, { headers: { 'User-Agent': 'LyricVision-LCD/0.1' } });
    if (res.status === 429) {
      if (attempt >= LRC_RETRIES) throw new Error('lrclib rate-limited (HTTP 429, retries exhausted)');
      const retryAfter = Number(res.headers.get('retry-after') || '2');
      await sleep(jitter(Math.max(1000, (Number.isFinite(retryAfter) ? retryAfter : 2) * 1000)));
      attempt += 1;
      continue;
    }
    if ((res.status >= 500 || res.status === 408) && attempt < LRC_RETRIES) {
      await sleep(jitter(LRC_BACKOFF_BASE_MS * 2 ** attempt));
      attempt += 1;
      continue;
    }
    return res;
  }
}

function scoreSearchResult(item, title, artist, durationMs) {
  if (!item || !item.syncedLyrics) return -1; // v0.1 only drives synced lyrics
  let score = 0;
  if ((item.trackName || '').toLowerCase().trim() === title.toLowerCase().trim()) score += 3;
  else if ((item.trackName || '').toLowerCase().includes(title.toLowerCase().trim())) score += 1;
  if ((item.artistName || '').toLowerCase().trim() === artist.toLowerCase().trim()) score += 3;
  else if ((item.artistName || '').toLowerCase().includes(artist.toLowerCase().trim())) score += 1;
  if (durationMs && item.duration) {
    const diff = Math.abs(item.duration - durationMs / 1000);
    if (diff <= 2) score += 2;
    else if (diff <= 5) score += 1;
    else if (diff > 15) score -= 2;
  }
  return score;
}

function parseLrc(syncedLyrics) {
  const lines = [];
  for (const raw of String(syncedLyrics || '').split('\n')) {
    const m = raw.match(/^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/);
    if (!m) continue;
    const ms = (Number(m[1]) * 60 + Number(m[2])) * 1000;
    if (!Number.isFinite(ms)) continue;
    lines.push({ startMs: ms, text: m[3].trim() });
  }
  lines.sort((a, b) => a.startMs - b.startMs);
  return lines;
}

function activeLyric(lines, progressMs) {
  let active = 0;
  for (let i = 0; i < lines.length; i++) {
    if (progressMs >= lines[i].startMs) active = i;
    else break;
  }
  return {
    current_line: lines.length ? lines[active].text : '',
    next_line: lines.length > active + 1 ? lines[active + 1].text : '',
  };
}

async function resolveLyric(player) {
  const { title, artist } = player.track;
  const key = lyricsCacheKey(title, artist, player.durationMs);
  let lines = cacheGet(key);
  if (!lines) {
    const params = new URLSearchParams({
      artist_name: artist,
      track_name: title,
      album_name: player.track.album || '',
      duration: String(Math.round((player.durationMs || 0) / 1000)),
    });
    const getRes = await lrclibFetch(`${LRC_BASE}/api/get?${params}`);
    let synced = null;
    if (getRes.ok) {
      const data = await getRes.json();
      if (data && data.syncedLyrics) synced = data.syncedLyrics;
    }
    if (!synced) {
      const q = new URLSearchParams({ q: `${title} ${artist}` });
      const searchRes = await lrclibFetch(`${LRC_BASE}/api/search?${q}`);
      if (!searchRes.ok) throw new Error(`lrclib search failed (HTTP ${searchRes.status})`);
      const results = await searchRes.json();
      let best = null;
      let bestScore = -1;
      for (const item of Array.isArray(results) ? results : []) {
        const score = scoreSearchResult(item, title, artist, player.durationMs);
        if (score > bestScore) {
          bestScore = score;
          best = item;
        }
      }
      if (!best || bestScore < 0) throw new Error('no synced lyrics found');
      synced = best.syncedLyrics;
    }
    lines = parseLrc(synced);
    if (!lines.length) throw new Error('synced lyrics were empty');
    cacheSet(key, lines);
  }
  return activeLyric(lines, player.progressMs || 0);
}

// ---------------------------------------------------------------------------
// Sidecar lifecycle (versioned envelopes + ack pairing + exit mapping)
// ---------------------------------------------------------------------------

let bridgeChild = null;
let bridgeSeq = 0;
let bridgeQuitting = false;
let lastBridgeStatus = null; // last {type:"status"} line
let lastBridgeExit = null; // {code, signal}
let pendingAcks = new Map(); // seq -> timestamp
let exclusivityWarn = ''; // TRCC/SignalRGB detection message
// S2-T8: preview reqId correlation shares the sidecar's stdout pipe with
// acks/status (routing must consult it FIRST), and the fan-out remembers
// the last scene digest pushed so unchanged scenes stop crossing the wire.
const previewCorrelator = createPreviewCorrelator();
const sceneFanout = createSceneFanout();

// LV-06 watchdog: the sidecar emits status ~1Hz + ack per frame. While a
// stream is expected, >5s without EITHER marks bridge-wedged and restarts
// the child with backoff 1s/2s/4s… (cap 30s); heartbeats recover to
// ok/degraded and reset the backoff. Core logic is pure in
// src/hardening.js (child mocked in tests); here only spawn + status wiring.
const bridgeWatchdog = hardening.createBridgeWatchdog({
  timeoutMs: hardening.WATCHDOG_TIMEOUT_MS,
  onRestart: ({ delayMs, silentMs }) => {
    const waitMs = bridgeWatchdog.noteRestart();
    const { restarts } = bridgeWatchdog.getState();
    logError(
      `bridge watchdog: no status/ack for >${Math.round(silentMs / 1000)}s (restart #${restarts} in ${waitMs}ms)`
    );
    void delayMs;
    if (bridgeChild) {
      try {
        bridgeChild.kill(); // 'exit' continues the restart (episode already counted)
      } catch {
        // exit handler restarts it
      }
    } else {
      setTimeout(() => startBridge(), waitMs).unref();
    }
  },
});

function bridgeStatusLine() {
  return lastBridgeStatus;
}

/**
 * Build the renderer-safe bridge state (LV-08, pure): carries the timestamp
 * base (`measuredAt`) and the manual correction (`offsetMs`) so the bridge
 * can extrapolate `progressMs + (now - measuredAt) + offsetMs` between polls.
 * LV-09 unified: `layout` is compat-only (accepted, ignored); the bridge
 * always renders the single view. `measuredAt` missing -> Date.now() (never
 * the epoch-0 sentinel: the bridge would extrapolate ~29M minutes and pin
 * the bar at 100% — root cause A).
 */
function buildBridgeState(player, settings) {
  const safe = player && typeof player === 'object' ? player : {};
  const cfg = settings && typeof settings === 'object' ? settings : {};
  const layout = normalizeLayout(cfg.layout);
  // Scene (S1-T7a): the sidecar's composed frame reads
  // state.settings.scene, so this is the last mile. Re-validated here even
  // though loadSettings already gated it: buildBridgeState also runs on raw
  // objects, and an invalid scene must be OMITTED (never sent, never a
  // partial) so the sidecar's fail-safe falls back to the lyrics view.
  const sceneGate = hardening.validateScene(cfg.scene);
  const rawTrack =
    safe.track && typeof safe.track === 'object' ? safe.track : { title: 'Unknown Track', artist: '' };
  const track = { ...rawTrack };
  if (typeof track.artworkUrl !== 'string') {
    track.artworkUrl =
      typeof track.artwork_url === 'string' ? track.artwork_url : '';
  }
  return {
    track,
    lyric: safe.lyric || { current_line: '', next_line: '' },
    progressMs: safe.progressMs || 0,
    measuredAt:
      typeof safe.measuredAt === 'number' && Number.isFinite(safe.measuredAt) && safe.measuredAt > 0
        ? safe.measuredAt
        : Date.now(),
    offsetMs: clampSyncOffset(cfg.syncOffsetMs),
    durationMs: safe.durationMs || 0,
    isPlaying: safe.isPlaying === true,
    layout,
    settings: {
      lcdFps: clampFps(cfg.lcdFps),
      layout,
      // Undefined keys vanish in JSON.stringify, so the wire envelope
      // carries `scene` only when this gate accepted it.
      ...(sceneGate.ok ? { scene: sceneGate.scene } : {}),
    },
  };
}

function buildBridgeEnvelope(seq, state) {
  return { v: 1, seq, cmd: 'state', state };
}

/**
 * Order-insensitive content digest: JSON.stringify is key-order-sensitive,
 * so sort keys recursively — {a,b} and {b,a} must digest identically.
 */
function stableSceneDigest(value) {
  if (value === null || typeof value !== 'object') {
    return value === undefined ? 'null' : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableSceneDigest).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableSceneDigest(value[k])}`).join(',')}}`;
}

/**
 * Scene fan-out (S2-T8): buildBridgeState re-validates the scene on every
 * push, but resending an unchanged scene each poll is pure wire cost — the
 * panel keeps rendering the last scene delivered until a new one arrives.
 * `apply` strips settings.scene while its digest is unchanged; an ABSENT
 * scene (invalid-scene fail-safe) resets the digest so a returning valid
 * scene is re-sent, and `reset()` re-arms carrying after every (re)start
 * because a fresh sidecar state starts empty.
 */
function createSceneFanout() {
  let lastDigest = null;
  return {
    apply(state) {
      const scene = state && state.settings ? state.settings.scene : undefined;
      if (scene === undefined || scene === null) {
        lastDigest = null;
        return state;
      }
      const digest = stableSceneDigest(scene);
      if (lastDigest !== null && digest === lastDigest) {
        const settings = { ...state.settings };
        delete settings.scene;
        return { ...state, settings };
      }
      lastDigest = digest;
      return state;
    },
    reset() {
      lastDigest = null;
    },
  };
}

function sendStateToBridge() {
  if (!bridgeChild || bridgeChild.exitCode !== null) return;
  bridgeSeq += 1;
  const state = sceneFanout.apply(buildBridgeState(lastPlayer, loadSettings()));
  const envelope = buildBridgeEnvelope(bridgeSeq, state);
  pendingAcks.set(bridgeSeq, Date.now());
  const line = `${JSON.stringify(envelope)}\n`;
  try {
    const ok = bridgeChild.stdin.write(line);
    if (!ok) {
      lastPollError = 'bridge backpressure (stdin buffer full)';
      updateLcdStatus();
    }
  } catch (err) {
    pendingAcks.delete(bridgeSeq);
    lastPollError = `bridge write failed: ${String((err && err.message) || err)}`;
    updateLcdStatus();
  }
}

/**
 * Scene preview over the LIVE sidecar pipe (S2-T8): validate first
 * (buildPreviewRequest re-runs the hardening gate — an invalid scene never
 * reaches the pipe), then register the reqId waiter BEFORE the write so a
 * fast reply cannot arrive uncorrelated. No second process, no temp file:
 * the preview exists only while this app holds the panel.
 * @param {object} scene - untrusted renderer scene.
 * @param {{exitCode:number|null, stdin?:{write:Function}}|null} child - current sidecar.
 * @returns {Promise<string>} data: URL of the frame rendered by the engine.
 */
function handlePreviewRequest(scene, child) {
  const built = buildPreviewRequest(scene);
  if (!built.ok) {
    return Promise.reject(
      previewError(PREVIEW_REASON.INVALID_SCENE, `${built.field}: ${built.error}`)
    );
  }
  if (!child || child.exitCode !== null) {
    return Promise.reject(previewError(PREVIEW_REASON.SIDECAR_ABSENT, 'no live sidecar'));
  }
  const reply = previewCorrelator.wait(built.reqId);
  try {
    if (!child.stdin || typeof child.stdin.write !== 'function') {
      throw new Error('bridge child stdin is not writable');
    }
    child.stdin.write(built.line); // false = backpressure, not failure
  } catch (err) {
    previewCorrelator.settleError(
      built.reqId,
      previewError(PREVIEW_REASON.WRITE_FAILED, String((err && err.message) || err))
    );
  }
  return reply;
}

function handleBridgeLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return undefined; // ignore non-JSON stdout
  }
  if (!msg || typeof msg !== 'object') return undefined;
  // S2-T8 routing: preview_response shares stdout with acks/status, so the
  // correlation seam is consulted FIRST — a preview reply (matched or not)
  // is claimed here and never falls through to the ack/status path.
  if (msg.cmd === 'preview_response') {
    previewCorrelator.handleLine(line);
    return 'preview';
  }
  if (msg.type === 'ack' && typeof msg.seq === 'number') {
    bridgeWatchdog.heartbeat();
    pendingAcks.delete(msg.seq);
    // Drop stale entries below the acked seq (bridge drains to latest).
    for (const seq of [...pendingAcks.keys()]) {
      if (seq < msg.seq) pendingAcks.delete(seq);
    }
    return 'ack';
  }
  if (msg.type === 'status') {
    bridgeWatchdog.heartbeat();
    lastBridgeStatus = msg;
    updateLcdStatus();
    pushPlayerState(); // keep the status grid fresh (~1 Hz is fine)
    return 'status';
  }
  return undefined;
}

function startBridge() {
  if (bridgeQuitting || bridgeChild) return;
  const settings = loadSettings();
  const serial = settings.serial ? settings.serial : null;
  const child = spawnBridge({ app, serial });
  bridgeChild = child;
  bridgeWatchdog.setExpecting(true);
  bridgeWatchdog.heartbeat(); // fresh baseline: the sidecar talks ~1Hz from boot
  sceneFanout.reset(); // fresh sidecar state: the next push must carry the scene
  log(`bridge spawned (${child.__bridgeSource}): ${redact(child.spawnfile)} ${(child.spawnargs || []).join(' ')}`);

  let stdoutBuf = '';
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString('utf8');
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, idx);
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (line.trim()) handleBridgeLine(line);
    }
  });
  child.stderr.on('data', (chunk) => {
    logError(`[bridge] ${redact(chunk.toString('utf8').trim())}`);
  });
  child.on('error', (err) => {
    logError('bridge spawn error:', redact(String((err && err.message) || err)));
    lastBridgeExit = { code: null, signal: null, spawnError: String((err && err.message) || err) };
    bridgeChild = null;
    previewCorrelator.rejectAll(previewError(PREVIEW_REASON.EXITED, 'sidecar spawn error'));
    bridgeWatchdog.setExpecting(false);
    updateLcdStatus();
    scheduleBridgeRestart(false);
  });
  child.on('exit', (code, signal) => {
    log(`bridge exited (code=${code} signal=${signal || 'none'})`);
    lastBridgeExit = { code, signal };
    bridgeChild = null;
    previewCorrelator.rejectAll(previewError(PREVIEW_REASON.EXITED, `sidecar exited (code=${code})`));
    const wasWedged = bridgeWatchdog.isWedged();
    bridgeWatchdog.setExpecting(false);
    for (const seq of [...pendingAcks.keys()]) pendingAcks.delete(seq);
    updateLcdStatus();
    if (!bridgeQuitting) scheduleBridgeRestart(wasWedged);
  });

  // Push current state immediately so the panel never waits for the next poll.
  setImmediate(() => sendStateToBridge());
}

/**
 * Restart the sidecar with backoff 1s/2s/4s… (cap 30s, LV-06).
 * @param {boolean} wasWedged - exit followed a watchdog kill: that episode
 * was already counted (no double count), reuse its delay.
 */
function scheduleBridgeRestart(wasWedged = false) {
  if (bridgeQuitting || bridgeChild) return;
  let delayMs;
  if (wasWedged) {
    delayMs = bridgeWatchdog.getState().lastDelayMs || hardening.WATCHDOG_TIMEOUT_MS;
  } else {
    delayMs = bridgeWatchdog.noteRestart();
  }
  const { restarts } = bridgeWatchdog.getState();
  log(`bridge restart #${restarts} in ${delayMs}ms`);
  setTimeout(() => {
    startBridge();
  }, delayMs).unref();
}

// Watchdog tick (LV-06): the sidecar is late at ~1Hz, so check every 1s.
// A fired episode already scheduled its restart via onRestart; here we only
// refresh lcdStatus + the renderer so the wedge is visible immediately.
setInterval(() => {
  const result = bridgeWatchdog.check();
  if (result.restarted) {
    updateLcdStatus();
    pushPlayerState();
  }
}, 1000).unref();

// ---------------------------------------------------------------------------
// lcdStatus (extended): ok/degraded/bridge-wedged/panel-unknown/auth-error/offline
// ---------------------------------------------------------------------------

let lcdStatus = { status: 'offline', reason: 'starting' };

function computeLcdStatus() {
  const { restarts } = bridgeWatchdog.getState();
  if (authBroken) return { status: 'auth-error', reason: lastPollError || 'spotify authorization failed', restarts };
  if (lastBridgeExit && lastBridgeExit.code === 2) {
    const s = bridgeStatusLine();
    return {
      status: 'panel-unknown',
      reason: (s && s.message) || 'bridge refused an unknown panel (exit 2)',
      restarts,
    };
  }
  if (lastBridgeExit && (lastBridgeExit.code === 3 || lastBridgeExit.spawnError)) {
    const s = bridgeStatusLine();
    const reason =
      (s && s.message) ||
      lastBridgeExit.spawnError ||
      `bridge exited (code ${lastBridgeExit.code}): device busy or absent`;
    return { status: 'offline', reason, restarts };
  }
  if (!bridgeChild) return { status: 'offline', reason: 'bridge not running', restarts };
  // LV-06: >5s without status NOR ack while a stream is expected.
  if (bridgeWatchdog.isWedged()) {
    return {
      status: 'bridge-wedged',
      reason: `no bridge status/ack for >5s (restart #${restarts})`,
      restarts,
    };
  }
  const s = bridgeStatusLine();
  if (s && typeof s.queue === 'number' && s.queue >= 20) {
    return { status: 'degraded', reason: `bridge queue high (${s.queue})`, restarts };
  }
  if (exclusivityWarn) return { status: 'degraded', reason: exclusivityWarn, restarts };
  if (lastPollError) return { status: 'degraded', reason: lastPollError, restarts };
  return { status: 'ok', reason: lastPlayer.isPlaying ? 'streaming' : 'idle', restarts };
}

function updateLcdStatus() {
  lcdStatus = computeLcdStatus();
  if (tray) {
    try {
      tray.setToolTip(`LyricVision LCD — ${lcdStatus.status}`);
    } catch {
      // tray may be gone during shutdown
    }
  }
}

function getLcdStatus() {
  return { ...lcdStatus };
}

// ---------------------------------------------------------------------------
// TRCC / SignalRGB exclusivity: DETECT + WARN ONLY (never touch the processes)
// ---------------------------------------------------------------------------

function detectExclusivityHolders() {
  if (process.platform !== 'win32') {
    exclusivityWarn = '';
    return;
  }
  execFile('tasklist', ['/FO', 'CSV', '/NH'], { timeout: 8000 }, (err, stdout) => {
    if (err) return; // detection is best-effort; never break the app
    const found = [];
    for (const line of String(stdout || '').split('\n')) {
      const name = (line.split(',')[0] || '').replace(/"/g, '').trim().toLowerCase();
      if (name === 'trcc.exe' && !found.includes('TRCC')) found.push('TRCC');
      if ((name === 'signalrgb.exe' || name === 'signarbg.exe') && !found.includes('SignalRGB')) {
        found.push('SignalRGB');
      }
    }
    exclusivityWarn = found.length
      ? `${found.join(' + ')} is running and holds the LCD exclusively — quit it before claiming the panel`
      : '';
    updateLcdStatus();
    if (exclusivityWarn) pushPlayerState();
  });
}

// ---------------------------------------------------------------------------
// Startup .lnk (per-user Startup folder ONLY, no elevation; create/remove only)
// ---------------------------------------------------------------------------

function startupShortcutPath() {
  return path.join(
    app.getPath('appData'),
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
    'LyricVision LCD.lnk'
  );
}

function setRunAtStartup(enabled) {
  const linkPath = startupShortcutPath();
  if (!enabled) {
    try {
      if (fs.existsSync(linkPath)) fs.unlinkSync(linkPath);
    } catch (err) {
      throw new Error(`could not remove Startup shortcut: ${String((err && err.message) || err)}`);
    }
    return { enabled: false };
  }
  if (process.platform !== 'win32') throw new Error('run-at-startup is only supported on Windows');
  const target = process.execPath;
  // WScript.Shell via PowerShell: per-user Startup folder needs no elevation.
  const ps = [
    '$ws = New-Object -ComObject WScript.Shell',
    `$sc = $ws.CreateShortcut(${JSON.stringify(linkPath)})`,
    `$sc.TargetPath = ${JSON.stringify(target)}`,
    `$sc.WorkingDirectory = ${JSON.stringify(path.dirname(target))}`,
    `$sc.Description = ${JSON.stringify('LyricVision LCD (Spotify lyrics on USB LCD)')}`,
    '$sc.Save()',
  ].join('; ');
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NonInteractive', '-NoProfile', '-Command', ps],
      { timeout: 15000 },
      (err) => {
        if (err) {
          reject(new Error(`could not create Startup shortcut: ${String((err && err.message) || err)}`));
          return;
        }
        resolve({ enabled: true });
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Window / tray (tray with hide; close hides, Quit exits)
// ---------------------------------------------------------------------------

let mainWindow = null;
let tray = null;
let isQuitting = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 720,
    height: 640,
    title: 'LyricVision LCD',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'renderer', 'index.html'));
  }
  // CSP is enforced by the meta tag in index.html; deny ALL popup windows here.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray() {
  try {
    const { nativeImage } = require('electron');
    let icon = null;
    for (const candidate of ['tray.png', 'icon.png']) {
      const p = path.join(__dirname, 'renderer', candidate);
      try {
        const img = nativeImage.createFromPath(p);
        if (!img.isEmpty()) {
          icon = img;
          break;
        }
      } catch {
        // try next
      }
    }
    tray = new Tray(icon || nativeImage.createEmpty());
  } catch (err) {
    logError('tray unavailable:', String((err && err.message) || err));
    return;
  }
  const menu = Menu.buildFromTemplate([
    {
      label: 'Show',
      click: () => {
        if (mainWindow) mainWindow.show();
      },
    },
    {
      label: 'Hide',
      click: () => {
        if (mainWindow) mainWindow.hide();
      },
    },
    {
      label: 'Refresh now',
      click: () => {
        void pollNow();
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip('LyricVision LCD');
  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) mainWindow.hide();
      else mainWindow.show();
    }
  });
}

// ---------------------------------------------------------------------------
// Diagnostics export (LV-06): redacted snapshot for bug reports
// ---------------------------------------------------------------------------

function diagnosticsFilePath() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(app.getPath('userData'), `diagnostics-${stamp}.json`);
}

function buildDiagnosticsPayload() {
  const bridge = bridgeStatusLine();
  let appVersion = '';
  try {
    appVersion = typeof app.getVersion === 'function' ? app.getVersion() : '';
  } catch {
    appVersion = '';
  }
  if (!appVersion) {
    try {
      appVersion = require('../package.json').version || '';
    } catch {
      appVersion = '';
    }
  }
  return hardening.buildDiagnostics({
    settings: loadSettings(),
    lcdStatus: getLcdStatus(),
    ringEntries: ring.entries(),
    versions: {
      app: appVersion,
      electron: (process.versions && process.versions.electron) || '',
      bridge: 'protocol-v1',
    },
    bridge: bridge
      ? {
          panel: bridge.panel || null,
          pm: bridge.pm,
          sub: bridge.sub,
          fps: bridge.fps,
          queue: bridge.queue,
          frames: bridge.frames,
        }
      : null,
  });
}

function exportDiagnostics() {
  const payload = buildDiagnosticsPayload();
  const filePath = diagnosticsFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
  log(`diagnostics exported to ${filePath}`);
  return { path: filePath };
}

// ---------------------------------------------------------------------------
// Renderer bridge (minimal surface; tokens NEVER cross this boundary)
// ---------------------------------------------------------------------------

function pushPlayerState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const bridge = bridgeStatusLine();
  mainWindow.webContents.send('player-state', {
    player: lastPlayer,
    spotify: spotifyStatus(), // {connected, expiresAt} — no accessToken, ever
    lcd: bridge
      ? { panel: bridge.panel || null, pm: bridge.pm, sub: bridge.sub, fps: bridge.fps, queue: bridge.queue, frames: bridge.frames }
      : null,
    lcdStatus: getLcdStatus(),
    exclusivityWarn,
  });
}

function pushAuthResult(result) {
  pushPlayerState();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('spotify-auth', result);
}

// ---------------------------------------------------------------------------
// Media import (S2-T8b): user-picked PNG/JPEG/GIF -> embedded data: URL
// ---------------------------------------------------------------------------
//
// WHY data: URL (not a media/ copy): the scene must be self-contained for
// settings.json, diagnostics export and the sidecar wire format — a picked
// file is READ ONCE here, validated, and embedded; the renderer and the
// settings file never see the picked path (path privacy is a hard rule).
//
// Caps: the JS copies below are pinned to the Python sidecar constants by
// tests/unit/media-import.test.js (cross-language pin) — if either copy
// drifts, that suite fails. Order mirrors the sidecar's _open_gif:
// bytes -> format -> dim -> frames. The sidecar re-enforces the same caps
// at render time (defence in depth): main bounds what ENTERS scene state,
// the engine bounds what gets DECODED.
//
// The sidecar has no byte cap on still-image paths (_render_image_background
// calls _load_media_bytes without max_bytes), so main applies the 16 MB
// GIF budget to ALL media: it bounds settings.json/diagnostics payload size
// and keeps one honest number instead of a media-kind-dependent surprise.

const SCENE_MEDIA_MAX_BYTES = 16 * 1024 * 1024;
const SCENE_MEDIA_MAX_GIF_DIM = 4096;
const SCENE_MEDIA_MAX_GIF_FRAMES = 512;

const MEDIA_CAPS = {
  maxBytes: SCENE_MEDIA_MAX_BYTES,
  maxGifDim: SCENE_MEDIA_MAX_GIF_DIM,
  maxGifFrames: SCENE_MEDIA_MAX_GIF_FRAMES,
};

const MEDIA_MIME = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif' };

/**
 * Import rejection: `token: detail`, NEVER a file path (every message can
 * reach renderer/logs/diagnostics). detail carries only sizes/limits.
 */
function mediaImportError(token, detail) {
  return new Error(`${token}: ${detail}`);
}

function megabytesLabel(capBytes) {
  return `${Math.floor(capBytes / (1024 * 1024))} MB`;
}

/**
 * Magic-byte sniff (never the extension: a .png full of text is rejected,
 * a real GIF with any name is accepted). Returns the format or null.
 */
function sniffMediaFormat(buf) {
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return 'png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'jpeg';
  }
  if (buf.length >= 6) {
    const head = buf.toString('ascii', 0, 6);
    if (head === 'GIF87a' || head === 'GIF89a') return 'gif';
  }
  return null;
}

// Full magics the sniff tests. Boundary (S2-T8d): magic comparison is
// decisive at the FIRST mismatched byte, at any file length — so the only
// ambiguous case is a file SHORTER than a magic that matches every byte it
// has. That file ends inside its own signature: damaged/incomplete
// (media_unreadable), never "unsupported type". An empty file carries zero
// magic evidence, matches nothing even partially, and keeps the existing
// decisive non-match contract (media_type_unsupported).
const MEDIA_MAGIC_PREFIXES = [
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], // PNG (8)
  [0xff, 0xd8, 0xff], // JPEG (3)
  [0x47, 0x49, 0x46, 0x38, 0x37, 0x61], // GIF87a (6)
  [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], // GIF89a (6)
];

/** True when the buffer ENDS INSIDE a known magic (truncated header). */
function isTruncatedMagic(buf) {
  if (buf.length === 0) return false;
  // Compare ONLY the bytes the file actually has: .every walks the FULL
  // magic array, and past buf.length the buffer reads undefined — testing
  // those entries would make every partial match fail, which is the exact
  // case this gate exists for.
  return MEDIA_MAGIC_PREFIXES.some(
    (magic) =>
      buf.length < magic.length &&
      magic.slice(0, buf.length).every((byte, i) => buf[i] === byte)
  );
}

/**
 * Skip a chain of GIF data sub-blocks starting at `pos` (must point at a
 * length byte). Returns the position after the 0-length terminator; a
 * chain that would run past the buffer is truncation -> media_unreadable.
 */
function gifSkipSubBlocks(buf, pos) {
  while (pos < buf.length) {
    const size = buf[pos];
    pos += 1;
    if (size === 0) return pos;
    if (pos + size > buf.length) {
      throw mediaImportError('media_unreadable', 'the GIF data ends unexpectedly');
    }
    pos += size;
  }
  throw mediaImportError('media_unreadable', 'the GIF data ends unexpectedly');
}

/**
 * Header-only GIF walk (no pixel decode — that is the sidecar's job at
 * render time): logical-screen dimensions from the LSD, then a block walk
 * counting image descriptors with an early exit past the frame cap.
 * Order (bytes already checked, format already sniffed): dim -> frames,
 * matching _open_gif in bridge/lcd_bridge.py. Tolerates 0x00 padding like
 * Pillow; any structural truncation is media_unreadable.
 */
function gifStructuralCheck(buf, caps) {
  if (buf.length < 13) {
    throw mediaImportError('media_unreadable', 'the GIF header is incomplete');
  }
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  if (width > caps.maxGifDim || height > caps.maxGifDim) {
    throw mediaImportError(
      'media_gif_dimensions_exceeded',
      `${width}x${height} pixels, the limit is ${caps.maxGifDim} px per side`
    );
  }
  let pos = 13;
  // Logical screen descriptor packed byte: a global color table (present in
  // virtually every real GIF, absent in the synthetic fixtures) sits between
  // the LSD and the first block — skipping only the LSD would land inside
  // palette bytes and misread them as blocks.
  const lsdPacked = buf[10];
  if (lsdPacked & 0x80) {
    pos += 3 * (2 ** ((lsdPacked & 0x07) + 1));
    if (pos > buf.length) {
      throw mediaImportError('media_unreadable', 'the GIF data ends unexpectedly');
    }
  }
  let frames = 0;
  for (;;) {
    if (pos >= buf.length) {
      throw mediaImportError('media_unreadable', 'the GIF data ends unexpectedly');
    }
    const block = buf[pos];
    if (block === 0x3b) return { width, height, frames }; // trailer
    if (block === 0x00) {
      pos += 1; // tolerate stray padding bytes (Pillow does the same)
      continue;
    }
    if (block === 0x21) {
      pos = gifSkipSubBlocks(buf, pos + 2); // extension intro + label
      continue;
    }
    if (block === 0x2c) {
      if (pos + 10 > buf.length) {
        throw mediaImportError('media_unreadable', 'the GIF data ends unexpectedly');
      }
      frames += 1;
      if (frames > caps.maxGifFrames) {
        // Early exit: a malicious 100k-frame GIF stops costing us here.
        throw mediaImportError(
          'media_gif_frames_exceeded',
          `${frames} frames, the limit is ${caps.maxGifFrames} frames`
        );
      }
      const packed = buf[pos + 9];
      pos += 10;
      if (packed & 0x80) pos += 3 * (2 ** ((packed & 0x07) + 1)); // local color table
      if (pos >= buf.length) {
        throw mediaImportError('media_unreadable', 'the GIF data ends unexpectedly');
      }
      pos += 1; // LZW minimum code size
      pos = gifSkipSubBlocks(buf, pos);
      continue;
    }
    throw mediaImportError('media_unreadable', 'unexpected block in the GIF structure');
  }
}

/**
 * Read one picked file and embed it as a data: URL (test seam — the caps
 * argument exists so boundary logic is testable without 16 MB fixtures,
 * while the real-cap tests below still pin the shipped numbers).
 *
 * Check order (sidecar mirror): kind -> bytes (stat BEFORE read, then a
 * post-read re-check against the TOCTOU window) -> format (magic) ->
 * GIF dim -> GIF frames. Every rejection carries NO path.
 * @param {string} filePath - absolute path from the dialog (never echoed).
 * @param {'image'|'gif'} kind - dialog intent: gif is GIF-only, image is
 *   PNG/JPEG/GIF (Pillow's Image.open accepts all three; oversized stills
 *   are SHRUNK by the sidecar, not rejected, so main does not invent a
 *   refusal the render path does not have).
 * @param {{maxBytes:number,maxGifDim:number,maxGifFrames:number}} [caps]
 * @returns {Promise<string>} data:<mime>;base64,<payload>
 */
async function importMediaFromPath(filePath, kind, caps = MEDIA_CAPS) {
  if (kind !== 'image' && kind !== 'gif') {
    throw mediaImportError('media_kind_unsupported', 'kind must be "image" or "gif"');
  }
  let size;
  try {
    size = (await fs.promises.stat(filePath)).size;
  } catch {
    throw mediaImportError('media_unreadable', 'the file could not be opened');
  }
  if (size > caps.maxBytes) {
    // stat-first: a huge file is refused without ever being read.
    throw mediaImportError(
      'media_file_too_large',
      `${size} bytes, the limit is ${megabytesLabel(caps.maxBytes)}`
    );
  }
  let buf;
  try {
    buf = await fs.promises.readFile(filePath);
  } catch {
    throw mediaImportError('media_unreadable', 'the file could not be read');
  }
  if (buf.length > caps.maxBytes) {
    // TOCTOU belt: the file grew between stat and read.
    throw mediaImportError(
      'media_file_too_large',
      `${buf.length} bytes, the limit is ${megabytesLabel(caps.maxBytes)}`
    );
  }
  const format = sniffMediaFormat(buf);
  if (!format && isTruncatedMagic(buf)) {
    // Shorter than the signature it matches byte-for-byte: the file is cut
    // short, so claiming "unsupported type" would be a false statement about
    // a perfectly supported format.
    throw mediaImportError(
      'media_unreadable',
      'the file ends inside its type signature — it looks truncated or incomplete'
    );
  }
  if (!format || (kind === 'gif' && format !== 'gif')) {
    throw mediaImportError(
      'media_type_unsupported',
      kind === 'gif' ? 'expected GIF data' : 'expected PNG, JPEG, or GIF data'
    );
  }
  if (kind === 'gif') gifStructuralCheck(buf, caps); // dim -> frames
  return `data:${MEDIA_MIME[format]};base64,${buf.toString('base64')}`;
}

/**
 * Dialog flow for `media:import`: validate the kind BEFORE the dialog
 * opens, cancelled/no-file results resolve null (a deliberate no-op the
 * renderer must not treat as an error), and only main's dialog module and
 * window are injectable for tests.
 */
async function handleMediaImport(kind, dialogModule, parentWindow) {
  if (kind !== 'image' && kind !== 'gif') {
    throw mediaImportError('media_kind_unsupported', 'kind must be "image" or "gif"');
  }
  const options = {
    properties: ['openFile'],
    filters:
      kind === 'gif'
        ? [{ name: 'GIF images', extensions: ['gif'] }]
        : [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif'] }],
  };
  const result = parentWindow
    ? await dialogModule.showOpenDialog(parentWindow, options)
    : await dialogModule.showOpenDialog(options);
  if (
    !result ||
    result.canceled === true ||
    !Array.isArray(result.filePaths) ||
    result.filePaths.length === 0
  ) {
    return null;
  }
  return importMediaFromPath(result.filePaths[0], kind, MEDIA_CAPS);
}

function registerIpc() {
  ipcMain.handle('settings:get', () => ({
    settings: loadSettings(),
    spotify: spotifyStatus(),
    startupSupported: process.platform === 'win32',
  }));

  ipcMain.handle('settings:save', (_event, patch) => {
    const { accepted, rejected } = validateSettingsPatch(patch);
    const next = { ...loadSettings(), ...accepted };
    persistSettings(next);
    if (accepted.serial !== undefined && bridgeChild) {
      // Serial change requires a fresh claim: restart the sidecar.
      try {
        bridgeChild.kill();
      } catch {
        // exit handler restarts it
      }
    }
    if (
      accepted.lcdFps !== undefined ||
      accepted.syncOffsetMs !== undefined ||
      accepted.layout !== undefined ||
      // Scene edits (S1-T7a) must reach the sidecar without waiting for
      // the next poll tick.
      accepted.scene !== undefined
    ) {
      sendStateToBridge();
    }
    return { settings: next, rejected };
  });

  // S2-T8: the live preview rides the SAME sidecar; handlePreviewRequest
  // re-validates the scene before a byte reaches the pipe.
  ipcMain.handle('scene:preview', (_event, scene) => handlePreviewRequest(scene, bridgeChild));

  // S2-T8b: media import runs ENTIRELY in main (dialog + read + validate);
  // only an embedded data: URL ever crosses back to the renderer, so the
  // picked path never reaches renderer state, settings or diagnostics.
  ipcMain.handle('media:import', (_event, kind) => {
    const parentWindow =
      typeof BrowserWindow.getFocusedWindow === 'function'
        ? BrowserWindow.getFocusedWindow()
        : null;
    return handleMediaImport(kind, dialog, parentWindow);
  });

  ipcMain.handle('spotify:connect', async (_event, args) => {
    const clientId = args && typeof args.clientId === 'string' ? args.clientId.trim() : '';
    if (clientId) persistSettings({ ...loadSettings(), spotifyClientId: clientId });
    await startSpotifyAuth(clientId || undefined);
    return { started: true };
  });

  ipcMain.handle('display:list', () => {
    const bridge = bridgeStatusLine();
    if (!bridge) return [];
    return [
      {
        panel: bridge.panel || 'unknown',
        pm: bridge.pm,
        sub: bridge.sub,
        fps: bridge.fps,
        frames: bridge.frames,
      },
    ];
  });

  ipcMain.handle('window:minimize', () => {
    if (mainWindow) mainWindow.minimize();
  });
  ipcMain.handle('window:hide', () => {
    if (mainWindow) mainWindow.hide();
  });
  ipcMain.handle('window:show', () => {
    if (mainWindow) mainWindow.show();
  });

  ipcMain.handle('app:refresh', async () => {
    await pollNow();
    return { ok: true };
  });

  ipcMain.handle('startup:set', async (_event, enabled) => {
    const result = await setRunAtStartup(enabled === true);
    persistSettings({ ...loadSettings(), runAtStartup: result.enabled });
    return result;
  });

  ipcMain.handle('diagnostics:export', () => exportDiagnostics());
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    migratePlaintextTokens();
    memoryTokens = readVault();
    registerIpc();
    createWindow();
    createTray();
    detectExclusivityHolders();
    setInterval(detectExclusivityHolders, 60000).unref();
    startBridge();
    void pollNow();
    updateLcdStatus();
  });

  app.on('window-all-closed', () => {
    // Tray keeps the app alive; explicit Quit exits (Windows convention here).
  });

  app.on('before-quit', () => {
    isQuitting = true;
    bridgeQuitting = true;
    if (pollTimer) clearTimeout(pollTimer);
    closeOAuthServer();
    if (bridgeChild) {
      try {
        bridgeChild.stdin.end();
      } catch {
        // already gone
      }
      bridgeChild.kill();
      bridgeChild = null;
    }
  });
}

// LV-08 test hook: pure helpers for the plain-node smoke test
// (tests/test_sync_settings.js stubs `electron` before requiring this file).
// Under Electron the entry return value is ignored, so this is a no-op there.
module.exports = {
  POLL_PLAYING_MS,
  POLL_IDLE_MS,
  FETCH_TIMEOUT_MS,
  LRC_RETRIES,
  LRC_BACKOFF_BASE_MS,
  DEFAULT_SYNC_OFFSET_MS,
  SYNC_OFFSET_MIN_MS,
  SYNC_OFFSET_MAX_MS,
  SYNC_OFFSET_STEP_MS,
  DEFAULT_LAYOUT,
  SETTINGS_SCHEMA,
  clampFps,
  clampSyncOffset,
  normalizeLayout,
  pickBestArtworkUrl,
  validateSettingsPatch,
  toPlayerState,
  buildBridgeState,
  buildBridgeEnvelope,
  redact,
  base64url,
  OAUTH_PORT_START,
  OAUTH_PORT_END,
  listenOnFirstFreePort,
  closeOAuthServer,
  LYRICS_CACHE_MAX,
  LYRICS_CACHE_TTL_MS,
  lyricsCacheKey,
  cacheGet,
  cacheSet,
  scoreSearchResult,
  detectExclusivityHolders,
  computeLcdStatus,
  bridgeStatusLine,
  handleBridgeLine,
  handlePreviewRequest,
  // S2-T8b media import seams (dialog/read/validation are testable without
  // hardware; cap constants are pinned to the Python sidecar by
  // tests/unit/media-import.test.js).
  registerIpc,
  handleMediaImport,
  importMediaFromPath,
  MEDIA_CAPS,
  SCENE_MEDIA_MAX_BYTES,
  SCENE_MEDIA_MAX_GIF_DIM,
  SCENE_MEDIA_MAX_GIF_FRAMES,
  getLcdStatus,
  buildDiagnosticsPayload,
  diagnosticsFilePath,
  currentTrackKey,
  createTray,
  createWindow,
  startBridge,
  sendStateToBridge,
  createSceneFanout,
  pollNow,
  bridgeWatchdog,
};
