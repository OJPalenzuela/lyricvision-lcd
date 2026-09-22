/**
 * Typed view of the frozen `window.lyricvision` preload bridge.
 * The IPC surface and settings keys are fixed — this file only types them.
 */

import type { Scene } from "./scene";

/** Whitelisted settings keys the renderer may send (never `layout`, never tokens). */
export interface SettingsPatch {
  spotifyClientId: string;
  lcdFps: number;
  /** Whole milliseconds; valid only within -2000…2000 or the key is rejected. */
  syncOffsetMs: number;
  serial: string;
  runAtStartup: boolean;
  /** Scene layout (S2-T8): re-validated by hardening.validateScene in settings:save. */
  scene: Scene;
}

export interface StoredSettings {
  spotifyClientId: string;
  lcdFps: number;
  syncOffsetMs: number;
  layout: string;
  serial: string;
  runAtStartup: boolean;
  scene: Scene;
}

export interface SpotifyState {
  connected: boolean;
  expiresAt?: string | null;
}

export interface TrackInfo {
  title: string;
  artist: string;
  album: string;
  /** Received but never rendered: production CSP blocks remote images by design. */
  artworkUrl?: string;
}

export interface LyricInfo {
  current_line?: string;
  next_line?: string;
}

export interface PlayerSnapshot {
  isPlaying?: boolean;
  progressMs?: number;
  measuredAt?: number;
  durationMs?: number;
  track?: TrackInfo;
  lyric?: LyricInfo;
}

export interface LcdSnapshot {
  panel?: string;
  pm?: string;
  sub?: string;
  fps?: number;
  queue?: number;
  frames?: number;
}

export type LcdStatusKind =
  | "ok"
  | "degraded"
  | "bridge-wedged"
  | "panel-unknown"
  | "auth-error"
  | "offline";

export interface LcdStatus {
  status: LcdStatusKind | string;
  reason?: string;
  restarts?: number;
}

export interface PlayerStatePush {
  player?: PlayerSnapshot | null;
  spotify?: SpotifyState | null;
  lcd?: LcdSnapshot | null;
  lcdStatus?: LcdStatus | null;
  exclusivityWarn?: string;
}

export interface SpotifyAuthResult {
  ok: boolean;
  error?: string;
}

export interface LyricvisionBridge {
  getSettings(): Promise<{
    settings: StoredSettings;
    spotify: SpotifyState;
    startupSupported: boolean;
  }>;
  saveSettings(patch: Partial<SettingsPatch>): Promise<{ rejected: string[] }>;
  previewScene(scene: Scene): Promise<string>;
  connectSpotify(clientId: string): Promise<unknown>;
  listDisplays(): Promise<unknown>;
  minimize(): void;
  hide(): void;
  show(): void;
  refresh(): Promise<unknown>;
  setStartup(enabled: boolean): Promise<unknown>;
  exportDiagnostics(): Promise<{ path: string }>;
  onPlayerState(callback: (state: PlayerStatePush) => void): () => void;
  onSpotifyAuth(callback: (result: SpotifyAuthResult) => void): () => void;
}

declare global {
  interface Window {
    lyricvision?: LyricvisionBridge;
  }
}

export function errMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

/** Slider seconds -> whole ms for the label (textContent only, as before). */
export function formatOffsetMs(seconds: number): string {
  const ms = Math.round(Number(seconds) * 1000);
  return `${Number.isFinite(ms) ? ms : 0} ms`;
}

export function spotifyStateText(spotify: SpotifyState): string {
  if (spotify.connected) {
    const when = spotify.expiresAt
      ? new Date(spotify.expiresAt).toLocaleTimeString()
      : "unknown";
    return `Connected (token expires ${when}).`;
  }
  return "Not connected.";
}

export function lcdStatusInlineText(lcdStatus: LcdStatus | null): string {
  if (!lcdStatus) return "—";
  return (
    `${lcdStatus.status}` +
    `${lcdStatus.reason ? ` — ${lcdStatus.reason}` : ""}` +
    `${lcdStatus.restarts ? ` (restarts: ${lcdStatus.restarts})` : ""}`
  );
}

export function exclusivityTextOf(warn: string | undefined): string {
  return warn || "No exclusive holder detected (TRCC/SignalRGB closed).";
}
