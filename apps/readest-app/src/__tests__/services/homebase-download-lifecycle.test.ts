import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { File as NodeFile } from 'node:buffer';
import { NodeAppService } from '@/services/nodeAppService';
import { useLibraryStore } from '@/store/libraryStore';
import { useReaderStore } from '@/store/readerStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useTransferStore } from '@/store/transferStore';
import { transferManager } from '@/services/transferManager';
import { eventDispatcher } from '@/utils/event';
import type { Book } from '@/types/book';

// Integration: real reader/transfer owners, cloud/storage transport and disk service.
// Only the household HTTP edge is faked. Existing hook tests mock the manager
// and cannot detect a transport 404 being retried or a reader skipping download.
const book: Book = {
  hash: '4c58263345999aa6580dcd52005f97eb',
  title: 'Aligned edition',
  author: 'Fixture',
  format: 'EPUB',
  createdAt: 1,
  updatedAt: 2,
  uploadedAt: 3,
};
let root: string;
let service: NodeAppService;
let requests: string[];
let toasts: unknown[];
const onToast = (event: CustomEvent) => {
  toasts.push(event.detail);
};

beforeEach(async () => {
  root = await mkdtemp(
    '/private/tmp/claude-501/-Volumes-StudioExt-repos-personal-homebase/296cad86-cb9e-4e0e-ae05-c68bede1a6e3/scratchpad/download-',
  );
  service = new NodeAppService(root);
  await service.init();
  await service.createDir('', 'Books', true);
  localStorage.clear();
  vi.stubGlobal('File', NodeFile);
  vi.stubEnv('NEXT_PUBLIC_APP_PLATFORM', 'web');
  window.__READEST_RUNTIME_CONFIG = {
    homebaseApiBaseUrl: 'https://household.test',
    homebaseSyncEnabled: true,
  };
  requests = [];
  toasts = [];
  vi.stubGlobal('fetch', async (url: string) => {
    requests.push(url);
    return new Response(JSON.stringify({ error: 'Book file not found' }), { status: 404 });
  });
  useSettingsStore.getState().setSettings(await service.loadSettings());
  useLibraryStore.getState().setLibrary([{ ...book }]);
  useLibraryStore.setState({ libraryLoaded: true });
  useTransferStore.setState({
    transfers: {},
    isQueuePaused: false,
    activeCount: 0,
    maxConcurrent: 2,
  });
  eventDispatcher.on('toast', onToast);
});
afterEach(async () => {
  eventDispatcher.off('toast', onToast);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete window.__READEST_RUNTIME_CONFIG;
  await rm(root, { recursive: true, force: true });
});

test('reader requests missing aligned bytes before parsing, and surfaces a missing server file', async () => {
  await expect(
    useReaderStore
      .getState()
      .initViewState({ getAppService: async () => service }, book.hash, `${book.hash}-open`),
  ).rejects.toThrow('Homebase book download failed (404');
  expect(requests.some((url) => url.includes(`fileKey=${book.hash}.epub`))).toBe(true);
  expect(useReaderStore.getState().getViewState(`${book.hash}-open`)?.loading).toBe(false);
});

test('missing household hash fails once, remains refresh-needed across reconnect, and has no toast', async () => {
  await transferManager.initialize(
    service,
    () => useLibraryStore.getState().library,
    async (row) => {
      await useLibraryStore.getState().updateBook({ getAppService: async () => service }, row);
    },
    (key) => key,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  const id = transferManager.queueDownload(book)!;
  await vi.waitFor(() => expect(useTransferStore.getState().transfers[id]?.status).toBe('failed'));
  expect(requests.filter((url) => url.includes(`fileKey=${book.hash}.epub`))).toHaveLength(1);
  expect(useTransferStore.getState().transfers[id]?.retryCount).toBe(0);
  expect(useTransferStore.getState().transfers[id]?.error).toContain('Refresh the library');
  expect(transferManager.reviveTransientFailures('online')).toBe(0);
  expect(transferManager.queueDownload(book)).toBe(id);
  expect(toasts).toEqual([]);
  // Queue strings from the installed older build must also stay terminal.
  useTransferStore.getState().setTransferStatus(id, 'failed', 'Homebase download URL failed: 404');
  expect(transferManager.reviveTransientFailures('manual')).toBe(0);
  expect(transferManager.queueDownload(book)).toBe(id);
});

test('reader downloads and parses a server-only EPUB into usable book data', async () => {
  const bytes = await readFile(`${process.cwd()}/src/__tests__/fixtures/data/repro-5263.epub`);
  vi.stubGlobal('fetch', async (url: string) => {
    requests.push(url);
    return url.includes('/download?')
      ? new Response(JSON.stringify({ downloadUrl: 'https://household.test/file.epub' }))
      : new Response(bytes);
  });
  await useReaderStore
    .getState()
    .initViewState({ getAppService: async () => service }, book.hash, `${book.hash}-success`);
  expect(await service.isBookAvailable(book)).toBe(true);
  expect(useReaderStore.getState().getViewState(`${book.hash}-success`)?.loading).toBe(false);
  expect(useLibraryStore.getState().getBookByHash(book.hash)?.downloadedAt).toBeGreaterThan(0);
});
