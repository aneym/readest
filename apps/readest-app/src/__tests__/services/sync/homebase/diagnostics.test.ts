import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/sync/homebase/config', () => ({
  getHomebaseBaseUrl: () => 'https://homebase.test/api/readest',
  isHomebaseSyncEnabled: () => true,
}));

import {
  DIAGNOSTICS_MAX_EVENTS,
  DIAGNOSTICS_STORAGE_KEY,
  flushDiagnostics,
  formatLocalClock,
  readDiagnosticEvents,
  recordDiagnostic,
  startDiagnosticsReporter,
} from '@/services/sync/homebase/diagnostics';

describe('diagnostics buffer', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('records events with a monotonic seq and local clock', () => {
    const first = recordDiagnostic('theme.transition', 'info', 'dark', { isDarkMode: true });
    const second = recordDiagnostic('sync.queued', 'warn', 'queued');
    expect(first!.seq).toBe(1);
    expect(second!.seq).toBe(2);
    expect(first!.local).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(readDiagnosticEvents().map((e) => e.kind)).toEqual(['theme.transition', 'sync.queued']);
  });

  it('drops the oldest events past the ring cap', () => {
    for (let i = 0; i < DIAGNOSTICS_MAX_EVENTS + 5; i++) recordDiagnostic('k', 'info', `m${i}`);
    const events = readDiagnosticEvents();
    expect(events.length).toBe(DIAGNOSTICS_MAX_EVENTS);
    expect(events[0]!.seq).toBe(6);
  });

  it('survives a corrupt buffer', () => {
    localStorage.setItem(DIAGNOSTICS_STORAGE_KEY, '{nope');
    expect(readDiagnosticEvents()).toEqual([]);
    expect(recordDiagnostic('k', 'info', 'm')).not.toBeNull();
  });

  it('formats the local clock with zero padding', () => {
    expect(formatLocalClock(new Date(2026, 0, 5, 7, 8, 9))).toBe('2026-01-05 07:08:09');
  });
});

describe('flushDiagnostics', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('posts pending events with the device token and trims only what was sent', async () => {
    recordDiagnostic('a', 'info', 'one');
    recordDiagnostic('b', 'warn', 'two');
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      // An event recorded mid-flight must survive the post-flush trim.
      recordDiagnostic('c', 'info', 'three');
      expect(String(input)).toBe('https://homebase.test/api/readest/reader/diagnostics');
      expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer tok');
      const body = JSON.parse(String(init?.body)) as {
        clientId: string;
        events: { kind: string }[];
      };
      expect(body.clientId).toBe('client-1');
      expect(body.events.map((e) => e.kind)).toEqual(['a', 'b']);
      return new Response('{"ok":true}', { status: 200 });
    });
    const sent = await flushDiagnostics({
      clientId: 'client-1',
      getToken: async () => 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(sent).toBe(2);
    expect(readDiagnosticEvents().map((e) => e.kind)).toEqual(['c']);
  });

  it('keeps the batch when unpaired, on a failed response, or on a network error', async () => {
    recordDiagnostic('a', 'error', 'one');
    expect(await flushDiagnostics({ clientId: 'c', getToken: async () => null })).toBe(0);
    const failing = vi.fn(async () => new Response('nope', { status: 500 }));
    expect(
      await flushDiagnostics({
        clientId: 'c',
        getToken: async () => 'tok',
        fetchImpl: failing as unknown as typeof fetch,
      }),
    ).toBe(0);
    const throwing = vi.fn(async () => {
      throw new Error('offline');
    });
    expect(
      await flushDiagnostics({
        clientId: 'c',
        getToken: async () => 'tok',
        fetchImpl: throwing as unknown as typeof fetch,
      }),
    ).toBe(0);
    expect(readDiagnosticEvents().length).toBe(1);
  });

  it('returns 0 with nothing pending and never calls fetch', async () => {
    const fetchImpl = vi.fn();
    expect(
      await flushDiagnostics({
        clientId: 'c',
        getToken: async () => 'tok',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('startDiagnosticsReporter', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it('flushes on start, on the interval, and shortly after a warning', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    recordDiagnostic('boot', 'info', 'start');
    const stop = startDiagnosticsReporter({
      clientId: 'c',
      getToken: async () => 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      intervalMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    recordDiagnostic('later', 'info', 'quiet');
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    recordDiagnostic('sync.queued', 'warn', 'loud');
    await vi.advanceTimersByTimeAsync(2100);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    stop();
    recordDiagnostic('after', 'warn', 'stopped');
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('captures unhandled errors into the buffer', () => {
    const stop = startDiagnosticsReporter({ clientId: 'c', getToken: async () => null });
    window.dispatchEvent(
      new ErrorEvent('error', { message: 'boom', filename: 'x.js', lineno: 1, colno: 2 }),
    );
    stop();
    const events = readDiagnosticEvents();
    expect(events.at(-1)).toMatchObject({
      kind: 'error.unhandled',
      level: 'error',
      message: 'boom',
    });
  });
});
