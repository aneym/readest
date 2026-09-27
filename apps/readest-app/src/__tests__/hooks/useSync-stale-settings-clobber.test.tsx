import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { SystemSettings } from '@/types/settings';

/**
 * Issue #4780 — "WebDAV integration doesn't connect persistently".
 *
 * `useSync.pullChanges` re-reads the live store settings inside its `try`
 * (the `setSettings` path) but its `finally` historically persisted the
 * STALE hook-closure `settings` captured at the render that created the
 * pull. On a slow connection (Android) a settings change that lands while
 * a pull is in flight — most visibly a WebDAV connect, which is the only
 * integration NOT re-hydrated from the server replica on next launch — is
 * silently overwritten on disk when the pull completes, so the connection
 * looks "nullified" after the app is closed and reopened.
 *
 * This test drives the real hook: it captures a `pullChanges` while the
 * store holds the pre-connect settings (so its closure binds them), then
 * swaps in the post-connect settings (enabled WebDAV) to model the connect
 * landing mid-pull, and finally resolves the pull. The settings persisted
 * by the pull must reflect the live (connected) state, not the stale one.
 */

const h = vi.hoisted(() => {
  const baseSettings = (): SystemSettings =>
    ({
      version: 1,
      keepLogin: true,
      lastSyncedAtBooks: 0,
      lastSyncedAtConfigs: 0,
      lastSyncedAtNotes: 0,
      webdav: {
        enabled: false,
        serverUrl: '',
        username: '',
        password: '',
        rootPath: '/',
      },
    }) as unknown as SystemSettings;

  // The live store object. `settings` is reassigned (new ref) to model a
  // component calling setSettings with a fresh object, exactly like the
  // WebDAV connect handler does.
  const storeState = {
    settings: baseSettings(),
    setSettings: vi.fn((s: SystemSettings) => {
      storeState.settings = s;
    }),
    saveSettings: vi.fn(async (_env: unknown, _settings: SystemSettings) => {}),
  };

  const setConfig = vi.fn();
  return { baseSettings, storeState, setConfig };
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ envConfig: { id: 'env' } }),
}));

const syncClientMock = vi.hoisted(() => ({
  pullChanges: vi.fn(),
  pushChanges: vi.fn<() => Promise<{ books: null; configs: null; notes: null; queued?: boolean }>>(
    async () => ({ books: null, configs: null, notes: null }),
  ),
}));

vi.mock('@/context/SyncContext', () => ({
  useSyncContext: () => ({ syncClient: syncClientMock }),
}));

vi.mock('@/services/sync/syncCategories', () => ({
  isSyncCategoryEnabled: () => true,
}));

vi.mock('@/store/settingsStore', () => {
  const useSettingsStore = ((selector?: (s: typeof h.storeState) => unknown) =>
    selector ? selector(h.storeState) : h.storeState) as unknown as {
    (): typeof h.storeState;
    getState: () => typeof h.storeState;
  };
  useSettingsStore.getState = () => h.storeState;
  return { useSettingsStore };
});

vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: () => ({ getConfig: () => ({ location: 'page-1' }), setConfig: h.setConfig }),
}));

vi.mock('@/store/readerStore', () => ({
  useReaderStore: () => ({ setIsSyncing: vi.fn() }),
}));

vi.mock('@/utils/nav', () => ({ navigateToLogin: vi.fn() }));

vi.mock('@/utils/transform', () => ({
  transformBookFromDB: (x: unknown) => x,
  transformBookNoteFromDB: (x: unknown) => x,
  transformBookConfigFromDB: (x: unknown) => x,
}));

import { useSync } from '@/hooks/useSync';
import { useHomebaseSyncStatus } from '@/services/sync/homebase/syncStatus';
import { readDiagnosticEvents } from '@/services/sync/homebase/diagnostics';

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

beforeEach(() => {
  h.storeState.settings = h.baseSettings();
  h.storeState.setSettings.mockClear();
  h.storeState.saveSettings.mockClear();
  syncClientMock.pullChanges.mockReset();
  syncClientMock.pushChanges.mockReset();
  h.setConfig.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('Homebase book pull watermark', () => {
  test('applies returned pages but exposes an incomplete later-page discovery', async () => {
    syncClientMock.pullChanges.mockImplementation(async () => {
      if (syncClientMock.pullChanges.mock.calls.length > 1) throw new Error('network down');
      return {
        books: Array.from({ length: 1000 }, (_, i) => ({
          book_hash: String(i),
          synced_at: new Date(1000 + i).toISOString(),
        })),
        configs: null,
        notes: null,
      };
    });
    const { result } = renderHook(() => useSync());
    await act(flush);
    await act(async () => {
      await result.current.syncBooks(undefined, 'pull', 0);
    });
    expect(result.current.syncedBooks).toHaveLength(1000);
    expect(h.storeState.settings.lastSyncedAtBooks).toBe(1999);
    expect(result.current.syncError).toBe('library sync incomplete; will retry');
    expect(useHomebaseSyncStatus.getState().error).toBe('library sync incomplete; will retry');
    expect(readDiagnosticEvents().some((event) => event.kind === 'sync.partial')).toBe(true);
  });

  test('requests the stored watermark unchanged so strict > includes the next millisecond', async () => {
    const watermark = Date.now() - 1000 - 24 * 60 * 60 * 1000;
    h.storeState.settings = {
      ...h.baseSettings(),
      lastSyncedAtBooks: watermark + 24 * 60 * 60 * 1000,
    };
    syncClientMock.pullChanges.mockImplementation(async (since: number) => ({
      books:
        since < watermark + 1
          ? [{ book_hash: 'next', synced_at: new Date(watermark + 1).toISOString() }]
          : [],
      configs: null,
      notes: null,
    }));
    const { result } = renderHook(() => useSync());
    await act(flush);
    await act(async () => {
      await result.current.syncBooks(undefined, 'pull');
    });
    expect(syncClientMock.pullChanges).toHaveBeenCalledWith(
      watermark,
      'books',
      undefined,
      undefined,
      1000,
    );
    expect(result.current.syncResult.books).toMatchObject([{ book_hash: 'next' }]);
  });
});

describe('useSync push acknowledgement', () => {
  test('queued Homebase configs and notes do not advance their last pushed timestamps', async () => {
    syncClientMock.pushChanges.mockResolvedValue({
      books: null,
      configs: null,
      notes: null,
      queued: true,
    });
    const { result } = renderHook(() => useSync('book-key'));
    await act(async () => {
      await result.current.syncConfigs([{ bookHash: 'a' } as never], 'a', undefined, 'push');
      await result.current.syncNotes([{ bookHash: 'a' } as never], 'a', undefined, 'push');
    });
    expect(syncClientMock.pushChanges).toHaveBeenCalledTimes(2);
    expect(h.setConfig).not.toHaveBeenCalledWith(
      'book-key',
      expect.objectContaining({ lastPushedAtConfig: expect.any(Number) }),
    );
    expect(h.setConfig).not.toHaveBeenCalledWith(
      'book-key',
      expect.objectContaining({ lastPushedAtNotes: expect.any(Number) }),
    );
    syncClientMock.pushChanges.mockResolvedValue({ books: null, configs: null, notes: null });
    await act(async () => {
      await result.current.syncConfigs([{ bookHash: 'a' } as never], 'a', undefined, 'push');
      await result.current.syncNotes([{ bookHash: 'a' } as never], 'a', undefined, 'push');
    });
    expect(h.setConfig).toHaveBeenCalledWith(
      'book-key',
      expect.objectContaining({ lastPushedAtConfig: expect.any(Number) }),
    );
    expect(h.setConfig).toHaveBeenCalledWith(
      'book-key',
      expect.objectContaining({ lastPushedAtNotes: expect.any(Number) }),
    );
  });
});

describe('useSync pull persistence (issue #4780)', () => {
  test('does not clobber a WebDAV connect that lands during an in-flight pull', async () => {
    // A pull whose network round-trip we control by hand.
    let resolvePull: (value: unknown) => void = () => {};
    syncClientMock.pullChanges.mockImplementation(
      () =>
        new Promise((res) => {
          resolvePull = res;
        }),
    );

    const { result } = renderHook(() => useSync());

    // Capture the pull while the store still holds the pre-connect settings,
    // so its closure binds the disabled-WebDAV snapshot (the stale value).
    const pull = result.current.pullChanges;

    let pullDone!: Promise<unknown>;
    await act(async () => {
      pullDone = pull('books', 0, vi.fn(), vi.fn());
      await flush();
    });

    // The user connects WebDAV mid-pull: a fresh settings object with the
    // connection enabled replaces the live store value.
    const connected = h.baseSettings();
    connected.webdav = {
      enabled: true,
      serverUrl: 'https://dav.example.com',
      username: 'alice',
      password: 'secret',
      rootPath: '/',
    } as SystemSettings['webdav'];
    h.storeState.settings = connected;

    // The network completes and the pull finalises.
    await act(async () => {
      resolvePull({ books: [] });
      await pullDone;
      await flush();
    });

    expect(h.storeState.saveSettings).toHaveBeenCalled();
    const lastSaved = h.storeState.saveSettings.mock.calls.at(-1)![1];
    // The pull must persist the live (connected) settings, never the stale
    // pre-connect snapshot — otherwise the WebDAV connection is wiped on disk
    // and reads back as "Not connected" after a restart.
    expect(lastSaved.webdav.enabled).toBe(true);
  });
});
