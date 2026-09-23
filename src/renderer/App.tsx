import { useCallback, useEffect, useState } from "react";
import { Pause, Play } from "lucide-react";

import SceneEditor from "@/components/SceneEditor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import {
  errMessage,
  exclusivityTextOf,
  formatOffsetMs,
  lcdStatusInlineText,
  spotifyStateText,
  type LcdSnapshot,
  type LcdStatus,
  type PlayerSnapshot,
  type PlayerStatePush,
  type SpotifyState,
} from "@/lib/bridge";
import { DEFAULT_SCENE } from "@/lib/scene";
import { useSceneStore } from "@/lib/sceneStore";

function statusBadgeVariant(status: string | undefined) {
  switch (status) {
    case "ok":
      return "default" as const;
    case "degraded":
      return "secondary" as const;
    case "bridge-wedged":
    case "panel-unknown":
    case "auth-error":
      return "destructive" as const;
    case "offline":
    default:
      return "outline" as const;
  }
}

export default function App() {
  // Settings form fields.
  const [clientId, setClientId] = useState("");
  const [fps, setFps] = useState(10);
  const [syncOffsetSec, setSyncOffsetSec] = useState(0);
  const [serial, setSerial] = useState("");
  const [runAtStartup, setRunAtStartup] = useState(false);

  // Scene editor (S2-T8): the scene is APP-level in lifetime (it survives
  // the editor closing and feeds Save/Reset) but its single source of
  // truth is the Zustand scene store (S7-T20) — App is a thin shell that
  // only wires store state/actions into SceneEditor's props contract.
  // Editor-only UI state (selection, section, drafts) stays in SceneEditor.
  const scene = useSceneStore((s) => s.scene);
  const setScene = useSceneStore((s) => s.setScene);
  const hydrateScene = useSceneStore((s) => s.hydrate);
  const markSceneSaved = useSceneStore((s) => s.markSaved);
  const resetScene = useSceneStore((s) => s.resetToSaved);

  // Live snapshots pushed by the main process.
  const [player, setPlayer] = useState<PlayerSnapshot | null>(null);
  const [lcd, setLcd] = useState<LcdSnapshot | null>(null);
  const [spotify, setSpotify] = useState<SpotifyState | null>(null);
  const [lcdStatus, setLcdStatus] = useState<LcdStatus | null>(null);

  // Rendered state strings (same wording as the previous renderer).
  const [spotifyState, setSpotifyState] = useState("Not connected.");
  const [settingsState, setSettingsState] = useState("");
  const [diagState, setDiagState] = useState("");
  const [panelText, setPanelText] = useState("—");
  const [streamText, setStreamText] = useState("—");
  const [trackText, setTrackText] = useState("—");
  const [lyricText, setLyricText] = useState("—");
  const [exclusivityText, setExclusivityText] = useState("Checking…");

  const applySnapshot = useCallback((state: PlayerStatePush | null | undefined) => {
    if (!state || typeof state !== "object") return;
    const { player: p, spotify: s, lcd: l, lcdStatus: st, exclusivityWarn } = state;

    if (s) {
      setSpotify(s);
      setSpotifyState(spotifyStateText(s));
    }

    if (l && l.panel) {
      setLcd(l);
      setPanelText(`${l.panel} (PM ${l.pm} / SUB ${l.sub})`);
      setStreamText(`FPS ${l.fps} · queue ${l.queue} · frames ${l.frames}`);
    } else {
      setLcd(null);
      setPanelText("No panel claimed yet.");
      setStreamText("—");
    }

    if (p && p.track) {
      setPlayer(p);
      setTrackText(`${p.track.title} — ${p.track.artist}`);
      const lyric = p.lyric || {};
      setLyricText(
        `${lyric.current_line || "(no synced line)"}${
          lyric.next_line ? ` / next: ${lyric.next_line}` : ""
        }`
      );
    } else {
      setPlayer(p ?? null);
      setTrackText(p && p.isPlaying ? "Playing (no metadata)." : "Idle.");
      setLyricText("—");
    }

    if (st) setLcdStatus(st);

    setExclusivityText(exclusivityTextOf(exclusivityWarn));
  }, []);

  useEffect(() => {
    const api = window.lyricvision;
    if (!api) {
      setSettingsState("Renderer bridge missing (preload failed).");
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const { settings, spotify: initialSpotify } = await api.getSettings();
        if (cancelled) return;
        setClientId(settings.spotifyClientId || "");
        setFps(
          typeof settings.lcdFps === "number" && Number.isFinite(settings.lcdFps)
            ? settings.lcdFps
            : 10
        );
        const offsetMs = Number.isFinite(Number(settings.syncOffsetMs))
          ? Math.round(Number(settings.syncOffsetMs))
          : 0;
        setSyncOffsetSec(offsetMs / 1000);
        setSerial(settings.serial || "");
        setRunAtStartup(settings.runAtStartup === true);
        // why: ONE hydrate installs the scene, the Reset baseline, and a
        // cleared history — the boot scene is the root of undo, not an
        // undoable edit (see sceneStore.hydrate).
        hydrateScene(settings.scene ?? DEFAULT_SCENE);
        applySnapshot({
          player: null,
          spotify: initialSpotify,
          lcd: null,
          lcdStatus: null,
          exclusivityWarn: "",
        });
      } catch (err) {
        if (!cancelled)
          setSettingsState(`Could not load settings: ${errMessage(err)}`);
      }
    })();

    const offPlayer = api.onPlayerState((state) => applySnapshot(state));
    const offAuth = api.onSpotifyAuth((result) => {
      if (result && result.ok) setSpotifyState("Connected.");
      else
        setSpotifyState(
          `Authorization failed: ${(result && result.error) || "unknown"}`
        );
    });
    return () => {
      cancelled = true;
      offPlayer();
      offAuth();
    };
  }, [applySnapshot]);

  async function handleConnect() {
    const api = window.lyricvision;
    if (!api) return;
    setSpotifyState("Opening Spotify authorization in your browser…");
    try {
      await api.connectSpotify(clientId.trim());
      setSpotifyState("Authorization started — finish in the browser tab.");
    } catch (err) {
      setSpotifyState(`Could not start authorization: ${errMessage(err)}`);
    }
  }

  async function handleSave() {
    const api = window.lyricvision;
    if (!api) return;
    setSettingsState("Saving…");
    try {
      const { rejected } = await api.saveSettings({
        spotifyClientId: clientId.trim(),
        lcdFps: Number(fps),
        syncOffsetMs: Math.round(Number(syncOffsetSec) * 1000),
        serial: serial.trim(),
        runAtStartup,
      });
      setSettingsState(
        rejected && rejected.length
          ? `Saved (ignored invalid keys: ${rejected.join(", ")}).`
          : "Saved."
      );
    } catch (err) {
      setSettingsState(`Save failed: ${errMessage(err)}`);
    }
  }

  async function handleStartupChange(next: boolean) {
    const api = window.lyricvision;
    if (!api) return;
    setRunAtStartup(next);
    try {
      await api.setStartup(next);
      try {
        await api.saveSettings({ runAtStartup: next });
      } catch {
        // Startup toggle already applied; settings mirror is best-effort.
      }
      setSettingsState(
        next ? "Will start with Windows." : "Startup entry removed."
      );
    } catch (err) {
      setRunAtStartup(!next);
      setSettingsState(`Startup change failed: ${errMessage(err)}`);
    }
  }

  async function handleRefresh() {
    const api = window.lyricvision;
    if (!api) return;
    try {
      await api.refresh();
    } catch (err) {
      setSettingsState(`Refresh failed: ${errMessage(err)}`);
    }
  }

  async function handleExportDiagnostics() {
    const api = window.lyricvision;
    if (!api) return;
    setDiagState("Exporting…");
    try {
      const { path } = await api.exportDiagnostics();
      setDiagState(`Diagnostics written to ${path}`);
    } catch (err) {
      setDiagState(`Export failed: ${errMessage(err)}`);
    }
  }

  function handleMinimize() {
    window.lyricvision?.minimize();
  }

  function handleHide() {
    window.lyricvision?.hide();
  }

  const track = player?.track ?? null;
  const currentLine = player?.lyric?.current_line || "";
  const nextLine = player?.lyric?.next_line || "";
  const monogramSource = (track?.title || "").trim();
  const monogram = monogramSource ? monogramSource.charAt(0).toUpperCase() : "?";
  const isPlaying = player?.isPlaying === true;
  const spotifyConnected = spotify?.connected === true;

  return (
    <main className="mx-auto w-full max-w-[640px] px-5 py-5">
      {/* Header: app name + the single most important signal, the live status. */}
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            LyricVision LCD
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Spotify synced lyrics on your Thermalright USB LCD
          </p>
        </div>
        <Badge variant={statusBadgeVariant(lcdStatus?.status)}>
          {lcdStatus?.status ?? "starting"}
        </Badge>
      </header>

      {/* Hero: what is playing right now. */}
      <section aria-label="Now playing" className="mt-4">
        <Card>
          <CardContent className="flex gap-4 p-5">
            {/* Stylized placeholder: remote artwork is blocked by the
                production CSP (img-src 'self' data:) by design. */}
            <div
              aria-hidden="true"
              className="flex h-20 w-20 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-primary/70 via-primary/30 to-secondary text-3xl font-bold text-primary-foreground"
            >
              {monogram}
            </div>
            <div className="min-w-0 flex-1">
              {track ? (
                <>
                  <p className="truncate text-2xl font-semibold leading-tight tracking-tight">
                    {track.title}
                  </p>
                  <p className="mt-0.5 truncate text-sm text-muted-foreground">
                    {track.artist}
                    {track.album ? ` · ${track.album}` : ""}
                  </p>
                  {currentLine ? (
                    <p className="mt-2 text-base font-medium leading-snug">
                      {currentLine}
                    </p>
                  ) : (
                    <p className="mt-2 text-sm text-muted-foreground">
                      (no synced line)
                    </p>
                  )}
                  {nextLine ? (
                    <p className="mt-0.5 truncate text-sm text-muted-foreground">
                      Next: {nextLine}
                    </p>
                  ) : null}
                </>
              ) : (
                <>
                  <p className="text-2xl font-semibold leading-tight tracking-tight text-muted-foreground">
                    Idle
                  </p>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    Start playback on Spotify to see synced lyrics here.
                  </p>
                </>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  {isPlaying ? (
                    <Play className="h-3 w-3" aria-hidden="true" />
                  ) : (
                    <Pause className="h-3 w-3" aria-hidden="true" />
                  )}
                  {isPlaying ? "Playing" : "Paused"}
                </span>
                <span aria-hidden="true">·</span>
                <span>{lcd ? `FPS ${lcd.fps} · queue ${lcd.queue} · frames ${lcd.frames}` : "LCD not streaming"}</span>
                <span aria-hidden="true">·</span>
                <span>{spotifyConnected ? "Spotify connected" : "Spotify not connected"}</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* Settings: Spotify connection. */}
      <section aria-label="Spotify connection" className="mt-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Spotify</CardTitle>
            <CardDescription>
              Connect with a Spotify app client ID (PKCE, browser flow).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="client-id">Client ID</Label>
              <Input
                id="client-id"
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder="Spotify app client ID"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
              />
            </div>
            <Button type="button" onClick={() => void handleConnect()}>
              Connect Spotify
            </Button>
            <p id="spotify-state" role="status" className="text-sm text-muted-foreground">
              {spotifyState}
            </p>
          </CardContent>
        </Card>
      </section>

      {/* Settings: LCD stream. */}
      <section aria-label="LCD settings" className="mt-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">LCD</CardTitle>
            <CardDescription>
              Stream rate, lyric timing, panel selection and startup.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="fps">
                Stream rate (FPS): <span id="fps-value">{String(fps)}</span>
              </Label>
              <Slider
                id="fps"
                thumbLabel="Stream rate (FPS)"
                min={5}
                max={30}
                step={1}
                value={[fps]}
                onValueChange={([v]) => setFps(v)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="sync-offset">
                Lyric sync offset (seconds):{" "}
                <span id="sync-offset-value">{formatOffsetMs(syncOffsetSec)}</span>
              </Label>
              <Slider
                id="sync-offset"
                thumbLabel="Lyric sync offset (seconds)"
                min={-2}
                max={2}
                step={0.1}
                value={[syncOffsetSec]}
                onValueChange={([v]) => setSyncOffsetSec(v)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="serial">
                USB serial (blank = first panel found)
              </Label>
              <Input
                id="serial"
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder="auto"
                value={serial}
                onChange={(e) => setSerial(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="startup"
                checked={runAtStartup}
                onCheckedChange={(v) => void handleStartupChange(v === true)}
              />
              <Label htmlFor="startup">Start with Windows</Label>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={() => void handleSave()}>
                Save settings
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => void handleRefresh()}
              >
                Refresh now
              </Button>
            </div>
            <p id="settings-state" role="status" className="text-sm text-muted-foreground">
              {settingsState || " "}
            </p>
          </CardContent>
        </Card>
      </section>

      {/* Scene editor (S2-T8, reworked S7-T19): a TRCC-style persistent
          side rail — every section is always editable, no enter/exit
          toggle; the live preview stays in the main area. */}
      <section aria-label="Scene" className="mt-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Scene</CardTitle>
            <CardDescription>
              Background and overlay layout painted on the panel, with a live
              preview on the connected display.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <SceneEditor
              scene={scene}
              onSceneChange={setScene}
              onReset={resetScene}
              onSaved={markSceneSaved}
            />
          </CardContent>
        </Card>
      </section>

      {/* Status detail grid. */}
      <section aria-label="Status" className="mt-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Status</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[150px_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted-foreground">LCD panel</dt>
              <dd className="break-words">{panelText}</dd>
              <dt className="text-muted-foreground">FPS / queue / frames</dt>
              <dd className="break-words">{streamText}</dd>
              <dt className="text-muted-foreground">Track</dt>
              <dd className="break-words">{trackText}</dd>
              <dt className="text-muted-foreground">Lyric</dt>
              <dd className="break-words">{lyricText}</dd>
              <dt className="text-muted-foreground">lcdStatus</dt>
              <dd className="break-words">{lcdStatus?.status ?? "—"}</dd>
              <dt className="text-muted-foreground">Detail</dt>
              <dd className="break-words">
                {lcdStatus ? lcdStatus.reason || "" : "—"}
              </dd>
            </dl>
          </CardContent>
        </Card>
      </section>

      {/* Tertiary: exclusivity warning + diagnostics. */}
      <section aria-label="TRCC and SignalRGB guide" className="mt-4">
        <Card className="border-muted">
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">
              TRCC / SignalRGB
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>{exclusivityText}</p>
            <p>
              TRCC and SignalRGB open the LCD exclusively. Quit them fully
              before LyricVision can claim the panel; otherwise the status
              above reports the device as busy (blocked) instead of streaming.
            </p>
          </CardContent>
        </Card>
      </section>

      <section aria-label="Diagnostics" className="mt-4">
        <Card className="border-muted">
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Diagnostics
            </CardTitle>
            <CardDescription>
              Status detail ({lcdStatusInlineText(lcdStatus)}) and a redacted
              snapshot for bug reports (no tokens or serials).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button
              type="button"
              variant="secondary"
              onClick={() => void handleExportDiagnostics()}
            >
              Export diagnostics
            </Button>
            <p id="diag-state" role="status" className="text-sm text-muted-foreground">
              {diagState || " "}
            </p>
          </CardContent>
        </Card>
      </section>

      <Separator className="my-4" />

      <footer className="flex gap-2 pb-2">
        <Button type="button" variant="ghost" onClick={handleMinimize}>
          Minimize
        </Button>
        <Button type="button" variant="outline" onClick={handleHide}>
          Hide to tray
        </Button>
      </footer>
    </main>
  );
}
