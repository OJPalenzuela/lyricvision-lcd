import { describe, expect, it } from 'vitest';

import {
  errMessage,
  exclusivityTextOf,
  formatOffsetMs,
  lcdStatusInlineText,
  spotifyStateText,
} from '@/lib/bridge';

describe('errMessage', () => {
  it('returns the message of an Error', () => {
    expect(errMessage(new Error('boom'))).toBe('boom');
  });

  it('falls back to String() for an Error with an empty message', () => {
    expect(errMessage(new Error(''))).toBe('Error');
  });

  it('stringifies non-Error values', () => {
    expect(errMessage('plain')).toBe('plain');
    expect(errMessage(42)).toBe('42');
    expect(errMessage(null)).toBe('null');
    expect(errMessage(undefined)).toBe('undefined');
  });
});

describe('formatOffsetMs', () => {
  it('formats whole seconds as ms', () => {
    expect(formatOffsetMs(0)).toBe('0 ms');
    expect(formatOffsetMs(1)).toBe('1000 ms');
    expect(formatOffsetMs(-1.5)).toBe('-1500 ms');
  });

  it('rounds fractional slider values to whole ms', () => {
    expect(formatOffsetMs(0.1)).toBe('100 ms');
    expect(formatOffsetMs(0.30000000000000004)).toBe('300 ms');
  });

  it('renders non-finite input as 0 ms instead of NaN', () => {
    expect(formatOffsetMs(NaN)).toBe('0 ms');
    expect(formatOffsetMs(Number('abc'))).toBe('0 ms');
  });
});

describe('spotifyStateText', () => {
  it('reports not connected when there is no session', () => {
    expect(spotifyStateText({ connected: false })).toBe('Not connected.');
  });

  it('reports an unknown expiry when none is provided', () => {
    expect(spotifyStateText({ connected: true })).toBe(
      'Connected (token expires unknown).'
    );
  });

  it('names the expiry time when one is provided', () => {
    const text = spotifyStateText({
      connected: true,
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
    expect(text.startsWith('Connected (token expires ')).toBe(true);
    expect(text.endsWith(').')).toBe(true);
  });
});

describe('lcdStatusInlineText', () => {
  it('renders a placeholder for a missing status', () => {
    expect(lcdStatusInlineText(null)).toBe('—');
  });

  it('renders a bare status without optional fields', () => {
    expect(lcdStatusInlineText({ status: 'ok' })).toBe('ok');
  });

  it('appends reason and restart count when present', () => {
    expect(lcdStatusInlineText({ status: 'ok', reason: 'streaming' })).toBe(
      'ok — streaming'
    );
    expect(
      lcdStatusInlineText({ status: 'degraded', reason: 'queue', restarts: 3 })
    ).toBe('degraded — queue (restarts: 3)');
  });

  it('omits a zero restart count', () => {
    expect(
      lcdStatusInlineText({ status: 'ok', reason: 'idle', restarts: 0 })
    ).toBe('ok — idle');
  });
});

describe('exclusivityTextOf', () => {
  it('falls back to the closed-holders text for empty warnings', () => {
    expect(exclusivityTextOf(undefined)).toBe(
      'No exclusive holder detected (TRCC/SignalRGB closed).'
    );
    expect(exclusivityTextOf('')).toBe(
      'No exclusive holder detected (TRCC/SignalRGB closed).'
    );
  });

  it('passes a real warning through untouched', () => {
    const warn = 'TRCC is running and holds the LCD exclusively';
    expect(exclusivityTextOf(warn)).toBe(warn);
  });
});
