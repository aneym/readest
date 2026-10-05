import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { cleanup, renderHook } from '@testing-library/react';
import type { Book } from '@/types/book';

// Integration: real reconciliation, transfer/reader stores, HTTP download and disk.
// Contexts supply the paired device; only the HTTP edge returns the missing file.
const context = vi.hoisted(() => ({ service: null as unknown }));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ user: { id: 'paired' } }) }));
vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ appService: context.service, envConfig: {} }),
}));
const book: Book = {
  hash: '4c58263345999aa6580dcd52005f97eb',
  title: 'Stale shelf book',
  author: 'Fixture',
  format: 'EPUB',
  createdAt: 1,
  updatedAt: 2,
  uploadedAt: 3,
};
let root: string;
let toasts: unknown[];
let owners: Awaited<ReturnType<typeof setup>>;
const onToast = (event: CustomEvent) => {
  toasts.push(event.detail);
};
async function setup() {
  const { NodeAppService } = await import('@/services/nodeAppService');
  const { useLibraryStore } = await import('@/store/libraryStore');
  const { useSettingsStore } = await import('@/store/settingsStore');
  const { useTransferStore } = await import('@/store/transferStore');
  const { useReaderStore } = await import('@/store/readerStore');
  const { transferManager } = await import('@/services/transferManager');
  const { eventDispatcher } = await import('@/utils/event');
  const { useBookTransferActions } = await import('@/app/library/hooks/useBookTransferActions');
  const { useHomebaseBookDownloads } = await import('@/app/library/hooks/useHomebaseBookDownloads');
  const service = new NodeAppService(root);
  await service.init();
  await service.createDir('', 'Books', true);
  context.service = service;
  useSettingsStore.getState().setSettings(await service.loadSettings());
  useLibraryStore.getState().setLibrary([{ ...book }]);
  useTransferStore.setState({
    transfers: {},
    isQueuePaused: false,
    activeCount: 0,
    maxConcurrent: 2,
  });
  eventDispatcher.on('toast', onToast);
  await transferManager.initialize(
    service,
    () => useLibraryStore.getState().library,
    async (row) =>
      useLibraryStore.getState().updateBook({ getAppService: async () => service }, row),
    (key) => key,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  return {
    service,
    useLibraryStore,
    useTransferStore,
    useReaderStore,
    transferManager,
    eventDispatcher,
    useHomebaseBookDownloads,
    useBookTransferActions,
  };
}
beforeAll(async () => {
  localStorage.clear();
  root = await mkdtemp(`${tmpdir()}/notification-download-`);
  toasts = [];
  vi.stubEnv('NEXT_PUBLIC_APP_PLATFORM', 'web');
  window.__READEST_RUNTIME_CONFIG = {
    homebaseApiBaseUrl: 'https://household.test',
    homebaseSyncEnabled: true,
  };
  vi.stubGlobal(
    'fetch',
    async () => new Response(JSON.stringify({ error: 'Book file not found' }), { status: 404 }),
  );
  owners = await setup();
});
let scenario = 0;
beforeEach(() => {
  book.hash = `notification-book-${++scenario}`;
  owners.useLibraryStore.getState().setLibrary([{ ...book }]);
  toasts = [];
  owners.useTransferStore.setState({ transfers: {}, isQueuePaused: false, activeCount: 0 });
});
afterEach(async () => {
  cleanup();
  owners.transferManager.pauseQueue();
  owners.transferManager.clearAll();
});
afterAll(async () => {
  owners.eventDispatcher.off('toast', onToast);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete window.__READEST_RUNTIME_CONFIG;
  await rm(root, { recursive: true, force: true });
});

test('automatic reconciliation 404 stays quiet and records refresh-needed state', async () => {
  renderHook(() => owners.useHomebaseBookDownloads());
  await vi.waitFor(
    () => expect(owners.useTransferStore.getState().getFailedTransfers()).toHaveLength(1),
    { timeout: 4000 },
  );
  expect(owners.useTransferStore.getState().getFailedTransfers()[0]?.error).toContain(
    'Refresh the library',
  );
  expect(toasts).toEqual([]);
});

test('reader-initiated missing download reports exactly one failure toast', async () => {
  await expect(
    owners.useReaderStore
      .getState()
      .initViewState({ getAppService: async () => owners.service }, book.hash, `${book.hash}-open`),
  ).rejects.toThrow('Homebase book download failed (404');
  expect(toasts).toEqual([
    expect.objectContaining({
      type: 'error',
      message: expect.stringContaining('Refresh the library'),
    }),
  ]);
});

test('two concurrent user transfers for one hash report only one failure', async () => {
  await owners.service.createDir(book.hash, 'Books', true);
  owners.transferManager.pauseQueue();
  const first = owners.transferManager.queueDownload(book, 1);
  const second = owners.transferManager.queueDownload(book, 1);
  expect(first).toBe(second);
  owners.transferManager.resumeQueue();
  await vi.waitFor(() =>
    expect(owners.useTransferStore.getState().getFailedTransfers()).toHaveLength(1),
  );
  expect(toasts).toEqual([
    expect.objectContaining({
      type: 'error',
      message: expect.stringContaining('Refresh the library'),
    }),
  ]);
});

test('each sequential Download tap and subsequent reader open reports its own failure', async () => {
  renderHook(() => owners.useHomebaseBookDownloads());
  await vi.waitFor(
    () => expect(owners.useTransferStore.getState().getFailedTransfers()).toHaveLength(1),
    { timeout: 4000 },
  );
  expect(toasts).toEqual([]);
  const { result } = renderHook(() =>
    owners.useBookTransferActions(
      { getAppService: async () => owners.service },
      owners.service,
      owners.useLibraryStore.getState().updateBook,
      () => {},
    ),
  );
  expect(await result.current.handleBookDownload(book, { queued: true })).toBe(false);
  expect(await result.current.handleBookDownload(book, { queued: true })).toBe(false);
  expect(toasts).toHaveLength(2);
  await expect(
    owners.useReaderStore
      .getState()
      .initViewState(
        { getAppService: async () => owners.service },
        book.hash,
        `${book.hash}-again`,
      ),
  ).rejects.toThrow('Homebase book download failed (404');
  expect(toasts).toHaveLength(3);
  expect(toasts).toEqual(
    Array.from({ length: 3 }, () =>
      expect.objectContaining({
        type: 'error',
        message: expect.stringContaining('Refresh the library'),
      }),
    ),
  );

  // Explicit queue retries are new user attempts, even for a background row.
  const failed = owners.useTransferStore.getState().getFailedTransfers()[0]!;
  owners.transferManager.retryTransfer(failed.id);
  await vi.waitFor(() => expect(toasts).toHaveLength(4));
  await vi.waitFor(() =>
    expect(owners.useTransferStore.getState().transfers[failed.id]?.status).toBe('failed'),
  );
  owners.transferManager.retryAllFailed();
  await vi.waitFor(() => expect(toasts).toHaveLength(5));
  await vi.waitFor(() =>
    expect(owners.useTransferStore.getState().transfers[failed.id]?.status).toBe('failed'),
  );

  // A different error on the same book must not inherit the missing-file suppression.
  vi.stubGlobal(
    'fetch',
    async () => new Response(JSON.stringify({ error: 'Not paired' }), { status: 403 }),
  );
  try {
    await expect(
      owners.useReaderStore
        .getState()
        .initViewState(
          { getAppService: async () => owners.service },
          book.hash,
          `${book.hash}-403`,
        ),
    ).rejects.toThrow('Homebase book download failed (403');
    expect(toasts).toHaveLength(6);
    expect(toasts[5]).toEqual(
      expect.objectContaining({
        type: 'error',
        message: expect.stringContaining('Pair this device'),
      }),
    );
  } finally {
    vi.stubGlobal(
      'fetch',
      async () => new Response(JSON.stringify({ error: 'Book file not found' }), { status: 404 }),
    );
  }
});

test.each([
  'queue',
  'Download tap',
  'reader open',
])('%s joining a revived background download reports a new failure', async (action) => {
  // Reach terminal 503s without waiting through automatic retry backoff.
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 503 }));
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + scenario * 10_000);
  const { result } = renderHook(() =>
    owners.useBookTransferActions(
      { getAppService: async () => owners.service },
      owners.service,
      owners.useLibraryStore.getState().updateBook,
      () => {},
    ),
  );
  let release = () => {};
  try {
    owners.transferManager.pauseQueue();
    const id = owners.transferManager.queueDownload(book, 1)!;
    owners.useTransferStore.setState((state) => ({
      transfers: { ...state.transfers, [id]: { ...state.transfers[id]!, maxRetries: 0 } },
    }));
    owners.transferManager.resumeQueue();
    await vi.waitFor(() =>
      expect(owners.useTransferStore.getState().transfers[id]?.status).toBe('failed'),
    );
    expect(toasts).toHaveLength(1);

    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requests = 0;
    vi.stubGlobal('fetch', async (url: string) => {
      if (!url.includes(`fileKey=${book.hash}.epub`)) return new Response('{}', { status: 404 });
      requests++;
      await gate;
      return new Response('{}', { status: 503 });
    });
    expect(owners.transferManager.reviveTransientFailures('foreground')).toBe(1);
    await vi.waitFor(() => expect(requests).toBe(1));
    expect(owners.useTransferStore.getState().transfers[id]?.isBackground).toBe(true);
    // Revival replenishes the retry budget; keep this scenario at the final failure.
    owners.useTransferStore.setState((state) => ({
      transfers: { ...state.transfers, [id]: { ...state.transfers[id]!, maxRetries: 0 } },
    }));
    let opened: Promise<void> | undefined;
    if (action === 'reader open') {
      opened = expect(
        owners.useReaderStore
          .getState()
          .initViewState(
            { getAppService: async () => owners.service },
            book.hash,
            `${book.hash}-revived`,
          ),
      ).rejects.toThrow('Homebase book download failed (503');
    } else if (action === 'Download tap') {
      expect(await result.current.handleBookDownload(book, { queued: true })).toBe(true);
    } else {
      expect(owners.transferManager.queueDownload(book, 1)).toBe(id);
    }
    await vi.waitFor(() =>
      expect(owners.useTransferStore.getState().transfers[id]?.isBackground).toBe(false),
    );
    release();
    await opened;
    await vi.waitFor(() =>
      expect(owners.useTransferStore.getState().transfers[id]?.status).toBe('failed'),
    );
    expect(requests).toBe(1);
    expect(
      toasts.filter(
        (toast) =>
          toast !== null && typeof toast === 'object' && 'type' in toast && toast.type === 'error',
      ),
    ).toHaveLength(2);
  } finally {
    release();
    clock.mockRestore();
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 404 }));
  }
});
