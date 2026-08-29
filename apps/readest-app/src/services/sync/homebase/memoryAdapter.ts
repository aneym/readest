/**
 * In-memory {@link HomebaseSyncAdapter} (REVIEW-ONLY SPIKE).
 *
 * Two jobs. First, it is the SECOND implementation the shared contract suite
 * runs against — a contract exercised by exactly one implementation only
 * documents that implementation's wire quirks. Second, it is a usable reference
 * server: it applies the same merge rules as `clocks.ts`, so the spike can
 * demonstrate tombstones, per-field clocks and a resumable cursor end to end
 * without a Homebase deployment existing yet.
 *
 * The one structural thing it has to get right, and the thing most likely to
 * bite a real implementation, is that THE FIVE CHANNELS DO NOT SHARE A CLOCK
 * DIALECT:
 *
 *   books / configs / notes — `updated_at` is epoch ms, and the pull cursor is
 *     the server's own `synced_at` (ISO), stamped on receipt. Using the client's
 *     `updated_at` as the cursor means a device with a fast clock stops
 *     receiving its own writes (#4678).
 *   statBooks / statPages — `updated_at` is ISO (`libs/sync.ts:20`, `:32`) and
 *     the cursor is `updated_at_ms`, which `statsSync.pullStats` reduces over.
 *     There is no `synced_at` on a stat row, so receipt time is stamped into
 *     `updated_at`/`updated_at_ms` directly.
 *
 * It is NOT a specification of the real server. Where it had to invent
 * behaviour, `docs/homebase/prototype-report.md` records the assumption.
 */

import {
  HomebaseSyncError,
  type HomebaseCapabilities,
  type HomebasePullQuery,
  type HomebaseSyncAdapter,
} from './adapter';
import { clockMs, mergeBookRecord, mergeRowLww, resolveAnnotation } from './clocks';
import {
  HOMEBASE_CHANNELS,
  HOMEBASE_WIRE_VERSION,
  type HomebaseBookRecord,
  type HomebaseChannel,
  type HomebaseEnvelope,
  type HomebaseNoteRecord,
  type HomebaseRecord,
  type HomebaseStatBookRecord,
} from './types';

export interface MemoryAdapterOptions {
  capabilities?: Partial<HomebaseCapabilities> | null;
  /** Injectable clock so receipt stamps are deterministic in tests. */
  now?: () => number;
  /** Force calls to fail with this error until cleared (offline simulation). */
  failNext?: HomebaseSyncError | null;
}

const isStatsChannel = (channel: HomebaseChannel): boolean =>
  channel === 'statBooks' || channel === 'statPages';

/**
 * Primary key per channel. Books/configs/stat-books are one row per book;
 * notes are `(book_hash, id)`; stat pages are `(book_hash, page, start_time)`.
 * These mirror the upsert keys the Readest server uses, so a device cannot
 * produce a duplicate here that the real server would have collapsed.
 */
const primaryKey = (channel: HomebaseChannel, rec: HomebaseRecord): string => {
  const hash = rec.book_hash ?? '';
  if (channel === 'notes') return `${hash}:${(rec as HomebaseNoteRecord).id ?? ''}`;
  if (channel === 'statPages') {
    const p = rec as { page?: number; start_time?: number };
    return `${hash}:${p.page}:${p.start_time}`;
  }
  return hash;
};

/**
 * Apply the right authority per channel.
 *
 * The two ladders break ties in OPPOSITE directions, and both are correct:
 * Readest's row LWW favours the incoming push on an exact tie, matching its own
 * server's `>=`; Homebase's annotation ladder falls through `deviceSeq` then
 * `device` and only then keeps the STORED row, so an unresolvable tie does not
 * churn (`merge-cases.json`). Hence the argument order flips for notes.
 */
const mergeFor = (
  channel: HomebaseChannel,
  incoming: HomebaseRecord,
  stored: HomebaseRecord,
): HomebaseRecord => {
  if (channel === 'books') {
    return mergeBookRecord(incoming as HomebaseBookRecord, stored as HomebaseBookRecord);
  }
  if (channel === 'notes') {
    return resolveAnnotation(stored as HomebaseNoteRecord, incoming as HomebaseNoteRecord);
  }
  return mergeRowLww(incoming, stored);
};

/**
 * A row as the reference server holds it: the channel's own record plus the two
 * fields the server owns. The intersection distributes over the union, so both
 * cursor fields are writable whichever family the row belongs to.
 */
type StoredRow = HomebaseRecord & { synced_at?: string | null; updated_at_ms?: number };

/**
 * Stamp server receipt time in whichever field this channel's cursor reads.
 *
 * Client timestamps are never rewritten. `updated_at` means "when the user
 * changed this", and a server that overwrites it destroys the only input the
 * merge has; the server's own opinion goes in `synced_at` / `updated_at_ms`,
 * which is exactly the split #4678 introduced.
 */
const stampReceipt = (channel: HomebaseChannel, rec: HomebaseRecord, at: number): StoredRow =>
  isStatsChannel(channel)
    ? { ...rec, updated_at_ms: at }
    : { ...rec, synced_at: new Date(at).toISOString() };

/** Server receipt time in ms — what `since` is compared against. */
const receiptMs = (channel: HomebaseChannel, rec: HomebaseRecord): number => {
  const row = rec as StoredRow & HomebaseStatBookRecord;
  if (isStatsChannel(channel)) return row.updated_at_ms ?? clockMs(row.updated_at);
  return clockMs(row.synced_at) || clockMs(row.updated_at);
};

export interface MemoryHomebaseServer extends HomebaseSyncAdapter {
  /** Direct row access, for asserting server state in tests. */
  rows(channel: HomebaseChannel): HomebaseRecord[];
  /** Seed the store as if another device had already pushed. */
  seed(channel: HomebaseChannel, records: HomebaseRecord[]): void;
  /** Make the next `count` calls throw `error`. */
  failNext(error: HomebaseSyncError, count?: number): void;
  /** Every push the server accepted, in order — proves outbox coalescing. */
  readonly pushLog: HomebaseEnvelope[];
}

export const createMemoryHomebaseAdapter = (
  options: MemoryAdapterOptions = {},
): MemoryHomebaseServer => {
  const now = options.now ?? (() => Date.now());
  const store = new Map<HomebaseChannel, Map<string, HomebaseRecord>>();
  for (const channel of HOMEBASE_CHANNELS) store.set(channel, new Map());
  const pushLog: HomebaseEnvelope[] = [];
  let pendingFailure: { error: HomebaseSyncError; count: number } | null = options.failNext
    ? { error: options.failNext, count: Number.POSITIVE_INFINITY }
    : null;

  const bucketOf = (channel: HomebaseChannel): Map<string, HomebaseRecord> => {
    const bucket = store.get(channel);
    if (!bucket) throw new Error(`unknown channel: ${channel}`);
    return bucket;
  };

  const gate = () => {
    if (!pendingFailure) return;
    const { error } = pendingFailure;
    pendingFailure.count -= 1;
    if (pendingFailure.count <= 0) pendingFailure = null;
    throw error;
  };

  const channelsFor = (query: HomebasePullQuery): HomebaseChannel[] => {
    if (!query.channel) return [...HOMEBASE_CHANNELS];
    // `SyncType` collapses both stat families into one 'stats' selector, which
    // the client still passes through (`statsSync.pullStats`). Expand it here
    // rather than making every caller know the split.
    if (query.channel === 'stats') return ['statBooks', 'statPages'];
    return [query.channel];
  };

  return {
    endpointId: 'memory://homebase',
    pushLog,

    rows: (channel) => [...bucketOf(channel).values()],

    seed: (channel, records) => {
      const bucket = bucketOf(channel);
      for (const rec of records) {
        const stamped = receiptMs(channel, rec) > 0 ? rec : stampReceipt(channel, rec, now());
        bucket.set(primaryKey(channel, rec), stamped);
      }
    },

    failNext: (error, count = 1) => {
      pendingFailure = { error, count };
    },

    async capabilities() {
      gate();
      if (options.capabilities === null) return null;
      return {
        channels: options.capabilities?.channels ?? HOMEBASE_CHANNELS,
        storage: options.capabilities?.storage ?? true,
        noteAudio: options.capabilities?.noteAudio ?? true,
        schemaVersion: options.capabilities?.schemaVersion ?? HOMEBASE_WIRE_VERSION,
      };
    },

    async pull(query) {
      gate();
      const envelope: HomebaseEnvelope = {
        schema_version: HOMEBASE_WIRE_VERSION,
        server_time: new Date(now()).toISOString(),
      };
      for (const channel of channelsFor(query)) {
        let rows = [...bucketOf(channel).values()]
          // Tombstoned rows ARE returned: a peer that never sees the delete
          // event keeps the row forever. Filtering deletes out here is the
          // classic sync bug this comment exists to prevent.
          .filter((rec) => receiptMs(channel, rec) > query.since)
          .sort((a, b) => receiptMs(channel, a) - receiptMs(channel, b));
        if (query.bookHash) rows = rows.filter((rec) => rec.book_hash === query.bookHash);
        if (query.metaHash) {
          rows = rows.filter((rec) => (rec as HomebaseBookRecord).meta_hash === query.metaHash);
        }
        if (query.limit && query.limit > 0) rows = rows.slice(0, query.limit);
        setChannel(envelope, channel, rows);
      }
      return envelope;
    },

    async push(envelope) {
      gate();
      pushLog.push(envelope);
      const applied: HomebaseEnvelope = {
        schema_version: HOMEBASE_WIRE_VERSION,
        server_time: new Date(now()).toISOString(),
      };
      for (const channel of HOMEBASE_CHANNELS) {
        const incoming = readChannel(envelope, channel);
        if (!incoming) continue;
        const bucket = bucketOf(channel);
        const out: HomebaseRecord[] = [];
        for (const rec of incoming) {
          const key = primaryKey(channel, rec);
          const stored = bucket.get(key);
          const merged = stored ? mergeFor(channel, rec, stored) : rec;
          // Receipt time is stamped on every accepted write INCLUDING a merge
          // the client lost — that is what propagates the server's answer back
          // without touching `updated_at` and reordering a date-sorted library.
          const next = stampReceipt(channel, merged, now());
          bucket.set(key, next);
          out.push(next);
        }
        setChannel(applied, channel, out);
      }
      return applied;
    },
  };
};

/**
 * Channel access on an envelope. The five channel keys are all optional arrays
 * of different record types, so a plain `env[channel]` does not narrow; these
 * two helpers keep the cast in one place instead of at every call site.
 */
const readChannel = (
  env: HomebaseEnvelope,
  channel: HomebaseChannel,
): HomebaseRecord[] | undefined => {
  const rows = (env as Record<string, unknown>)[channel];
  return Array.isArray(rows) ? (rows as HomebaseRecord[]) : undefined;
};

const setChannel = (env: HomebaseEnvelope, channel: HomebaseChannel, rows: HomebaseRecord[]) => {
  (env as Record<string, unknown>)[channel] = rows;
};
