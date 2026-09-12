import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { useTransferStore } from '@/store/transferStore';
import { useSettingsStore } from '@/store/settingsStore';
import type { Book } from '@/types/book';

vi.mock('@/utils/event', () => ({ eventDispatcher: { dispatch: vi.fn() } }));

import { transferManager, OFFLINE_HOLD_MESSAGE } from '@/services/transferManager';
import { BOOK_INTEGRITY_ERROR_PREFIX } from '@/services/bookIntegrity';

const makeBook = (overrides: Partial<Book> = {}): Book => ({
  hash: 'hash1',
  format: 'EPUB',
  title: 'Trip Book',
  author: 'Author',
  createdAt: 1000,
  updatedAt: 2000,
  uploadedAt: 3000,
  ...overrides,
});

const resetManager = () => {
  const mgr = transferManager as unknown as Record<string, unknown>;
  mgr['isInitialized'] = false;
  mgr['isProcessing'] = false;
  mgr['appService'] = null;
  mgr['getLibrary'] = null;
  mgr['updateBook'] = null;
  mgr['_'] = null;
  mgr['lastRevivalAt'] = 0;
  (mgr['abortControllers'] as Map<string, AbortController>).clear();
  let resolveReady: () => void = () => {};
  mgr['readyPromise'] = new Promise<void>((res) => {
    resolveReady = res;
  });
  mgr['readyResolve'] = resolveReady;
};

const setOnline = (online: boolean) => {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
};

const translationFn = (key: string) => key;

beforeEach(() => {
  vi.useFakeTimers();
  resetManager();
  vi.clearAllMocks();
  localStorage.clear();
  useTransferStore.setState({
    transfers: {},
    isQueuePaused: false,
    isTransferQueueOpen: false,
    maxConcurrent: 2,
    activeCount: 0,
  });
  useSettingsStore.setState({ settings: { version: 1 } as never });
  setOnline(true);
});

afterEach(() => {
  vi.useRealTimers();
  setOnline(true);
});

describe('transfer retry scheduling', () => {
  test('a failing download honours exponential backoff instead of burning retries in 100ms loops', async () => {
    const download = vi.fn(async () => {
      throw new Error('server hiccup');
    });
    const book = makeBook();
    await transferManager.initialize(
      { downloadBook: download } as never,
      () => [book],
      async () => {},
      translationFn,
    );
    const id = transferManager.queueDownload(book)!;

    await vi.advanceTimersByTimeAsync(500);
    expect(download).toHaveBeenCalledTimes(1);
    const afterFirst = useTransferStore.getState().transfers[id]!;
    expect(afterFirst.status).toBe('pending');
    expect(afterFirst.retryCount).toBe(1);
    expect(afterFirst.nextAttemptAt).toBeGreaterThan(Date.now());

    await vi.advanceTimersByTimeAsync(1400);
    expect(download).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(700);
    expect(download).toHaveBeenCalledTimes(2);
  });

  test('a persisted nextAttemptAt survives restart and is not run early', async () => {
    const download = vi.fn(async (book: Book) => {
      book.downloadedAt = Date.now();
    });
    const book = makeBook();
    const store = useTransferStore.getState();
    const id = store.addTransfer(book.hash, book.title, 'download');
    store.setNextAttemptAt(id, Date.now() + 60_000);
    localStorage.setItem(
      'readest_transfer_queue',
      JSON.stringify({
        schemaVersion: 1,
        transfers: useTransferStore.getState().transfers,
        isQueuePaused: false,
      }),
    );
    useTransferStore.setState({ transfers: {} });

    await transferManager.initialize(
      { downloadBook: download } as never,
      () => [book],
      async () => {},
      translationFn,
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(download).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(download).toHaveBeenCalledTimes(1);
    expect(useTransferStore.getState().transfers[id]?.status).toBe('completed');
  });
});

describe('offline hold and reconnect revival', () => {
  test('offline failures are held without spending retries, and `online` releases them', async () => {
    setOnline(false);
    let attempts = 0;
    const download = vi.fn(async (book: Book) => {
      attempts++;
      if (!navigator.onLine) throw new Error('offline');
      book.downloadedAt = Date.now();
    });
    const book = makeBook();
    await transferManager.initialize(
      { downloadBook: download } as never,
      () => [book],
      async () => {},
      translationFn,
    );
    const id = transferManager.queueDownload(book)!;

    await vi.advanceTimersByTimeAsync(5_000);
    expect(attempts).toBe(1);
    const held = useTransferStore.getState().transfers[id]!;
    expect(held.status).toBe('pending');
    expect(held.retryCount).toBe(0);
    expect(held.error).toBe(OFFLINE_HOLD_MESSAGE);

    setOnline(true);
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempts).toBe(2);
    expect(useTransferStore.getState().transfers[id]?.status).toBe('completed');
  });

  test('retries exhausted while flaky are revived on reconnect with a fresh budget', async () => {
    let healthy = false;
    const download = vi.fn(async (book: Book) => {
      if (!healthy) throw new Error('connection reset');
      book.downloadedAt = Date.now();
    });
    const book = makeBook();
    await transferManager.initialize(
      { downloadBook: download } as never,
      () => [book],
      async () => {},
      translationFn,
    );
    const id = transferManager.queueDownload(book)!;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(useTransferStore.getState().transfers[id]?.status).toBe('failed');
    expect(download).toHaveBeenCalledTimes(4);

    healthy = true;
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(download).toHaveBeenCalledTimes(5);
    expect(useTransferStore.getState().transfers[id]?.status).toBe('completed');
  });

  test('an integrity failure is not retried and does not block a healthy book', async () => {
    const poison = makeBook({ hash: 'poison', title: 'Not a zip' });
    const good = makeBook({ hash: 'good', title: 'Good book' });
    const download = vi.fn(async (book: Book) => {
      if (book.hash === 'poison') {
        throw new Error(
          `${BOOK_INTEGRITY_ERROR_PREFIX}: missing zip local file header (Not a zip)`,
        );
      }
      book.downloadedAt = Date.now();
    });
    await transferManager.initialize(
      { downloadBook: download } as never,
      () => [poison, good],
      async () => {},
      translationFn,
    );
    const poisonId = transferManager.queueDownload(poison)!;
    const goodId = transferManager.queueDownload(good)!;
    await vi.advanceTimersByTimeAsync(2_000);

    const transfers = useTransferStore.getState().transfers;
    expect(transfers[poisonId]?.status).toBe('failed');
    expect(transfers[poisonId]?.retryCount).toBe(0);
    expect(transfers[goodId]?.status).toBe('completed');

    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(useTransferStore.getState().transfers[poisonId]?.status).toBe('failed');
    expect(download.mock.calls.filter(([b]) => (b as Book).hash === 'poison')).toHaveLength(1);
  });

  test('a download that resolves without a verified file is a failure, not a completed transfer', async () => {
    const download = vi.fn(async () => {});
    const book = makeBook();
    await transferManager.initialize(
      { downloadBook: download } as never,
      () => [book],
      async () => {},
      translationFn,
    );
    const id = transferManager.queueDownload(book)!;
    await vi.advanceTimersByTimeAsync(500);
    const t = useTransferStore.getState().transfers[id]!;
    expect(t.status).toBe('pending');
    expect(t.error).toMatch(/Retry 1\/3/);
    expect(book.downloadedAt).toBeUndefined();
  });
});
