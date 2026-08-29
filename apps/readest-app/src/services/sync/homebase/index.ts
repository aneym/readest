/**
 * Homebase sync adapter — public surface (REVIEW-ONLY SPIKE).
 *
 * Nothing here is imported by shipping code. `resolveRecordSyncClient` is the
 * function that WOULD be, and it is written so the landing diff is one line:
 *
 *     // src/context/SyncContext.tsx
 *     -const syncClient = new SyncClient();
 *     +const syncClient = resolveRecordSyncClient();
 *
 * With Homebase unconfigured it returns `new SyncClient()`, byte-for-byte the
 * behaviour that ships today. That is the property `seam.test.ts` asserts, and
 * it is why the flag can land dark.
 */

export * from './types';
export * from './config';
export * from './clocks';
export * from './wire';
export * from './adapter';
export * from './httpAdapter';
export * from './memoryAdapter';
export * from './outbox';
export * from './storage';
export * from './recordSyncClient';

import { SyncClient } from '@/libs/sync';
import { getAccessToken } from '@/utils/access';
import { isHomebaseSyncEnabled, resolveHomebaseConfig } from './config';
import { createHomebaseHttpAdapter } from './httpAdapter';
import { createMemoryOutboxStore, createSyncOutbox, type OutboxStore } from './outbox';
import { HomebaseSyncClient, type RecordSyncClient } from './recordSyncClient';

export interface ResolveRecordSyncClientOptions {
  /** Persistent outbox store. Defaults to in-memory, which loses on restart. */
  outboxStore?: OutboxStore;
  /** Bearer token source. Defaults to the Supabase session token. */
  getToken?: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}

/**
 * Pick the record-sync backend. Homebase when configured AND enabled, otherwise
 * the stock client — the fallback is not a degraded mode, it is the current
 * product, so a misconfigured Homebase can never take sync down.
 */
export const resolveRecordSyncClient = (
  options: ResolveRecordSyncClientOptions = {},
): RecordSyncClient => {
  if (!isHomebaseSyncEnabled()) return new SyncClient();
  const config = resolveHomebaseConfig();
  if (!config) return new SyncClient();

  const adapter = createHomebaseHttpAdapter(config, {
    getToken: options.getToken ?? getAccessToken,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  const outbox = createSyncOutbox({ store: options.outboxStore ?? createMemoryOutboxStore() });
  return new HomebaseSyncClient({ adapter, outbox });
};
