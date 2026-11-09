import { HomebaseSyncError } from './adapter';
import type { HomebaseChannel, HomebaseEnvelope, HomebaseRecord, HomebaseRejection } from './types';
import { channelRecords, HOMEBASE_CHANNELS } from './types';

export interface OutboxEntry {
  key: string;
  channel: HomebaseChannel;
  record: HomebaseRecord;
  queuedAt: number;
  attempts: number;
  revision?: number;
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

export const toSyncError = (err: unknown, code: HomebaseSyncError['code'] = 'UNKNOWN') =>
  err instanceof HomebaseSyncError
    ? err
    : new HomebaseSyncError(err instanceof Error ? err.message : String(err), code);

export interface FlushResult {
  pushed: number;
  remaining: number;
  poisoned: OutboxEntry[];
  newlyPoisoned: number;
  stoppedBy?: HomebaseSyncError;
}

export interface OutboxOptions {
  store: OutboxStore;
  batchSize?: number;
  now?: () => number;
}

const clockMs = (at?: number | string | null): number =>
  at === null || at === undefined ? 0 : typeof at === 'number' ? at : new Date(at).getTime();

export const outboxKey = (channel: HomebaseChannel, rec: HomebaseRecord): string => {
  if (channel === 'notes') return `notes:${rec.book_hash}:${(rec as { id: string }).id}`;
  if (channel === 'statPages') {
    const p = rec as unknown as { page: number; start_time: number };
    return `statPages:${rec.book_hash}:${p.page}:${p.start_time}`;
  }
  return `${channel}:${rec.book_hash}`;
};

export const rejectionKey = (family: string, id: string): string => {
  const canonical = { books: 'book', configs: 'config', notes: 'note' }[family] ?? family;
  return `${canonical}/${id}`;
};

export const recordRejectionKey = (channel: HomebaseChannel, rec: HomebaseRecord): string => {
  const row = rec as { book_hash?: string; bookHash?: string; id?: string };
  return rejectionKey(
    channel,
    channel === 'configs'
      ? (row.book_hash ?? row.bookHash ?? row.id ?? '')
      : (row.id ?? row.book_hash ?? ''),
  );
};

export const envelopeRejectionKeys = (envelope: HomebaseEnvelope): string[] =>
  HOMEBASE_CHANNELS.flatMap((channel) =>
    channelRecords(envelope, channel).map((record) => recordRejectionKey(channel, record)),
  );

const envelopeOutboxKeys = (envelope: HomebaseEnvelope, skip: Set<string> = new Set()) =>
  new Set(
    HOMEBASE_CHANNELS.flatMap((channel) =>
      channelRecords(envelope, channel)
        .filter((record) => !skip.has(recordRejectionKey(channel, record)))
        .map((record) => outboxKey(channel, record)),
    ),
  );

const rejectionsOf = (response: unknown): HomebaseRejection[] => {
  const rows = (response as { rejected?: unknown } | null | undefined)?.rejected;
  return Array.isArray(rows) ? (rows as HomebaseRejection[]) : [];
};

const failed = (entry: OutboxEntry, error: string, code: string, poisoned?: boolean) => ({
  ...entry,
  attempts: entry.attempts + 1,
  lastError: error,
  lastErrorCode: code,
  ...(poisoned === undefined ? {} : { poisoned }),
});

export interface SyncOutbox {
  enqueue(channel: HomebaseChannel, records: HomebaseRecord[]): Promise<void>;
  enqueueEnvelope(envelope: HomebaseEnvelope, failedWith?: HomebaseSyncError): Promise<void>;
  flush(push: (envelope: HomebaseEnvelope) => Promise<unknown>): Promise<FlushResult>;
  pending(): Promise<OutboxEntry[]>;
  settleAccepted(
    envelope: HomebaseEnvelope,
    rejected: HomebaseRejection[] | undefined,
  ): Promise<OutboxEntry[]>;
  requeueBlocked(): Promise<number>;
}

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
  const update = (map: (entries: OutboxEntry[]) => OutboxEntry[]) =>
    transaction(async () => {
      const entries = map(await store.read());
      await store.write(entries);
      return entries;
    });
  const sameRevision = (a: OutboxEntry, b: OutboxEntry) =>
    a.key === b.key &&
    a.revision === b.revision &&
    JSON.stringify(a.record) === JSON.stringify(b.record);

  const enqueue = async (channel: HomebaseChannel, records: HomebaseRecord[]) => {
    await update((entries) => {
      const byKey = new Map(entries.map((entry) => [entry.key, entry]));
      for (const record of records) {
        const key = outboxKey(channel, record);
        const existing = byKey.get(key);
        if (existing && clockMs(record.updated_at) < clockMs(existing.record.updated_at)) continue;
        byKey.set(key, {
          key,
          channel,
          record: structuredClone(record),
          queuedAt: existing?.queuedAt ?? now(),
          attempts: 0,
          revision: (existing?.revision ?? 0) + 1,
        });
      }
      return [...byKey.values()].sort((a, b) => a.queuedAt - b.queuedAt);
    });
  };

  const drain = async (push: (envelope: HomebaseEnvelope) => Promise<unknown>) => {
    const queue = (await transaction(() => store.read())).filter((entry) => !entry.poisoned);
    let pushed = 0;
    let newlyPoisoned = 0;
    let stoppedBy: HomebaseSyncError | undefined;
    for (let index = 0; index < queue.length && !stoppedBy; index += batchSize) {
      const batch = queue.slice(index, index + batchSize);
      const inBatch = (entry: OutboxEntry) => batch.some((sent) => sameRevision(entry, sent));
      const envelope: HomebaseEnvelope = {};
      for (const entry of batch) {
        ((envelope as Record<string, HomebaseRecord[]>)[entry.channel] ??= []).push(entry.record);
      }
      try {
        const response = await push(envelope);
        const rejected = new Map(
          rejectionsOf(response).map((row) => [rejectionKey(row.family, row.id), row.reason]),
        );
        const reasonFor = (entry: OutboxEntry) =>
          rejected.get(recordRejectionKey(entry.channel, entry.record));
        pushed += batch.filter((sent) => reasonFor(sent) === undefined).length;
        await update((live) =>
          live.flatMap((entry) => {
            if (!inBatch(entry)) return [entry];
            const reason = reasonFor(entry);
            if (reason === undefined) return [];
            newlyPoisoned += 1;
            return [failed(entry, reason, 'REJECTED', true)];
          }),
        );
      } catch (err) {
        const error = toSyncError(err, 'NETWORK');
        const poisons = isDefiniteRejection(error);
        stoppedBy = error;
        await update((live) =>
          live.map((entry) => {
            if (!inBatch(entry)) return entry;
            if (poisons) newlyPoisoned += 1;
            return failed(entry, error.message, error.code, poisons);
          }),
        );
      }
    }
    const live = await transaction(() => store.read());
    const result: FlushResult = {
      pushed,
      remaining: live.filter((e) => !e.poisoned).length,
      poisoned: live.filter((e) => e.poisoned),
      newlyPoisoned,
      ...(stoppedBy ? { stoppedBy } : {}),
    };
    return result;
  };

  return {
    enqueue,
    async enqueueEnvelope(envelope, failedWith) {
      for (const channel of HOMEBASE_CHANNELS) {
        const records = channelRecords(envelope, channel);
        if (records.length) await enqueue(channel, records);
      }
      if (!failedWith) return;
      const keys = envelopeOutboxKeys(envelope);
      await update((entries) =>
        entries.map((entry) =>
          keys.has(entry.key) ? failed(entry, failedWith.message, failedWith.code) : entry,
        ),
      );
    },
    pending: () => transaction(async () => (await store.read()).filter((entry) => !entry.poisoned)),
    settleAccepted: (envelope, rejected) => {
      const accepted = envelopeOutboxKeys(
        envelope,
        new Set((rejected ?? []).map((row) => rejectionKey(row.family, row.id))),
      );
      return update((entries) =>
        entries.filter((entry) => !entry.poisoned || !accepted.has(entry.key)),
      );
    },
    requeueBlocked: async () => {
      let count = 0;
      await update((entries) =>
        entries.map((entry) => {
          if (!entry.poisoned) return entry;
          count += 1;
          return { ...entry, poisoned: false };
        }),
      );
      return count;
    },
    flush(push) {
      const running = drains.get(store);
      if (running) return running;
      const run = drain(push);
      drains.set(store, run);
      void run
        .finally(() => {
          if (drains.get(store) === run) drains.delete(store);
        })
        .catch(() => undefined);
      return run;
    },
  };
};
