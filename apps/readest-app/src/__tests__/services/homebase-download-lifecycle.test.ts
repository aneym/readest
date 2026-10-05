import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { renderHook, cleanup } from '@testing-library/react';
import { useBookTransferActions } from '@/app/library/hooks/useBookTransferActions';
import { File as NodeFile } from 'node:buffer';
import { NodeAppService } from '@/services/nodeAppService';
import { useLibraryStore } from '@/store/libraryStore';
import { useBookDataStore } from '@/store/bookDataStore';
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
  root = await mkdtemp(`${tmpdir()}/download-`);
  service = new NodeAppService(root);
  await service.init();
  await service.createDir('', 'Books', true);
  localStorage.clear();
  useBookDataStore.setState({ booksData: {} });
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
  cleanup();
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

// CI must not depend on an agent session directory existing on the host.
test('filesystem fixture is created in the operating system temporary directory', () => {
  expect(dirname(root)).toBe(tmpdir());
});

test('a mirror-only synced row is not routed to household storage on a reader deep link', async () => {
  window.__READEST_RUNTIME_CONFIG = { homebaseSyncEnabled: false };
  const cloudDownload = vi.spyOn(service, 'downloadBook');
  await expect(
    useReaderStore
      .getState()
      .initViewState({ getAppService: async () => service }, book.hash, `${book.hash}-mirror`),
  ).rejects.toThrow();
  expect(requests).toEqual([]);
  expect(cloudDownload).not.toHaveBeenCalled();
  cloudDownload.mockRestore();
});

test('library download is shared with reader open; missing files tell manual callers to refresh', async () => {
  await transferManager.initialize(
    service,
    () => useLibraryStore.getState().library,
    async (row) => {
      await useLibraryStore.getState().updateBook({ getAppService: async () => service }, row);
    },
    (key) => key,
  );
  const bytes = await readFile(`${process.cwd()}/src/__tests__/fixtures/data/repro-5263.epub`);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal('fetch', async (url: string) => {
    requests.push(url);
    await gate;
    return url.includes('/download?')
      ? new Response(JSON.stringify({ downloadUrl: 'https://household.test/file.epub' }))
      : new Response(bytes);
  });
  const sharedId = transferManager.queueDownload(book)!;
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  const opened = useReaderStore
    .getState()
    .initViewState({ getAppService: async () => service }, book.hash, `${book.hash}-shared`);
  // Let the reader reach the held HTTP request before releasing the library transfer.
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect.soft(requests).toHaveLength(1);
  release();
  await opened;
  await vi.waitFor(() =>
    expect(useTransferStore.getState().transfers[sharedId]?.status).toBe('completed'),
  );
  expect.soft(requests.filter((url) => url.includes(`fileKey=${book.hash}.epub`))).toHaveLength(1);
  expect(useReaderStore.getState().getViewState(`${book.hash}-shared`)?.loading).toBe(false);

  const missingBook = { ...book, hash: 'missing-book' };
  useLibraryStore.getState().setLibrary([missingBook]);
  requests = [];
  toasts = [];
  vi.stubGlobal('fetch', async (url: string) => {
    requests.push(url);
    return new Response(JSON.stringify({ error: 'Book file not found' }), { status: 404 });
  });
  const id = transferManager.queueDownload(missingBook)!;
  await vi.waitFor(() => expect(useTransferStore.getState().transfers[id]?.status).toBe('failed'));
  expect(requests.filter((url) => url.includes('fileKey=missing-book.epub'))).toHaveLength(1);
  expect(useTransferStore.getState().transfers[id]?.retryCount).toBe(0);
  expect(transferManager.reviveTransientFailures('online')).toBe(0);
  expect.soft(toasts).toEqual([
    expect.objectContaining({
      type: 'error',
      message: expect.stringContaining('Refresh the library'),
    }),
  ]);

  toasts = [];
  const { result } = renderHook(() =>
    useBookTransferActions(
      { getAppService: async () => service },
      service,
      useLibraryStore.getState().updateBook,
      () => {},
    ),
  );
  expect.soft(await result.current.handleBookDownload(missingBook, { queued: true })).toBe(false);
  expect(requests.filter((url) => url.includes('fileKey=missing-book.epub'))).toHaveLength(1);
  expect.soft(toasts).toEqual([]);
  // Upgrades must also recognize the previous build's persisted marker.
  useTransferStore.getState().setTransferStatus(id, 'failed', 'Homebase download URL failed: 410');
  expect(transferManager.reviveTransientFailures('manual')).toBe(0);
  toasts = [];
  expect.soft(await result.current.handleBookDownload(missingBook, { queued: true })).toBe(false);
  expect(requests.filter((url) => url.includes('fileKey=missing-book.epub'))).toHaveLength(1);
  expect.soft(toasts).toEqual([]);
});
