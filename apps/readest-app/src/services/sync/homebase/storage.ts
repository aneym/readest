/**
 * Homebase object storage seam (REVIEW-ONLY SPIKE).
 *
 * `libs/storage.ts` is a set of module-level functions bound to
 * `getAPIBaseUrl() + '/storage/*'`, consumed by `services/cloudService.ts`.
 * Four operations carry everything: presign an upload, resolve a download URL,
 * delete an object, list objects.
 *
 * Readest's presign flow is the part worth keeping. The client never streams
 * bytes through the API: it asks for a URL and then hands that URL to
 * `tauriUpload` / `webUpload`, which is what makes a 400MB audiobook survive a
 * mobile upload. A Homebase adapter that proxied bytes through its own API
 * would regress that, so this interface presigns too.
 *
 * The one addition over Readest's storage is {@link HomebaseObjectClass}. Readest
 * derives an object's kind from a path prefix (`CLOUD_BOOKS_SUBDIR`,
 * `CLOUD_REPLICAS_SUBDIR`); naming the class explicitly lets Homebase apply
 * different retention and quota per kind, and it is where `note-audio` — the
 * audio-note extension point — gets its own storage lane without a path-prefix
 * convention nobody can enforce.
 */

import type { HomebaseSyncConfig } from './config';
import { HomebaseSyncError } from './adapter';
import type { HomebaseHttpDeps } from './httpAdapter';

export type HomebaseObjectClass = 'book' | 'cover' | 'replica' | 'note-audio';

export interface HomebaseUploadTarget {
  /** Presigned URL the transfer layer PUTs/POSTs to. */
  uploadUrl: string;
  /** Headers the presigned URL requires (content-type, checksum, …). */
  headers?: Record<string, string>;
  /** Stable object id, stored on the record (e.g. `HomebaseNoteAudio.asset_id`). */
  objectId: string;
  /** Absolute expiry, epoch ms. A stale target must be re-presigned, not retried. */
  expiresAt: number;
}

export interface HomebaseObject {
  objectId: string;
  objectClass: HomebaseObjectClass;
  bookHash?: string;
  size: number;
  contentType?: string;
  updatedAt: string;
}

export interface HomebaseStorageAdapter {
  /**
   * Presign an upload. `bookHash` scopes book/cover/note-audio objects so
   * Homebase can bill and purge per book without parsing paths.
   */
  presignUpload(input: {
    objectClass: HomebaseObjectClass;
    filename: string;
    size: number;
    contentType?: string;
    bookHash?: string;
  }): Promise<HomebaseUploadTarget>;

  /** Resolve a time-limited download URL. `null` when the object is absent. */
  getDownloadUrl(objectId: string): Promise<string | null>;

  /**
   * Delete an object. A missing object is SUCCESS — Readest's own
   * `deleteFile` swallows failures because callers dispatch it without
   * awaiting, and a delete that 404s has already achieved its goal.
   */
  deleteObject(objectId: string): Promise<void>;

  /** List objects, optionally filtered. Paged via the opaque `cursor`. */
  listObjects(input?: {
    objectClass?: HomebaseObjectClass;
    bookHash?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ objects: HomebaseObject[]; cursor?: string }>;
}

const statusToCode = (status: number) =>
  status === 401 || status === 403
    ? ('AUTH_FAILED' as const)
    : status === 404
      ? ('NOT_FOUND' as const)
      : status === 429
        ? ('RATE_LIMITED' as const)
        : status >= 500
          ? ('NETWORK' as const)
          : ('UNKNOWN' as const);

export const createHomebaseHttpStorage = (
  config: HomebaseSyncConfig,
  deps: HomebaseHttpDeps,
): HomebaseStorageAdapter => {
  const fetchImpl = deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const base = `${config.baseUrl}${config.storagePath}`;

  const request = async (path: string, init: RequestInit): Promise<Response> => {
    const token = await deps.getToken();
    if (!token) throw new HomebaseSyncError('Not authenticated', 'AUTH_FAILED', 401, false);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      return await fetchImpl(`${base}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          ...init.headers,
          Authorization: `Bearer ${token}`,
          'X-Homebase-Client': config.clientId,
        },
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new HomebaseSyncError(`Homebase storage failed: ${reason}`, 'NETWORK', undefined, true);
    } finally {
      clearTimeout(timer);
    }
  };

  const expectOk = (res: Response) => {
    if (res.ok) return;
    throw new HomebaseSyncError(
      res.statusText || `HTTP ${res.status}`,
      statusToCode(res.status),
      res.status,
    );
  };

  return {
    async presignUpload(input) {
      const res = await request('/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          object_class: input.objectClass,
          filename: input.filename,
          size: input.size,
          content_type: input.contentType,
          book_hash: input.bookHash,
        }),
      });
      expectOk(res);
      const body = (await res.json()) as {
        upload_url: string;
        object_id: string;
        headers?: Record<string, string>;
        expires_at?: number;
      };
      return {
        uploadUrl: body.upload_url,
        objectId: body.object_id,
        headers: body.headers,
        // A server that omits the expiry gets a conservative 10 minutes rather
        // than "never expires" — an optimistic default here means a stale URL
        // is retried instead of re-presigned, which fails with an opaque 403.
        expiresAt: body.expires_at ?? Date.now() + 10 * 60 * 1000,
      };
    },

    async getDownloadUrl(objectId) {
      const res = await request(`/download?object_id=${encodeURIComponent(objectId)}`, {
        method: 'GET',
      });
      if (res.status === 404) return null;
      expectOk(res);
      const body = (await res.json()) as { download_url?: string };
      return body.download_url ?? null;
    },

    async deleteObject(objectId) {
      const res = await request(`/object?object_id=${encodeURIComponent(objectId)}`, {
        method: 'DELETE',
      });
      if (res.status === 404) return;
      expectOk(res);
    },

    async listObjects(input = {}) {
      const params = new URLSearchParams();
      if (input.objectClass) params.set('object_class', input.objectClass);
      if (input.bookHash) params.set('book_hash', input.bookHash);
      if (input.cursor) params.set('cursor', input.cursor);
      if (input.limit) params.set('limit', String(input.limit));
      const res = await request(`/list?${params.toString()}`, { method: 'GET' });
      expectOk(res);
      const body = (await res.json()) as {
        objects?: {
          object_id: string;
          object_class: HomebaseObjectClass;
          book_hash?: string;
          size: number;
          content_type?: string;
          updated_at: string;
        }[];
        cursor?: string;
      };
      return {
        objects: (body.objects ?? []).map((o) => ({
          objectId: o.object_id,
          objectClass: o.object_class,
          bookHash: o.book_hash,
          size: o.size,
          contentType: o.content_type,
          updatedAt: o.updated_at,
        })),
        ...(body.cursor ? { cursor: body.cursor } : {}),
      };
    },
  };
};
