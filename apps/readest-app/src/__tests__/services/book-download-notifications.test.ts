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
  const store = owners.useTransferStore.getState();
  store.addTransfer(book.hash, book.title, 'download');
  await new Promise((resolve) => setTimeout(resolve, 2));
  store.addTransfer(book.hash, book.title, 'download');
  owners.transferManager.resumeQueue();
  await vi.waitFor(() =>
    expect(owners.useTransferStore.getState().getFailedTransfers()).toHaveLength(2),
  );
  expect(toasts).toEqual([
    expect.objectContaining({
      type: 'error',
      message: expect.stringContaining('Refresh the library'),
    }),
  ]);
});
