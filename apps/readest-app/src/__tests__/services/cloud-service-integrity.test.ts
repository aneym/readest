import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { Book } from '@/types/book';

vi.mock('@/libs/storage', () => ({
  downloadFile: vi.fn(),
  uploadFile: vi.fn(),
  uploadReplicaFile: vi.fn(),
  deleteFile: vi.fn(),
  createProgressHandler: vi.fn(() => vi.fn()),
  batchGetDownloadUrls: vi.fn(async () => []),
}));

import { downloadBook, verifyLocalBookFile, BookIntegrityError } from '@/services/cloudService';
import { downloadFile } from '@/libs/storage';

const book = (overrides: Partial<Book> = {}): Book => ({
  hash: '0123456789abcdef0123456789abcdef',
  format: 'EPUB',
  title: 'Trip fixture',
  author: 'Fixture',
  createdAt: 1,
  updatedAt: 2,
  uploadedAt: 3,
  ...overrides,
});

const zipBytes = (withEocd: boolean): Uint8Array => {
  const body = new Uint8Array(200);
  body.set([0x50, 0x4b, 0x03, 0x04], 0);
  if (withEocd) body.set([0x50, 0x4b, 0x05, 0x06], 170);
  return body;
};

class FakeFile extends File {
  private readonly data: Uint8Array;
  constructor(data: Uint8Array) {
    super([data as BlobPart], 'book.epub');
    this.data = data;
  }
  override get size() {
    return this.data.length;
  }
  override slice(start = 0, end = this.data.length) {
    return new Blob([this.data.slice(start, end) as BlobPart]);
  }
}

const makeFs = (files: Map<string, Uint8Array>) => ({
  exists: vi.fn(async (path: string) => files.has(path) || !path.includes('.')),
  createDir: vi.fn(),
  removeFile: vi.fn(async (path: string) => {
    files.delete(path);
  }),
  openFile: vi.fn(async (path: string) => new FakeFile(files.get(path)!)),
});

const lfp = (b: Book) => `${b.hash}/Trip fixture.epub`;
// Every fixture already holds a cover so the cover leg never consumes a mock.
const cover = (b: Book): [string, Uint8Array] => [`${b.hash}/cover.png`, new Uint8Array([1])];

beforeEach(() => vi.clearAllMocks());

describe('verifyLocalBookFile', () => {
  test('accepts a zip with header and end-of-central-directory', async () => {
    const b = book();
    const fs = makeFs(new Map([[lfp(b), zipBytes(true)]]));
    expect(await verifyLocalBookFile(fs as never, b)).toBeNull();
  });
  test('rejects a truncated zip (no EOCD), a foreign file and an empty file', async () => {
    const b = book();
    expect(
      await verifyLocalBookFile(makeFs(new Map([[lfp(b), zipBytes(false)]])) as never, b),
    ).toMatch(/truncated/);
    const text = new TextEncoder().encode('<html>not a book</html>'.padEnd(64, ' '));
    expect(await verifyLocalBookFile(makeFs(new Map([[lfp(b), text]])) as never, b)).toMatch(
      /header/,
    );
    expect(
      await verifyLocalBookFile(makeFs(new Map([[lfp(b), new Uint8Array(0)]])) as never, b),
    ).toMatch(/empty/);
    expect(await verifyLocalBookFile(makeFs(new Map()) as never, b)).toMatch(/missing/);
  });
  test('non-zip formats only need to be non-empty', async () => {
    const b = book({ format: 'PDF' });
    const fs = makeFs(new Map([[`${b.hash}/Trip fixture.pdf`, new Uint8Array([1, 2, 3])]]));
    expect(await verifyLocalBookFile(fs as never, b)).toBeNull();
  });
});

describe('downloadBook integrity', () => {
  test('a partial file left at the final path is discarded and re-fetched, not stamped downloaded', async () => {
    const b = book();
    const files = new Map([cover(b), [lfp(b), zipBytes(false)]]);
    const fs = makeFs(files);
    vi.mocked(downloadFile).mockImplementationOnce(async () => {
      files.set(lfp(b), zipBytes(true));
      return {};
    });
    await downloadBook({} as never, fs as never, '/fixture', b);
    expect(fs.removeFile).toHaveBeenCalledWith(lfp(b), 'Books');
    expect(downloadFile).toHaveBeenCalledTimes(1);
    expect(b.downloadedAt).toBeTruthy();
  });

  test('an intact local file is trusted without a network fetch', async () => {
    const b = book();
    const fs = makeFs(new Map([cover(b), [lfp(b), zipBytes(true)]]));
    await downloadBook({} as never, fs as never, '/fixture', b);
    expect(downloadFile).not.toHaveBeenCalled();
    expect(b.downloadedAt).toBeTruthy();
  });

  test('served bytes that are not a book fail with BookIntegrityError and are removed', async () => {
    const b = book();
    const files = new Map<string, Uint8Array>([cover(b)]);
    const fs = makeFs(files);
    vi.mocked(downloadFile).mockImplementationOnce(async () => {
      files.set(lfp(b), new TextEncoder().encode('<!doctype html>'.padEnd(64, ' ')));
      return {};
    });
    await expect(downloadBook({} as never, fs as never, '/fixture', b)).rejects.toBeInstanceOf(
      BookIntegrityError,
    );
    expect(files.has(lfp(b))).toBe(false);
    expect(b.downloadedAt).toBeUndefined();
  });

  test('an interrupted transfer that leaves nothing behind is a plain error and nothing is stamped', async () => {
    const b = book();
    const fs = makeFs(new Map([cover(b)]));
    vi.mocked(downloadFile).mockImplementationOnce(async () => {
      throw new Error('connection interrupted');
    });
    await expect(downloadBook({} as never, fs as never, '/fixture', b)).rejects.toThrow(
      'connection interrupted',
    );
    expect(b.downloadedAt).toBeUndefined();
  });
});
