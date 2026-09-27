/**
 * HTTP implementation of {@link HomebaseSyncAdapter} (REVIEW-ONLY SPIKE).
 *
 * Wire, as proposed to the Homebase side (no fixtures existed at the time this
 * was written — see `docs/homebase/prototype-report.md`, "Open questions"):
 *
 *   GET  {base}{syncPath}?since=<ms>&type=<channel>&book=<hash>&meta_hash=<h>&limit=<n>
 *   POST {base}{syncPath}                          body: HomebaseEnvelope
 *   GET  {base}{syncPath}/capabilities
 *
 * Auth is a bearer token supplied by the caller, NOT read from Supabase here.
 * Keeping token acquisition injectable is what lets the contract tests run with
 * no auth stack, and it is also the honest shape: a Homebase deployment issues
 * its own tokens, so `utils/access.getAccessToken` is the wrong source.
 */

import type { HomebaseSyncConfig } from './config';
import {
  HomebaseSyncError,
  type HomebaseCapabilities,
  type HomebasePullQuery,
  type HomebaseSyncAdapter,
} from './adapter';
import type { HomebaseEnvelope } from './types';
import { HOMEBASE_CHANNELS, HOMEBASE_WIRE_VERSION } from './types';

export interface HomebaseHttpDeps {
  /** Resolves the bearer token, or null when signed out. */
  getToken: () => Promise<string | null>;
  /** Injectable for tests; defaults to the global. */
  fetchImpl?: typeof fetch;
}

const statusToCode = (status: number) => {
  if (status === 401 || status === 403) return 'AUTH_FAILED' as const;
  if (status === 404) return 'NOT_FOUND' as const;
  if (status === 409) return 'CONFLICT' as const;
  if (status === 429) return 'RATE_LIMITED' as const;
  // 5xx is the server failing, not the request being wrong: retry is sensible.
  if (status >= 500) return 'NETWORK' as const;
  return 'UNKNOWN' as const;
};

/** Read the server's error text without letting a non-JSON body mask the status. */
const errorMessage = async (res: Response): Promise<string> => {
  try {
    const body = (await res.json()) as { error?: string; message?: string };
    return body.error || body.message || res.statusText || `HTTP ${res.status}`;
  } catch {
    return res.statusText || `HTTP ${res.status}`;
  }
};

export const createHomebaseHttpAdapter = (
  config: HomebaseSyncConfig,
  deps: HomebaseHttpDeps,
): HomebaseSyncAdapter => {
  const fetchImpl = deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const syncUrl = `${config.baseUrl}${config.syncPath}`;

  const request = async <T>(
    url: string,
    init: RequestInit,
    read: (res: Response) => Promise<T>,
  ): Promise<T> => {
    const token = await deps.getToken();
    if (!token) throw new HomebaseSyncError('Not authenticated', 'AUTH_FAILED', 401, false);

    // The same budget covers headers and the body, even if a fetch implementation
    // does not reject its pending json() when the signal is aborted.
    const controller = new AbortController();
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error('aborted'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      return await Promise.race([
        (async () => {
          const res = await fetchImpl(url, {
            ...init,
            signal: controller.signal,
            headers: {
              ...init.headers,
              Authorization: `Bearer ${token}`,
              'X-Homebase-Client': config.clientId,
              'X-Homebase-Schema': String(HOMEBASE_WIRE_VERSION),
            },
          });
          return read(res);
        })(),
        aborted,
      ]);
    } catch (err) {
      if (err instanceof HomebaseSyncError) throw err;
      // Transport failures (DNS, offline, abort or a stalled body) are retryable.
      const reason = err instanceof Error ? err.message : String(err);
      throw new HomebaseSyncError(`Homebase request failed: ${reason}`, 'NETWORK', undefined, true);
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
    }
  };

  const expectOk = async (res: Response): Promise<void> => {
    if (res.ok) return;
    const code = statusToCode(res.status);
    throw new HomebaseSyncError(await errorMessage(res), code, res.status);
  };

  return {
    endpointId: syncUrl,

    async capabilities(): Promise<HomebaseCapabilities | null> {
      return request(`${syncUrl}/capabilities`, { method: 'GET' }, async (res) => {
        // A server that predates the probe answers 404: fall back to v1.
        if (res.status === 404) return null;
        await expectOk(res);
        const body = (await res.json()) as Partial<HomebaseCapabilities>;
        return {
          channels: body.channels ?? HOMEBASE_CHANNELS,
          storage: body.storage ?? false,
          noteAudio: body.noteAudio ?? false,
          schemaVersion: body.schemaVersion ?? HOMEBASE_WIRE_VERSION,
        };
      });
    },

    async pull(query: HomebasePullQuery): Promise<HomebaseEnvelope> {
      const params = new URLSearchParams({ since: String(query.since) });
      if (query.channel) params.set('type', query.channel);
      if (query.bookHash) params.set('book', query.bookHash);
      if (query.metaHash) params.set('meta_hash', query.metaHash);
      if (query.limit && query.limit > 0) params.set('limit', String(query.limit));
      return request(`${syncUrl}?${params.toString()}`, { method: 'GET' }, async (res) => {
        await expectOk(res);
        return (await res.json()) as HomebaseEnvelope;
      });
    },

    async push(envelope: HomebaseEnvelope): Promise<HomebaseEnvelope> {
      return request(
        syncUrl,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(envelope),
        },
        async (res) => {
          await expectOk(res);
          return (await res.json()) as HomebaseEnvelope;
        },
      );
    },
  };
};
