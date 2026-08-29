/**
 * Homebase endpoint configuration (REVIEW-ONLY SPIKE).
 *
 * Resolution order mirrors `services/environment.ts` / `services/runtimeConfig.ts`
 * so a self-hosted deployment configures Homebase exactly the way it already
 * configures the Readest API: runtime config first (settable on a published
 * image without a rebuild), then env, then nothing.
 *
 * The default is OFF and stays off. `isHomebaseSyncEnabled` returns false unless
 * a base URL is configured AND the enable flag is set, so merely importing this
 * module changes no behaviour — which is what keeps the spike reviewable.
 */

import { getRuntimeConfig } from '@/services/runtimeConfig';

export interface HomebaseSyncConfig {
  /** Base URL of the Homebase reader API, no trailing slash. */
  baseUrl: string;
  /** Sync endpoint path appended to `baseUrl`. */
  syncPath: string;
  /** Object-storage endpoint path appended to `baseUrl`. */
  storagePath: string;
  /** Per-request timeout, ms. Matches `SyncClient`'s 15s. */
  timeoutMs: number;
  /**
   * Stable per-install id sent with every push. Homebase uses it to attribute
   * a write to a device and to suppress echoing a client's own push back to it.
   */
  clientId: string;
}

const runtime = () => getRuntimeConfig() ?? {};

const trimSlash = (url: string) => url.replace(/\/+$/, '');

export const getHomebaseBaseUrl = (): string | null => {
  const raw =
    runtime().homebaseApiBaseUrl ||
    process.env['HOMEBASE_API_BASE_URL'] ||
    process.env['NEXT_PUBLIC_HOMEBASE_API_BASE_URL'] ||
    '';
  return raw ? trimSlash(raw) : null;
};

/**
 * Both a base URL and an explicit opt-in are required. Requiring the flag on
 * top of the URL means a deployment can stage the endpoint (health checks,
 * fixture replay) before any device routes real reading data to it.
 */
export const isHomebaseSyncEnabled = (): boolean => {
  if (!getHomebaseBaseUrl()) return false;
  if (runtime().homebaseSyncEnabled === true) return true;
  const flag =
    process.env['HOMEBASE_SYNC_ENABLED'] ?? process.env['NEXT_PUBLIC_HOMEBASE_SYNC_ENABLED'];
  return flag === '1' || flag === 'true';
};

export const DEFAULT_HOMEBASE_SYNC_PATH = '/reader/sync';
export const DEFAULT_HOMEBASE_STORAGE_PATH = '/reader/storage';

export const resolveHomebaseConfig = (
  overrides: Partial<HomebaseSyncConfig> & { baseUrl?: string } = {},
): HomebaseSyncConfig | null => {
  const baseUrl = overrides.baseUrl ?? getHomebaseBaseUrl();
  if (!baseUrl) return null;
  if (!overrides.clientId) return null;
  return {
    baseUrl: trimSlash(baseUrl),
    syncPath: overrides.syncPath ?? DEFAULT_HOMEBASE_SYNC_PATH,
    storagePath: overrides.storagePath ?? DEFAULT_HOMEBASE_STORAGE_PATH,
    timeoutMs: overrides.timeoutMs ?? 15000,
    clientId: overrides.clientId,
  };
};
