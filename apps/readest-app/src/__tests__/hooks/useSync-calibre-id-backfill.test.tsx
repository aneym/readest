import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';

// Books already on a device only gain calibre_id on a full books pull: the
// books cursor is the file mtime, so an incremental pull never re-returns them.
// useSync runs one since=0 library pull after the upgrade, and only a pull
// chain that completes stamps settings.homebaseCalibreIdBackfill.

const h = vi.hoisted(() => {
  const settings: Record<string, unknown> = {};
  return {
    settings,
    setSettings: vi.fn(),
    saveSettings: vi.fn(),
    pull: vi.fn(),
    homebaseEnabled: true,
  };
});
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/context/EnvContext', () => ({ useEnv: () => ({ envConfig: {} }) }));
vi.mock('@/context/SyncContext', () => ({
  useSyncContext: () => ({ syncClient: { pullChanges: h.pull } }),
}));
vi.mock('@/services/sync/syncCategories', () => ({ isSyncCategoryEnabled: () => true }));
vi.mock('@/services/sync/homebase/config', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isHomebaseSyncEnabled: () => h.homebaseEnabled,
}));
vi.mock('@/store/settingsStore', () => {
  const store = { settings: h.settings, setSettings: h.setSettings, saveSettings: h.saveSettings };
  const useSettingsStore = Object.assign(() => store, { getState: () => store });
  return { useSettingsStore };
});
vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: () => ({ getConfig: () => null, setConfig: vi.fn() }),
}));
vi.mock('@/store/readerStore', () => ({ useReaderStore: () => ({ setIsSyncing: vi.fn() }) }));
vi.mock('@/utils/nav', () => ({ navigateToLogin: vi.fn() }));

import { BOOKS_PULL_PAGE_SIZE, useSync } from '@/hooks/useSync';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();
const bookRow = (i: number, syncedAt: number) => ({
  book_hash: `h${i}`,
  hash: `h${i}`,
  title: `Book ${i}`,
  format: 'EPUB',
  author: 'A',
  created_at: iso(syncedAt),
  updated_at: iso(syncedAt),
  synced_at: iso(syncedAt),
});

const sinceOfFirstPull = () => h.pull.mock.calls[0]![0] as number;

const runLibraryPull = async (pulls = 1) => {
  const { result, unmount } = renderHook(() => useSync());
  await waitFor(() => expect(result.current.useSyncInited).toBe(true));
  for (let i = 0; i < pulls; i++) {
    await act(async () => {
      await result.current.syncBooks(undefined, 'pull');
    });
  }
  unmount();
};

let recentCursor = 0;
beforeEach(() => {
  for (const key of Object.keys(h.settings)) delete h.settings[key];
  recentCursor = Date.now() - HOUR;
  Object.assign(h.settings, { version: 1, lastSyncedAtBooks: recentCursor });
  h.setSettings.mockClear();
  h.saveSettings.mockClear();
  h.pull.mockReset();
  h.homebaseEnabled = true;
});
afterEach(() => cleanup());

describe('one-time calibre_id books backfill', () => {
  test('pulls from 0 once despite a recent cursor, then resumes incrementally', async () => {
    h.pull.mockResolvedValue({ books: [bookRow(1, recentCursor - DAY)] });
    await runLibraryPull();
    expect(sinceOfFirstPull()).toBe(0);
    expect(h.settings['homebaseCalibreIdBackfill']).toBe(1);

    h.pull.mockReset();
    h.pull.mockResolvedValue({ books: [] });
    await runLibraryPull();
    expect(sinceOfFirstPull()).toBeGreaterThan(0);
  });

  test('a partial backfill pull leaves the flag unset, so the next launch retries from 0', async () => {
    const fullPage = Array.from({ length: BOOKS_PULL_PAGE_SIZE }, (_, i) =>
      bookRow(i, recentCursor - HOUR + i),
    );
    h.pull
      .mockResolvedValueOnce({ books: fullPage })
      .mockRejectedValueOnce(new Error('network down'));
    await runLibraryPull();
    expect(sinceOfFirstPull()).toBe(0);
    expect(h.settings['homebaseCalibreIdBackfill']).toBeUndefined();

    h.pull.mockReset();
    h.pull.mockResolvedValue({ books: [bookRow(1, recentCursor - DAY)] });
    await runLibraryPull();
    expect(sinceOfFirstPull()).toBe(0);
    expect(h.settings['homebaseCalibreIdBackfill']).toBe(1);
  });

  test('a partial backfill that completes from its cursor in the same session stamps the flag', async () => {
    const fullPage = Array.from({ length: BOOKS_PULL_PAGE_SIZE }, (_, i) =>
      bookRow(i, recentCursor - HOUR + i),
    );
    h.pull
      .mockResolvedValueOnce({ books: fullPage })
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue({ books: [] });
    await runLibraryPull(2);
    expect(h.pull.mock.calls.map((call) => call[0])).toEqual([
      0,
      recentCursor - HOUR + BOOKS_PULL_PAGE_SIZE - 1,
      recentCursor - HOUR + BOOKS_PULL_PAGE_SIZE - 1,
    ]);
    expect(h.settings['homebaseCalibreIdBackfill']).toBe(1);
  });

  test('stock Readest sync neither forces the full pull nor stamps the flag', async () => {
    h.homebaseEnabled = false;
    h.pull.mockResolvedValue({ books: [] });
    await runLibraryPull();
    expect(sinceOfFirstPull()).toBeGreaterThan(0);

    // A stock full pull from 0 (stale cursor) is not the Homebase backfill.
    h.settings['lastSyncedAtBooks'] = 0;
    h.pull.mockReset();
    h.pull.mockResolvedValue({ books: [bookRow(1, recentCursor - DAY)] });
    await runLibraryPull();
    expect(sinceOfFirstPull()).toBe(0);
    expect(h.settings['homebaseCalibreIdBackfill']).toBeUndefined();
  });
});
