import { DEFAULT_HOMEBASE_SYNC_PATH } from './config';
import { HomebaseSyncError, type HomebaseSyncAdapter } from './adapter';
import type { HomebaseEnvelope } from './types';
import { HOMEBASE_WIRE_VERSION } from './types';

const statusToCode = (status: number) => {
  if (status === 401 || status === 403) return 'AUTH_FAILED' as const;
  if (status === 404) return 'NOT_FOUND' as const;
  if (status === 409) return 'CONFLICT' as const;
  if (status === 429) return 'RATE_LIMITED' as const;
  if (status >= 500) return 'NETWORK' as const;
  return 'UNKNOWN' as const;
};

const errorMessage = async (res: Response): Promise<string> => {
  try {
    const body = (await res.json()) as { error?: string; message?: string };
    return body.error || body.message || res.statusText || `HTTP ${res.status}`;
  } catch {
    return res.statusText || `HTTP ${res.status}`;
  }
};

const TIMEOUT_MS = 15_000;

export const createHomebaseHttpAdapter = (
  baseUrl: string,
  clientId: string,
  getToken: () => Promise<string | null>,
): HomebaseSyncAdapter => {
  const syncUrl = `${baseUrl}${DEFAULT_HOMEBASE_SYNC_PATH}`;

  const request = async (url: string, init: RequestInit = {}): Promise<HomebaseEnvelope> => {
    const token = await getToken();
    if (!token) throw new HomebaseSyncError('Not authenticated', 'AUTH_FAILED', 401, false);

    const controller = new AbortController();
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('aborted')), {
        once: true,
      });
    });
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      return await Promise.race([
        (async () => {
          const res = await fetch(url, {
            ...init,
            signal: controller.signal,
            headers: {
              ...init.headers,
              Authorization: `Bearer ${token}`,
              'X-Homebase-Client': clientId,
              'X-Homebase-Schema': String(HOMEBASE_WIRE_VERSION),
            },
          });
          if (!res.ok) {
            throw new HomebaseSyncError(
              await errorMessage(res),
              statusToCode(res.status),
              res.status,
            );
          }
          return (await res.json()) as HomebaseEnvelope;
        })(),
        aborted,
      ]);
    } catch (err) {
      if (err instanceof HomebaseSyncError) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      throw new HomebaseSyncError(`Homebase request failed: ${reason}`, 'NETWORK', undefined, true);
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    pull(query) {
      const params = new URLSearchParams({ since: String(query.since) });
      if (query.channel) params.set('type', query.channel);
      if (query.bookHash) params.set('book', query.bookHash);
      if (query.metaHash) params.set('meta_hash', query.metaHash);
      if (query.limit && query.limit > 0) params.set('limit', String(query.limit));
      return request(`${syncUrl}?${params.toString()}`);
    },
    push(envelope) {
      return request(syncUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(envelope),
      });
    },
  };
};
