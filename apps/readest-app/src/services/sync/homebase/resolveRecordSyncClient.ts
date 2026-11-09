import { SyncClient } from '@/libs/sync';
import { isTauriAppPlatform } from '@/services/environment';
import { getHomebaseBaseUrl, isHomebaseSyncEnabled } from './config';
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

const tauriOutboxStore = (): OutboxStore => {
  const store = createTauriOutboxFs().then((fs) => createFileOutboxStore({ fs }));
  return {
    read: async () => (await store).read(),
    write: async (entries) => (await store).write(entries),
  };
};

const reportingStore = (store: OutboxStore): OutboxStore => ({
  read: async () => {
    const entries = await store.read();
    reportOutboxQueue(entries);
    return entries;
  },
  write: async (entries) => {
    await store.write(entries);
    reportOutboxQueue(entries);
  },
});

export const resolveRecordSyncClient = (): RecordSyncClient => {
  const baseUrl = isHomebaseSyncEnabled() && getHomebaseBaseUrl();
  if (!baseUrl) return new SyncClient();
  const store = reportingStore(
    isTauriAppPlatform() ? tauriOutboxStore() : createPersistentOutboxStore(),
  );
  void store.read().catch(reportSyncError);
  return new HomebaseSyncClient({
    adapter: createHomebaseHttpAdapter(baseUrl, getOrCreateHomebaseClientId(), getHomebaseToken),
    outbox: createSyncOutbox({ store }),
    onQueued: (count, error) =>
      recordDiagnostic('sync.queued', 'warn', 'push queued; rows stay in the outbox', {
        count,
        code: error.code,
        status: error.status ?? null,
      }),
  });
};
