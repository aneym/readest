/**
 * Offline outbox for Homebase pushes (REVIEW-ONLY SPIKE).
 *
 * Readest's stock client has no outbox: `useSync.pushChanges` catches the error,
 * sets `syncError`, and the write is gone until something else happens to touch
 * the same record. That is survivable against Readest Cloud because the reader
 * re-pushes a book's config on most interactions — but it is not survivable for
 * a canonical store. A highlight made on a train is a highlight the household
 * ledger must eventually get.
 *
 * Rules, in the order they matter:
 *
 *   1. COALESCE. One entry per (channel, primary key). A page-turn every few
 *      seconds for twenty minutes offline must not become 400 queued rows —
 *      it is one row whose `updated_at` moved. Last write wins locally by the
 *      same clocks the server uses (`clocks.ts`), so coalescing cannot pick a
 *      different winner than a server-side merge would have.
 *   2. ORDER. Flush is sequential and stops at the first retryable failure.
 *      Draining past a failure would let a later write land before an earlier
 *      one, and the server's LWW would then keep the wrong row.
 *   3. BOUND. `maxAttempts` poisons an entry that keeps failing permanently, so
 *      one malformed record cannot wedge the queue forever. Poisoned entries
 *      are surfaced, not silently dropped.
 *
 * The store is injectable so the spike can run in memory while a real landing
 * persists to the same place `useSync` already writes settings.
 */

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
  /** Set once the entry exceeded `maxAttempts` or hit a permanent failure. */
  poisoned?: boolean;
  lastError?: string;
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
  enqueueEnvelope(envelope: HomebaseEnvelope): Promise<void>;
  flush(push: (envelope: HomebaseEnvelope) => Promise<unknown>): Promise<FlushResult>;
  pending(): Promise<OutboxEntry[]>;
  /** Drop poisoned entries once the caller has reported them. */
  clearPoisoned(): Promise<OutboxEntry[]>;
}

export const createSyncOutbox = (options: OutboxOptions): SyncOutbox => {
  const { store } = options;
  const batchSize = options.batchSize ?? 500;
  const maxAttempts = options.maxAttempts ?? 5;
  const now = options.now ?? (() => Date.now());

  const merge = (existing: OutboxEntry | undefined, next: OutboxEntry): OutboxEntry => {
    if (!existing) return next;
    // Keep the ORIGINAL queuedAt so coalescing cannot push an old write to the
    // back of the queue and reorder it behind a newer one for another book.
    const winner =
      clockMs(next.record.updated_at) >= clockMs(existing.record.updated_at) ? next : existing;
    return { ...winner, queuedAt: existing.queuedAt, attempts: existing.attempts };
  };

  const load = async () => await store.read();

  return {
    async enqueue(channel, records) {
      const entries = await load();
      const byKey = new Map(entries.map((e) => [e.key, e]));
      for (const record of records) {
        const key = outboxKey(channel, record);
        byKey.set(
          key,
          merge(byKey.get(key), { key, channel, record, queuedAt: now(), attempts: 0 }),
        );
      }
      await store.write([...byKey.values()].sort((a, b) => a.queuedAt - b.queuedAt));
    },

    async enqueueEnvelope(envelope) {
      for (const channel of HOMEBASE_CHANNELS) {
        const records = (envelope as Record<string, unknown>)[channel] as
          | HomebaseRecord[]
          | undefined;
        if (records?.length) await this.enqueue(channel, records);
      }
    },

    async pending() {
      return (await load()).filter((e) => !e.poisoned);
    },

    async clearPoisoned() {
      const entries = await load();
      const poisoned = entries.filter((e) => e.poisoned);
      await store.write(entries.filter((e) => !e.poisoned));
      return poisoned;
    },

    async flush(push) {
      const entries = await load();
      const queue = entries.filter((e) => !e.poisoned).sort((a, b) => a.queuedAt - b.queuedAt);
      const poisoned = entries.filter((e) => e.poisoned);
      let pushed = 0;
      let stoppedBy: HomebaseSyncError | undefined;
      let index = 0;

      while (index < queue.length && !stoppedBy) {
        const batch = queue.slice(index, index + batchSize);
        const envelope: HomebaseEnvelope = {};
        for (const entry of batch) {
          const bucket = ((envelope as Record<string, unknown>)[entry.channel] ??=
            []) as HomebaseRecord[];
          bucket.push(entry.record);
        }
        try {
          await push(envelope);
          pushed += batch.length;
          index += batch.length;
        } catch (err) {
          const error =
            err instanceof HomebaseSyncError
              ? err
              : new HomebaseSyncError(err instanceof Error ? err.message : String(err));
          for (const entry of batch) {
            entry.attempts += 1;
            entry.lastError = error.message;
            // A permanent failure (bad request, auth revoked for this row) or a
            // spent attempt budget poisons the entry. Everything else stays
            // queued exactly where it is — the drain stops here so ordering
            // holds, and the next flush resumes from this batch.
            if (!error.retryable || entry.attempts >= maxAttempts) entry.poisoned = true;
          }
          stoppedBy = error;
        }
      }

      const remaining = queue.slice(index).filter((e) => !e.poisoned);
      const newlyPoisoned = queue.slice(index).filter((e) => e.poisoned);
      await store.write([...remaining, ...poisoned, ...newlyPoisoned]);
      return {
        pushed,
        remaining: remaining.length,
        poisoned: [...poisoned, ...newlyPoisoned],
        ...(stoppedBy ? { stoppedBy } : {}),
      };
    },
  };
};
