/** Durable write-ahead sync queue. Coalesce by identity, serialize store
 * mutations, and remove only acknowledged revisions. Retryable and auth
 * failures remain queued; permanent row failures remain recoverable. */

import { HomebaseSyncError } from './adapter';
import { clockMs } from './clocks';
import type { HomebaseChannel, HomebaseEnvelope, HomebaseRecord } from './types';
import { HOMEBASE_CHANNELS } from './types';

export interface OutboxEntry {
  /** `${channel}:${primaryKey}` — the coalescing key. */
  key: string;
  channel: HomebaseChannel;
  record: HomebaseRecord;
  /** Local enqueue time, the flush ordering key. */
  queuedAt: number;
  attempts: number;
  revision?: number;
  /** Set only for a permanent record failure; transient retries never expire. */
  poisoned?: boolean;
  lastError?: string;
  lastErrorCode?: string;
}

export interface OutboxStore {
  read(): Promise<OutboxEntry[]>;
  write(entries: OutboxEntry[]): Promise<void>;
}

export const createMemoryOutboxStore = (initial: OutboxEntry[] = []): OutboxStore => {
  let entries = [...initial];
  return {
    read: async () => [...entries],
    write: async (next) => {
      entries = [...next];
    },
  };
};

export const isDefiniteRejection = (error: HomebaseSyncError): boolean =>
  error.status !== undefined && [400, 404, 409, 422].includes(error.status);

export interface FlushResult {
  pushed: number;
  /** Entries still queued (a retryable failure stopped the drain). */
  remaining: number;
  poisoned: OutboxEntry[];
  /** The failure that stopped this flush, if one did. */
  stoppedBy?: HomebaseSyncError;
}

export interface OutboxOptions {
  store: OutboxStore;
  /** Rows per push request. Mirrors `statsSync`'s PUSH_CHUNK bound. */
  batchSize?: number;
  /** Deprecated compatibility option; transient failures never expire. */
  maxAttempts?: number;
  now?: () => number;
}

/** Same keys as the server's upsert keys — see `memoryAdapter.primaryKey`. */
export const outboxKey = (channel: HomebaseChannel, rec: HomebaseRecord): string => {
  if (channel === 'notes') return `notes:${rec.book_hash}:${(rec as { id: string }).id}`;
  if (channel === 'statPages') {
    const p = rec as unknown as { page: number; start_time: number };
    return `statPages:${rec.book_hash}:${p.page}:${p.start_time}`;
  }
  return `${channel}:${rec.book_hash}`;
};

export interface SyncOutbox {
  enqueue(channel: HomebaseChannel, records: HomebaseRecord[]): Promise<void>;
  /** Enqueue a whole push payload — the shape `pushChanges` receives. */
  enqueueEnvelope(envelope: HomebaseEnvelope, failedWith?: HomebaseSyncError): Promise<void>;
  flush(push: (envelope: HomebaseEnvelope) => Promise<unknown>): Promise<FlushResult>;
  pending(): Promise<OutboxEntry[]>;
  /** Drop poisoned entries once the caller has reported them. */
  clearPoisoned(): Promise<OutboxEntry[]>;
}

// One serialized store transaction chain and drain per store instance. Network
// requests never hold the transaction lock: edits can persist while offline.
const transactions = new WeakMap<OutboxStore, Promise<unknown>>();
const drains = new WeakMap<OutboxStore, Promise<FlushResult>>();
export const createSyncOutbox = (options: OutboxOptions): SyncOutbox => {
  const { store } = options;
  const batchSize = Math.max(1, options.batchSize ?? 500);
  const now = options.now ?? Date.now;
  const transaction = <T>(run: () => Promise<T>): Promise<T> => {
    const next = (transactions.get(store) ?? Promise.resolve()).then(run, run);
    transactions.set(
      store,
      next.catch(() => undefined),
    );
    return next;
  };
  const sameRevision = (a: OutboxEntry, b: OutboxEntry) =>
    a.key === b.key &&
    a.revision === b.revision &&
    JSON.stringify(a.record) === JSON.stringify(b.record);
  const box: SyncOutbox = {
    enqueue(channel, records) {
      return transaction(async () => {
        const entries = await store.read();
        const byKey = new Map(entries.map((entry) => [entry.key, entry]));
        for (const record of records) {
          const key = outboxKey(channel, record),
            existing = byKey.get(key);
          if (existing && clockMs(record.updated_at) < clockMs(existing.record.updated_at))
            continue;
          byKey.set(key, {
            key,
            channel,
            record: structuredClone(record),
            queuedAt: existing?.queuedAt ?? now(),
            attempts: 0,
            revision: (existing?.revision ?? 0) + 1,
          });
        }
        await store.write([...byKey.values()].sort((a, b) => a.queuedAt - b.queuedAt));
      });
    },
    async enqueueEnvelope(envelope, failedWith) {
      for (const channel of HOMEBASE_CHANNELS) {
        const records = envelope[channel] as HomebaseRecord[] | null | undefined;
        if (records?.length) await box.enqueue(channel, records);
      }
      if (failedWith) {
        const keys = new Set(
          HOMEBASE_CHANNELS.flatMap((channel) =>
            ((envelope[channel] ?? []) as HomebaseRecord[]).map((record) =>
              outboxKey(channel, record),
            ),
          ),
        );
        await transaction(async () => {
          const entries = await store.read();
          await store.write(
            entries.map((entry) =>
              keys.has(entry.key)
                ? {
                    ...entry,
                    attempts: entry.attempts + 1,
                    lastError: failedWith.message,
                    lastErrorCode: failedWith.code,
                  }
                : entry,
            ),
          );
        });
      }
    },
    pending: () => transaction(async () => (await store.read()).filter((entry) => !entry.poisoned)),
    clearPoisoned: () =>
      transaction(async () => {
        const entries = await store.read();
        await store.write(entries.filter((entry) => !entry.poisoned));
        return entries.filter((entry) => entry.poisoned);
      }),
    flush(push) {
      const running = drains.get(store);
      if (running) return running;
      const drain = (async (): Promise<FlushResult> => {
        const snapshot = await transaction(() => store.read());
        const queue = snapshot.filter((entry) => !entry.poisoned);
        let pushed = 0,
          stoppedBy: HomebaseSyncError | undefined;
        for (let index = 0; index < queue.length; index += batchSize) {
          const batch = queue.slice(index, index + batchSize);
          const envelope: HomebaseEnvelope = {};
          for (const entry of batch) {
            const target = envelope as Record<string, HomebaseRecord[]>;
            (target[entry.channel] ??= []).push(entry.record);
          }
          try {
            await push(envelope);
            // Delete only the exact revision acknowledged; a newer edit stays.
            await transaction(async () => {
              const live = await store.read();
              await store.write(
                live.filter((entry) => !batch.some((sent) => sameRevision(entry, sent))),
              );
            });
            pushed += batch.length;
          } catch (err) {
            stoppedBy =
              err instanceof HomebaseSyncError
                ? err
                : new HomebaseSyncError(
                    err instanceof Error ? err.message : String(err),
                    'NETWORK',
                  );
            const error = stoppedBy;
            await transaction(async () => {
              const live = await store.read();
              await store.write(
                live.map((entry) =>
                  batch.some((sent) => sameRevision(entry, sent))
                    ? {
                        ...entry,
                        attempts: entry.attempts + 1,
                        lastError: error.message,
                        lastErrorCode: error.code,
                        // Only an explicit client rejection is terminal. Unknown
                        // failures and auth pauses retain the durable row.
                        poisoned: isDefiniteRejection(error),
                      }
                    : entry,
                ),
              );
            });
            break;
          }
        }
        const live = await transaction(() => store.read());
        return {
          pushed,
          remaining: live.filter((e) => !e.poisoned).length,
          poisoned: live.filter((e) => e.poisoned),
          ...(stoppedBy ? { stoppedBy } : {}),
        };
      })();
      drains.set(store, drain);
      void drain
        .finally(() => {
          if (drains.get(store) === drain) drains.delete(store);
        })
        .catch(() => undefined);
      return drain;
    },
  };
  return box;
};
