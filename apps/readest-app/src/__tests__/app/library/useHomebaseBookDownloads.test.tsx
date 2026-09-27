import { beforeEach, afterEach, describe, test, expect, vi } from 'vitest';
import { renderHook, cleanup, act } from '@testing-library/react';

const queueDownload = vi.hoisted(() => vi.fn((..._args: unknown[]) => 'id'));
const user = vi.hoisted(() => ({ value: { id: 'paired' } as { id: string } | null }));
const homebase = vi.hoisted(() => ({ enabled: true }));
const immersionStatus = vi.hoisted(() => vi.fn(async () => ({})));
const loadBook = vi.hoisted(() => vi.fn());
const overlays = vi.hoisted(() => vi.fn(() => false));
const saveLibraryBooks = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/services/homebase/immersion/client', () => ({
  createImmersionClient: () => ({ status: immersionStatus }),
}));
vi.mock('@/libs/document', () => ({
  DocumentLoader: class {
    constructor(_file: File) {}
    open() {
      return loadBook();
    }
  },
}));
vi.mock('@/services/tts/mediaOverlay', () => ({ hasMediaOverlays: overlays }));
vi.mock('@/services/transferManager', () => ({
  transferManager: { queueDownload, waitUntilReady: () => Promise.resolve() },
}));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ user: user.value }) }));
vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({
    envConfig: { getAppService: async () => ({ saveLibraryBooks }) },
    appService: { loadBookContent: async () => ({ file: new File(['epub'], 'narrated.epub') }) },
  }),
}));
vi.mock('@/services/sync/homebase/config', () => ({
  isHomebaseSyncEnabled: () => homebase.enabled,
}));
vi.mock('@/services/sync/cloudSyncProvider', () => ({ isReadestCloudEnabled: () => true }));

import {
  useHomebaseBookDownloads,
  isDesiredHomebaseDownload,
} from '@/app/library/hooks/useHomebaseBookDownloads';
import { useLibraryStore } from '@/store/libraryStore';
import { useImmersionStore } from '@/store/immersionStore';
import { useTransferStore } from '@/store/transferStore';
import { useSettingsStore } from '@/store/settingsStore';
import { BOOK_INTEGRITY_ERROR_PREFIX } from '@/services/bookIntegrity';
import type { Book } from '@/types/book';

const row = (overrides: Partial<Book> = {}): Book => ({
  hash: 'h1',
  format: 'EPUB',
  title: 'Canonical',
  author: 'aneym',
  createdAt: 1000,
  updatedAt: 2000,
  uploadedAt: 2000,
  ...overrides,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  user.value = { id: 'paired' };
  homebase.enabled = true;
  useSettingsStore.setState({ settings: { version: 1 } as never });
  useTransferStore.setState({
    transfers: {},
    isQueuePaused: false,
    maxConcurrent: 2,
    activeCount: 0,
  });
  useLibraryStore.setState({ library: [], libraryLoaded: true, isSyncing: false });
  useImmersionStore.getState().setPairs({});
  immersionStatus.mockResolvedValue({});
  loadBook.mockResolvedValue({ book: {} });
  overlays.mockReturnValue(false);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const settle = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
};

describe('isDesiredHomebaseDownload', () => {
  test('wants served, undeleted, undownloaded file books only', () => {
    expect(isDesiredHomebaseDownload(row())).toBe(true);
    expect(isDesiredHomebaseDownload(row({ downloadedAt: 5 }))).toBe(false);
    expect(isDesiredHomebaseDownload(row({ deletedAt: 5 }))).toBe(false);
    expect(isDesiredHomebaseDownload(row({ uploadedAt: null }))).toBe(false);
    expect(isDesiredHomebaseDownload(row({ format: 'ABS' }))).toBe(false);
    expect(isDesiredHomebaseDownload(row({ url: 'feed://x' }))).toBe(false);
  });
});

describe('useHomebaseBookDownloads', () => {
  test('polls pair status and updates the shelf on its 60-second cadence', async () => {
    immersionStatus.mockResolvedValue({ h1: { state: 'candidate', pairId: 'pair-1' } });
    renderHook(() => useHomebaseBookDownloads());
    await act(async () => {
      await Promise.resolve();
    });
    expect(useImmersionStore.getState().pairByHash['h1']?.state).toBe('candidate');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(immersionStatus).toHaveBeenCalledTimes(2);
  });

  test('completed EPUB download persists narration once, including a negative result', async () => {
    const downloaded = row({ downloadedAt: 42 });
    useLibraryStore.getState().setLibrary([downloaded]);
    overlays.mockReturnValue(true);
    const transfer = useTransferStore.getState().addTransfer('h1', 'Canonical', 'download');
    useTransferStore.getState().setTransferStatus(transfer, 'completed');
    renderHook(() => useHomebaseBookDownloads());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(useLibraryStore.getState().getBookByHash('h1')?.hasNarration).toBe(true);
    expect(saveLibraryBooks).toHaveBeenCalled();
    expect(loadBook).toHaveBeenCalledTimes(1);
  });
  test('failed narration parse leaves completed download intact and skips reparse this session', async () => {
    const downloaded = row({ downloadedAt: 42 });
    useLibraryStore.getState().setLibrary([downloaded]);
    loadBook.mockRejectedValue(new Error('cannot parse'));
    const transfer = useTransferStore.getState().addTransfer('h1', 'Canonical', 'download');
    useTransferStore.getState().setTransferStatus(transfer, 'completed');
    renderHook(() => useHomebaseBookDownloads());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(useLibraryStore.getState().getBookByHash('h1')?.downloadedAt).toBe(42);
    expect(useLibraryStore.getState().getBookByHash('h1')?.hasNarration).toBeUndefined();
    useTransferStore.getState().updateTransferProgress(transfer, 99, 100, 100, 0);
    await act(async () => {
      await Promise.resolve();
    });
    expect(loadBook).toHaveBeenCalledTimes(1);
  });

  test('queues every adopted book that has no bytes, newest adoption first', async () => {
    useLibraryStore.setState({
      library: [
        row({ hash: 'old', syncedAt: 10 }),
        row({ hash: 'new', syncedAt: 20 }),
        row({ hash: 'have', downloadedAt: 1 }),
      ],
    });
    renderHook(() => useHomebaseBookDownloads());
    await settle();
    expect(queueDownload.mock.calls.map(([b]) => (b as Book).hash)).toEqual(['new', 'old']);
  });

  test('re-reconciles when the library changes (adoption) and on reconnect/foreground', async () => {
    renderHook(() => useHomebaseBookDownloads());
    await settle();
    expect(queueDownload).not.toHaveBeenCalled();
    act(() => useLibraryStore.setState({ library: [row({ hash: 'adopted' })] }));
    await settle();
    expect(queueDownload).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('online'));
    await settle();
    expect(queueDownload).toHaveBeenCalledTimes(2);
  });

  test('skips books already pending, user-cancelled, or failed on integrity', async () => {
    const store = useTransferStore.getState();
    const pending = store.addTransfer('p', 'p', 'download');
    const poison = store.addTransfer('x', 'x', 'download');
    store.setTransferStatus(poison, 'failed', `${BOOK_INTEGRITY_ERROR_PREFIX}: not a zip`);
    const cancelled = store.addTransfer('c', 'c', 'download');
    store.setTransferStatus(cancelled, 'cancelled', undefined, 'user');
    const transient = store.addTransfer('t', 't', 'download');
    store.setTransferStatus(transient, 'failed', 'offline');
    void pending;
    useLibraryStore.setState({ library: ['p', 'x', 'c', 't'].map((hash) => row({ hash })) });
    renderHook(() => useHomebaseBookDownloads());
    await settle();
    // 't' is re-offered (the manager dedupes/revives); 'p', 'x', 'c' are not.
    expect(queueDownload.mock.calls.map(([b]) => (b as Book).hash)).toEqual(['t']);
  });

  test('does nothing without a paired user or without Homebase configured', async () => {
    useLibraryStore.setState({ library: [row()] });
    user.value = null;
    renderHook(() => useHomebaseBookDownloads());
    await settle();
    expect(queueDownload).not.toHaveBeenCalled();
    cleanup();
    user.value = { id: 'paired' };
    homebase.enabled = false;
    renderHook(() => useHomebaseBookDownloads());
    await settle();
    expect(queueDownload).not.toHaveBeenCalled();
  });
});
