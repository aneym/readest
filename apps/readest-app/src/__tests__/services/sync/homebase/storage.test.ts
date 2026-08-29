import { describe, expect, test, vi } from 'vitest';
import { createHomebaseHttpStorage } from '@/services/sync/homebase/storage';
import type { HomebaseSyncConfig } from '@/services/sync/homebase/config';
import type { HomebaseSyncError } from '@/services/sync/homebase/adapter';

const CONFIG: HomebaseSyncConfig = {
  baseUrl: 'https://homebase.lan',
  syncPath: '/reader/sync',
  storagePath: '/reader/storage',
  timeoutMs: 15000,
  clientId: 'test-device',
};

const json = (status: number, body: unknown) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const makeStorage = (impl: () => Promise<Response>) => {
  const fetchImpl = vi.fn(impl);
  return {
    fetchImpl,
    storage: createHomebaseHttpStorage(CONFIG, {
      getToken: async () => 'token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }),
  };
};

describe('presignUpload', () => {
  test('presigns rather than proxying the bytes', async () => {
    // A 400MB audiobook streamed through the API is how mobile uploads die.
    // Readest's own storage presigns; the Homebase seam must not regress that.
    const { storage, fetchImpl } = makeStorage(async () =>
      json(200, {
        upload_url: 'https://s3.homebase.lan/put/obj-1?sig=x',
        object_id: 'obj-1',
        headers: { 'Content-Type': 'application/epub+zip' },
        expires_at: 1_800_000_000_000,
      }),
    );
    const target = await storage.presignUpload({
      objectClass: 'book',
      filename: 'piranesi.epub',
      size: 1024,
      contentType: 'application/epub+zip',
      bookHash: 'a',
    });
    expect(target.uploadUrl).toContain('s3.homebase.lan');
    expect(target.objectId).toBe('obj-1');
    expect(target.expiresAt).toBe(1_800_000_000_000);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://homebase.lan/reader/storage/upload');
    expect(JSON.parse(String(init.body))).toMatchObject({
      object_class: 'book',
      book_hash: 'a',
      filename: 'piranesi.epub',
    });
  });

  test('a server that omits the expiry gets a conservative default, not "never"', async () => {
    // An optimistic default means a stale URL is retried instead of
    // re-presigned, which surfaces as an opaque 403 from the object store.
    const { storage } = makeStorage(async () =>
      json(200, { upload_url: 'https://s3/put', object_id: 'obj-1' }),
    );
    const before = Date.now();
    const target = await storage.presignUpload({ objectClass: 'cover', filename: 'c', size: 1 });
    expect(target.expiresAt).toBeGreaterThan(before);
    expect(target.expiresAt).toBeLessThanOrEqual(before + 10 * 60 * 1000 + 1000);
  });

  test('note-audio is its own object class', async () => {
    const { storage, fetchImpl } = makeStorage(async () =>
      json(200, { upload_url: 'https://s3/put', object_id: 'audio-1' }),
    );
    const target = await storage.presignUpload({
      objectClass: 'note-audio',
      filename: 'note.m4a',
      size: 90_000,
      contentType: 'audio/mp4',
      bookHash: 'a',
    });
    // The id is what lands on `HomebaseNoteAudio.asset_id`.
    expect(target.objectId).toBe('audio-1');
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).object_class).toBe('note-audio');
  });
});

describe('getDownloadUrl', () => {
  test('resolves null for an absent object rather than throwing', async () => {
    const { storage } = makeStorage(async () => json(404, null));
    expect(await storage.getDownloadUrl('missing')).toBeNull();
  });

  test('returns the signed URL', async () => {
    const { storage } = makeStorage(async () =>
      json(200, { download_url: 'https://s3/get?sig=y' }),
    );
    expect(await storage.getDownloadUrl('obj-1')).toBe('https://s3/get?sig=y');
  });

  test('maps an auth failure to AUTH_FAILED', async () => {
    const { storage } = makeStorage(async () => json(401, { error: 'expired' }));
    const err = (await storage.getDownloadUrl('obj-1').catch((e) => e)) as HomebaseSyncError;
    expect(err.code).toBe('AUTH_FAILED');
  });
});

describe('deleteObject', () => {
  test('a missing object is success', async () => {
    // Readest dispatches deletes without awaiting; a delete that 404s has
    // already achieved its goal.
    const { storage } = makeStorage(async () => json(404, null));
    await expect(storage.deleteObject('gone')).resolves.toBeUndefined();
  });

  test('a server error still throws', async () => {
    const { storage } = makeStorage(async () => json(500, { error: 'boom' }));
    const err = (await storage.deleteObject('obj-1').catch((e) => e)) as HomebaseSyncError;
    expect(err.code).toBe('NETWORK');
    expect(err.retryable).toBe(true);
  });
});

describe('listObjects', () => {
  test('maps rows to camelCase and carries the paging cursor', async () => {
    const { storage, fetchImpl } = makeStorage(async () =>
      json(200, {
        objects: [
          {
            object_id: 'obj-1',
            object_class: 'note-audio',
            book_hash: 'a',
            size: 90_000,
            content_type: 'audio/mp4',
            updated_at: '2026-08-01T00:00:00.000Z',
          },
        ],
        cursor: 'next-page',
      }),
    );
    const page = await storage.listObjects({ objectClass: 'note-audio', bookHash: 'a', limit: 10 });
    expect(page.objects[0]).toEqual({
      objectId: 'obj-1',
      objectClass: 'note-audio',
      bookHash: 'a',
      size: 90_000,
      contentType: 'audio/mp4',
      updatedAt: '2026-08-01T00:00:00.000Z',
    });
    expect(page.cursor).toBe('next-page');
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toContain('object_class=note-audio');
    expect(url).toContain('book_hash=a');
    expect(url).toContain('limit=10');
  });

  test('an empty store lists nothing without a cursor', async () => {
    const { storage } = makeStorage(async () => json(200, {}));
    expect(await storage.listObjects()).toEqual({ objects: [] });
  });
});
