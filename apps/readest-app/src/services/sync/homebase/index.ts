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
export * from './persistence';
export * from './storage';
export * from './recordSyncClient';
export * from './diagnostics';

import { SyncClient } from '@/libs/sync';
import { isTauriAppPlatform } from '@/services/environment';
import { isHomebaseSyncEnabled, resolveHomebaseConfig } from './config';
import { createHomebaseHttpAdapter } from './httpAdapter';
import { createSyncOutbox, type OutboxStore } from './outbox';
import {
  createFileOutboxStore,
  createPersistentOutboxStore,
  createTauriOutboxFs,
  getHomebaseToken,
  getOrCreateHomebaseClientId,
} from './persistence';
import { HomebaseSyncClient, type RecordSyncClient } from './recordSyncClient';
import { recordDiagnostic } from './diagnostics';
import { reportOutboxQueue, reportSyncError } from './syncStatus';

export interface ResolveRecordSyncClientOptions {
  /** Persistent outbox store. Defaults to a file on Tauri, localStorage on web. */
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
  const config = resolveHomebaseConfig({
    clientId: getOrCreateHomebaseClientId(),
  });
  if (!config) return new SyncClient();

  const adapter = createHomebaseHttpAdapter(config, {
    getToken: options.getToken ?? getHomebaseToken,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  const storage =
    options.outboxStore ??
    (isTauriAppPlatform()
      ? (() => {
          const fileStore = createTauriOutboxFs().then((fs) => createFileOutboxStore({ fs }));
          return {
            read: async () => (await fileStore).read(),
            write: async (entries) => (await fileStore).write(entries),
          } satisfies OutboxStore;
        })()
      : createPersistentOutboxStore());
  const updateQueue = (entries: Awaited<ReturnType<OutboxStore['read']>>) => {
    reportOutboxQueue(entries);
    return entries;
  };
  const store: OutboxStore = {
    read: async () => updateQueue(await storage.read()),
    write: async (entries) => {
      await storage.write(entries);
      updateQueue(entries);
    },
  };
  void store.read().catch(reportSyncError);
  const outbox = createSyncOutbox({ store });
  return new HomebaseSyncClient({
    adapter,
    outbox,
    onQueued: (count, error) =>
      recordDiagnostic('sync.queued', 'warn', `push queued: ${error.message}`, {
        count,
        code: error.code,
        status: error.status ?? null,
      }),
  });
};
