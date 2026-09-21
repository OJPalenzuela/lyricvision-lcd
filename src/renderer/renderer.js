'use strict';

/* LyricVision LCD — renderer (LV-05). Vanilla JS, English UI.
 * All DOM writes use textContent (never innerHTML). No tokens here:
 * main only pushes {connected, expiresAt} for Spotify state. */

const $ = (id) => document.getElementById(id);

const els = {
  clientId: $('client-id'),
  connectBtn: $('connect-btn'),
  spotifyState: $('spotify-state'),
  fps: $('fps'),
  fpsValue: $('fps-value'),
  syncOffset: $('sync-offset'),
  syncOffsetValue: $('sync-offset-value'),
  serial: $('serial'),
  startup: $('startup'),
  saveBtn: $('save-btn'),
  refreshBtn: $('refresh-btn'),
  settingsState: $('settings-state'),
  panel: $('st-panel'),
  stream: $('st-stream'),
  track: $('st-track'),
  lyric: $('st-lyric'),
  lcdStatus: $('st-lcdstatus'),
  reason: $('st-reason'),
  exclusivity: $('exclusivity-state'),
  diagExportBtn: $('diag-export-btn'),
  diagState: $('diag-state'),
  lcdStatusInline: $('st-lcdstatus-inline'),
  minBtn: $('min-btn'),
  hideBtn: $('hide-btn'),
};

function setText(el, value) {
  el.textContent = value;
}

/** Slider seconds -> whole ms for the label (LV-08, textContent only). */
function formatOffsetMs(seconds) {
  const ms = Math.round(Number(seconds) * 1000);
  return `${Number.isFinite(ms) ? ms : 0} ms`;
}

/** LV-09 unified: single view, no layout selector. Old `layout` values in
 * settings.json are still accepted by main (compat) but ignored here. */

function renderState(state) {
  if (!state || typeof state !== 'object') return;
  const { player, spotify, lcd, lcdStatus, exclusivityWarn } = state;

  if (spotify) {
    if (spotify.connected) {
      const when = spotify.expiresAt ? new Date(spotify.expiresAt).toLocaleTimeString() : 'unknown';
      setText(els.spotifyState, `Connected (token expires ${when}).`);
    } else {
      setText(els.spotifyState, 'Not connected.');
    }
  }

  if (lcd && lcd.panel) {
    setText(els.panel, `${lcd.panel} (PM ${lcd.pm} / SUB ${lcd.sub})`);
    setText(els.stream, `FPS ${lcd.fps} · queue ${lcd.queue} · frames ${lcd.frames}`);
  } else {
    setText(els.panel, 'No panel claimed yet.');
    setText(els.stream, '—');
  }

  if (player && player.track) {
    setText(els.track, `${player.track.title} — ${player.track.artist}`);
    const lyric = player.lyric || {};
    setText(els.lyric, `${lyric.current_line || '(no synced line)'}${lyric.next_line ? ` / next: ${lyric.next_line}` : ''}`);
  } else {
    setText(els.track, player && player.isPlaying ? 'Playing (no metadata).' : 'Idle.');
    setText(els.lyric, '—');
  }

  if (lcdStatus) {
    setText(els.lcdStatus, lcdStatus.status);
    setText(els.reason, lcdStatus.reason || '');
    setText(
      els.lcdStatusInline,
      `${lcdStatus.status}${lcdStatus.reason ? ` — ${lcdStatus.reason}` : ''}${
        lcdStatus.restarts ? ` (restarts: ${lcdStatus.restarts})` : ''
      }`
    );
  }

  setText(els.exclusivity, exclusivityWarn || 'No exclusive holder detected (TRCC/SignalRGB closed).');
}

async function boot() {
  const api = window.lyricvision;
  if (!api) {
    setText(els.settingsState, 'Renderer bridge missing (preload failed).');
    return;
  }

  try {
    const { settings, spotify } = await api.getSettings();
    els.clientId.value = settings.spotifyClientId || '';
    els.fps.value = String(settings.lcdFps || 10);
    setText(els.fpsValue, String(settings.lcdFps || 10));
    const offsetMs = Number.isFinite(Number(settings.syncOffsetMs)) ? Math.round(Number(settings.syncOffsetMs)) : 0;
    els.syncOffset.value = String(offsetMs / 1000);
    setText(els.syncOffsetValue, formatOffsetMs(offsetMs / 1000));
    els.serial.value = settings.serial || '';
    els.startup.checked = settings.runAtStartup === true;
    renderState({ player: null, spotify, lcd: null, lcdStatus: null, exclusivityWarn: '' });
  } catch (err) {
    setText(els.settingsState, `Could not load settings: ${err.message || err}`);
  }

  els.fps.addEventListener('input', () => setText(els.fpsValue, els.fps.value));
  els.syncOffset.addEventListener('input', () => setText(els.syncOffsetValue, formatOffsetMs(els.syncOffset.value)));

  els.connectBtn.addEventListener('click', async () => {
    setText(els.spotifyState, 'Opening Spotify authorization in your browser…');
    try {
      await api.connectSpotify(els.clientId.value.trim());
      setText(els.spotifyState, 'Authorization started — finish in the browser tab.');
    } catch (err) {
      setText(els.spotifyState, `Could not start authorization: ${err.message || err}`);
    }
  });

  els.saveBtn.addEventListener('click', async () => {
    setText(els.settingsState, 'Saving…');
    try {
      const { rejected } = await api.saveSettings({
        spotifyClientId: els.clientId.value.trim(),
        lcdFps: Number(els.fps.value),
        syncOffsetMs: Math.round(Number(els.syncOffset.value) * 1000),
        serial: els.serial.value.trim(),
        runAtStartup: els.startup.checked,
      });
      setText(
        els.settingsState,
        rejected && rejected.length
          ? `Saved (ignored invalid keys: ${rejected.join(', ')}).`
          : 'Saved.'
      );
    } catch (err) {
      setText(els.settingsState, `Save failed: ${err.message || err}`);
    }
  });

  els.startup.addEventListener('change', async () => {
    try {
      await api.setStartup(els.startup.checked);
      try {
        await api.saveSettings({ runAtStartup: els.startup.checked });
      } catch {
        // startup toggle already applied; settings mirror is best-effort
      }
      setText(els.settingsState, els.startup.checked ? 'Will start with Windows.' : 'Startup entry removed.');
    } catch (err) {
      els.startup.checked = !els.startup.checked;
      setText(els.settingsState, `Startup change failed: ${err.message || err}`);
    }
  });

  els.refreshBtn.addEventListener('click', async () => {
    try {
      await api.refresh();
    } catch (err) {
      setText(els.settingsState, `Refresh failed: ${err.message || err}`);
    }
  });

  els.diagExportBtn.addEventListener('click', async () => {
    setText(els.diagState, 'Exporting…');
    try {
      const { path } = await api.exportDiagnostics();
      setText(els.diagState, `Diagnostics written to ${path}`);
    } catch (err) {
      setText(els.diagState, `Export failed: ${err.message || err}`);
    }
  });

  els.minBtn.addEventListener('click', () => api.minimize());
  els.hideBtn.addEventListener('click', () => api.hide());

  api.onPlayerState((state) => renderState(state));
  api.onSpotifyAuth((result) => {
    if (result && result.ok) setText(els.spotifyState, 'Connected.');
    else setText(els.spotifyState, `Authorization failed: ${(result && result.error) || 'unknown'}`);
  });
}

document.addEventListener('DOMContentLoaded', () => void boot());
