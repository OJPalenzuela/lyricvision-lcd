import { act } from 'react';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import App from '@/App';
import type {
  LyricvisionBridge,
  PlayerStatePush,
  StoredSettings,
} from '@/lib/bridge';

type PushFn = (state: PlayerStatePush) => void;
type AuthFn = (result: { ok: boolean; error?: string }) => void;

interface StubBridge extends LyricvisionBridge {
  onPlayerState: Mock<(cb: PushFn) => () => void>;
  onSpotifyAuth: Mock<(cb: AuthFn) => () => void>;
}

const DEFAULT_SETTINGS: StoredSettings = {
  spotifyClientId: '',
  lcdFps: 10,
  syncOffsetMs: 0,
  layout: 'lyrics',
  serial: '',
  runAtStartup: false,
};

function makeBridge(settings: Partial<StoredSettings> = {}): StubBridge {
  const stored = { ...DEFAULT_SETTINGS, ...settings };
  return {
    getSettings: vi.fn(async () => ({
      settings: stored,
      spotify: { connected: false },
      startupSupported: true,
    })),
    saveSettings: vi.fn(async () => ({ rejected: [] as string[] })),
    connectSpotify: vi.fn(async () => ({ started: true })),
    listDisplays: vi.fn(async () => []),
    minimize: vi.fn(),
    hide: vi.fn(),
    show: vi.fn(),
    refresh: vi.fn(async () => ({ ok: true })),
    setStartup: vi.fn(async () => ({ enabled: true })),
    exportDiagnostics: vi.fn(async () => ({ path: 'diag.json' })),
    onPlayerState: vi.fn(() => vi.fn()),
    onSpotifyAuth: vi.fn(() => vi.fn()),
    importMedia: vi.fn(async () => null),
  };
}

async function renderApp(settings: Partial<StoredSettings> = {}) {
  const bridge = makeBridge(settings);
  window.lyricvision = bridge;
  const user = userEvent.setup();
  const utils = render(<App />);
  await waitFor(() => expect(bridge.getSettings).toHaveBeenCalled());
  await waitFor(() => expect(bridge.onPlayerState).toHaveBeenCalled());
  const push = bridge.onPlayerState.mock.calls[0][0] as PushFn;
  return { bridge, user, push, ...utils };
}

function settingsText(): string {
  const el = document.querySelector('#settings-state');
  return el?.textContent ?? '';
}

describe('settings load on boot', () => {
  it('populates all five controls from getSettings', async () => {
    await renderApp({
      spotifyClientId: 'cid-123',
      lcdFps: 15,
      syncOffsetMs: 250,
      serial: 'SER1',
      runAtStartup: true,
    });

    expect(screen.getByLabelText('Client ID')).toHaveValue('cid-123');
    expect(screen.getByLabelText(/USB serial/)).toHaveValue('SER1');
    expect(document.querySelector('#fps-value')?.textContent).toBe('15');
    expect(document.querySelector('#sync-offset-value')?.textContent).toBe(
      '250 ms'
    );
    expect(
      screen.getByRole('checkbox', { name: 'Start with Windows' })
    ).toBeChecked();
  });
});

describe('save settings', () => {
  it('sends exactly the five whitelisted keys (no layout, no tokens)', async () => {
    const { bridge, user } = await renderApp({
      spotifyClientId: 'cid-123',
      lcdFps: 15,
      syncOffsetMs: 250,
      serial: 'SER1',
      runAtStartup: false,
    });

    await user.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() => expect(bridge.saveSettings).toHaveBeenCalledTimes(1));
    const patch = bridge.saveSettings.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(Object.keys(patch).sort()).toEqual(
      ['lcdFps', 'runAtStartup', 'serial', 'spotifyClientId', 'syncOffsetMs'].sort()
    );
    expect(patch).toEqual({
      spotifyClientId: 'cid-123',
      lcdFps: 15,
      syncOffsetMs: 250,
      serial: 'SER1',
      runAtStartup: false,
    });
  });
});

describe('FPS slider', () => {
  it('is bounded 5–30 with step 1', async () => {
    const { user } = await renderApp();
    const thumb = screen.getByRole('slider', { name: 'Stream rate (FPS)' });

    expect(thumb.getAttribute('aria-valuemin')).toBe('5');
    expect(thumb.getAttribute('aria-valuemax')).toBe('30');

    // Single step moves exactly 1 FPS.
    thumb.focus();
    await user.keyboard('{ArrowRight}');
    expect(document.querySelector('#fps-value')?.textContent).toBe('11');

    // Floor: many steps down clamp at 5.
    for (let i = 0; i < 20; i += 1) await user.keyboard('{ArrowLeft}');
    expect(document.querySelector('#fps-value')?.textContent).toBe('5');
    await user.keyboard('{ArrowLeft}');
    expect(document.querySelector('#fps-value')?.textContent).toBe('5');

    // Ceiling: many steps up clamp at 30.
    for (let i = 0; i < 40; i += 1) await user.keyboard('{ArrowRight}');
    expect(document.querySelector('#fps-value')?.textContent).toBe('30');
    await user.keyboard('{ArrowRight}');
    expect(document.querySelector('#fps-value')?.textContent).toBe('30');
  });
});

describe('sync offset slider', () => {
  it('spans −2…2 s and is sent as rounded ms within ±2000', async () => {
    const { bridge, user } = await renderApp();
    const thumb = screen.getByRole('slider', {
      name: 'Lyric sync offset (seconds)',
    });

    expect(thumb.getAttribute('aria-valuemin')).toBe('-2');
    expect(thumb.getAttribute('aria-valuemax')).toBe('2');

    thumb.focus();
    await user.keyboard('{ArrowRight}');
    await user.keyboard('{ArrowRight}');
    await user.keyboard('{ArrowRight}');
    expect(document.querySelector('#sync-offset-value')?.textContent).toBe(
      '300 ms'
    );

    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(bridge.saveSettings).toHaveBeenCalled());
    const patch = bridge.saveSettings.mock.calls[0][0] as {
      syncOffsetMs: number;
    };
    expect(patch.syncOffsetMs).toBe(300);

    // Extremes never leave ±2000 ms (refocus: clicking Save moved it).
    // Bulk stepping via fireEvent: same keydown Radix listens to, without
    // user-event's per-keypress delays (120 presses would time the test out).
    thumb.focus();
    for (let i = 0; i < 40; i += 1)
      fireEvent.keyDown(thumb, { key: 'ArrowRight' });
    expect(document.querySelector('#sync-offset-value')?.textContent).toBe(
      '2000 ms'
    );
    for (let i = 0; i < 80; i += 1)
      fireEvent.keyDown(thumb, { key: 'ArrowLeft' });
    expect(document.querySelector('#sync-offset-value')?.textContent).toBe(
      '-2000 ms'
    );
  });
});

describe('startup toggle', () => {
  it('updates optimistically, then rolls back when setStartup rejects', async () => {
    const { bridge } = await renderApp({ runAtStartup: false });
    const box = screen.getByRole('checkbox', { name: 'Start with Windows' });
    expect(box).not.toBeChecked();

    bridge.setStartup.mockRejectedValueOnce(new Error('no shortcut'));
    fireEvent.click(box);

    // Optimistic: checked immediately, before the rejection lands.
    expect(box).toBeChecked();
    // Rollback once the rejection propagates.
    await waitFor(() => expect(box).not.toBeChecked());
    expect(settingsText()).toContain('Startup change failed: no shortcut');
  });

  it('keeps the new value and confirms when setStartup resolves', async () => {
    const { bridge } = await renderApp({ runAtStartup: false });
    const box = screen.getByRole('checkbox', { name: 'Start with Windows' });

    fireEvent.click(box);
    await waitFor(() =>
      expect(bridge.setStartup).toHaveBeenCalledWith(true)
    );
    await waitFor(() => expect(settingsText()).toBe('Will start with Windows.'));
    expect(box).toBeChecked();
  });
});

describe('listener lifecycle', () => {
  it('subscribes to both channels and unsubscribes both on unmount', async () => {
    const { bridge, unmount } = await renderApp();
    expect(bridge.onPlayerState).toHaveBeenCalledTimes(1);
    expect(bridge.onSpotifyAuth).toHaveBeenCalledTimes(1);

    const offPlayer = bridge.onPlayerState.mock.results[0].value as Mock;
    const offAuth = bridge.onSpotifyAuth.mock.results[0].value as Mock;

    unmount();
    expect(offPlayer).toHaveBeenCalledTimes(1);
    expect(offAuth).toHaveBeenCalledTimes(1);
  });
});

describe('status badge', () => {
  it.each([
    'ok',
    'degraded',
    'bridge-wedged',
    'panel-unknown',
    'auth-error',
    'offline',
  ])('maps lcdStatus %s onto the header badge', async (status) => {
    const { push } = await renderApp();
    act(() => {
      push({
        player: null,
        spotify: { connected: false },
        lcd: null,
        lcdStatus: { status },
        exclusivityWarn: '',
      });
    });
    const banner = screen.getByRole('banner');
    expect(within(banner).getByText(status)).toBeInTheDocument();
  });

  it('shows a starting badge before the first push', async () => {
    await renderApp();
    const banner = screen.getByRole('banner');
    expect(within(banner).getByText('starting')).toBeInTheDocument();
  });
});

describe('graceful empty states', () => {
  it('renders Idle hero and placeholders with no player, no lcd, no status', async () => {
    await renderApp();
    expect(screen.getByText('Idle')).toBeInTheDocument();
    expect(
      screen.getByText('Start playback on Spotify to see synced lyrics here.')
    ).toBeInTheDocument();
    expect(screen.getByText('LCD not streaming')).toBeInTheDocument();
  });

  it('tolerates a status object with missing optional fields', async () => {
    const { push } = await renderApp();
    act(() => {
      push({
        player: null,
        spotify: { connected: false },
        lcd: null,
        lcdStatus: { status: 'ok' },
        exclusivityWarn: '',
      });
    });
    const banner = screen.getByRole('banner');
    expect(within(banner).getByText('ok')).toBeInTheDocument();
    expect(screen.getByText('Idle')).toBeInTheDocument();
  });

  it('ignores nullish pushes without crashing', async () => {
    const { push } = await renderApp();
    act(() => {
      push(null as unknown as PlayerStatePush);
      push(undefined as unknown as PlayerStatePush);
    });
    expect(screen.getByText('Idle')).toBeInTheDocument();
  });

  it('reports a missing preload bridge instead of crashing', () => {
    const saved = window.lyricvision;
    delete window.lyricvision;
    try {
      render(<App />);
      expect(
        screen.getByText('Renderer bridge missing (preload failed).')
      ).toBeInTheDocument();
    } finally {
      window.lyricvision = saved;
    }
  });

  it('reports settings load failures instead of crashing', async () => {
    const bridge = makeBridge();
    bridge.getSettings.mockRejectedValueOnce(new Error('disk gone'));
    window.lyricvision = bridge;
    render(<App />);
    await waitFor(() =>
      expect(settingsText()).toBe('Could not load settings: disk gone')
    );
  });
});
