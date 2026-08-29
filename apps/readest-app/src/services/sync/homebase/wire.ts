/**
 * Readest ⇄ Homebase wire mapping (REVIEW-ONLY SPIKE).
 *
 * The type says `SyncData.books?: Partial<BookRecord>[]` and
 * `interface BookRecord extends BookDataRecord, Book` (`libs/sync.ts:47`, `:11`),
 * so a record MAY carry the snake_case identity half and the camelCase app half
 * together. At runtime the two directions differ, and the difference is the
 * whole reason this file exists:
 *
 *   PUSH — `useSync.pushChanges` hands the client raw `Book[]` / `BookConfig[]` /
 *     `BookNote[]` (`useSync.ts:288`, `:309`, `:334`). Camel half only. A `Book`
 *     has `hash`; it has no `book_hash` at all. Readest's own server survives
 *     this by running `transformBookToDB` on arrival (`pages/api/sync.ts:148`).
 *   PULL — the response is the merged record, and every case in `pull-books.json`
 *     emits both halves.
 *
 * Homebase keys its writes on `book_hash` (`push-configs.json`, `push-notes.json`).
 * Point a stock Readest at it and every push arrives with `book_hash: undefined`
 * — which upserts nothing, or matches nothing, and answers 200 either way. That
 * is the silent-success class the fixtures README warns about, and no amount of
 * server-side care fixes it from the far end.
 *
 * So the adapter's push job is an identity BACKFILL, not a transform: copy the
 * four identity fields across when they are missing, and leave every other field
 * exactly as the app wrote it. Nothing here imports `utils/transform.ts`; a
 * second camelCase↔snake_case conversion on the client would be one more place
 * for the two dialects to drift.
 *
 * Four smaller jobs ride along:
 *
 *   1. A device-local deny-list. `filePath` is one machine's disk layout and
 *      `audiobook` is a per-device pairing; a pass-through would ship both to
 *      every peer.
 *   2. `hb*` preservation. Homebase carries server-owned fields Readest has no
 *      schema for (a voice note's audio pointer, its duration, its transcript
 *      provenance). An unmodified Readest drops them; this adapter does not.
 *   3. `updated_at_ms`, the stats pull cursor, which is response-only.
 *   4. Clock coercion to epoch ms, so a server that answers in ISO cannot make
 *      the merge sort lexicographically.
 *
 * `user_id` is relayed when the app already holds one and never invented. The
 * fixtures show it in both directions, but Homebase MUST attribute writes from
 * the bearer token: a client-asserted owner is a privilege bug the moment
 * something trusts it.
 */

import type { SyncData, SyncResult, StatBookRecord, StatPageRecord } from '@/libs/sync';
import type {
  HomebaseBookRecord,
  HomebaseConfigRecord,
  HomebaseEnvelope,
  HomebaseNoteRecord,
  HomebaseStatBookRecord,
  HomebaseStatPageRecord,
} from './types';
import { HOMEBASE_WIRE_VERSION } from './types';

/**
 * Fields that must NEVER leave the device. `filePath`/`altFilePaths` are one
 * user's disk layout, `audiobook` is a per-device recording pairing Readest
 * already excludes from cloud sync, and the `lastSyncedAt*`/`lastPushedAt*`
 * pairs are this install's own cursors — pushing them would let one device
 * rewind another's sync state.
 */
export const DEVICE_LOCAL: ReadonlySet<string> = new Set([
  'filePath',
  'altFilePaths',
  'audiobook',
  'downloadedAt',
  'coverDownloadedAt',
  'lastSyncedAtConfig',
  'lastSyncedAtNotes',
  'lastPushedAtConfig',
  'lastPushedAtNotes',
]);

/** Clock fields carried as epoch ms. `synced_at`/`uploaded_at` are NOT here. */
const MS_CLOCKS = ['updated_at', 'deleted_at', 'createdAt', 'updatedAt', 'deletedAt'] as const;

/**
 * Coerce a clock to epoch ms. The fixtures pin numbers for these fields and
 * `BookDataRecord` declares `number | null`, but a server answering ISO is an
 * easy mistake to make and a hard one to see: `'2026-08-27...' > '2026-08-2...'`
 * compares as a string and the merge quietly picks the wrong row.
 */
const toMs = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = new Date(value).getTime();
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
};

const normalizeClocks = <T extends object>(record: T): T => {
  const out = { ...record } as Record<string, unknown>;
  for (const field of MS_CLOCKS) {
    if (field in out) out[field] = toMs(out[field]);
  }
  return out as T;
};

/**
 * Strip device-local keys and normalise clocks. Everything else — including
 * every `hb*` field and any key this client version has never heard of — is
 * relayed untouched, which is what makes the audio-note extension additive
 * rather than a schema negotiation.
 */
const encodeRecord = <T extends object>(record: T): T => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (DEVICE_LOCAL.has(key)) continue;
    if (value === undefined) continue;
    out[key] = value;
  }
  return normalizeClocks(out) as T;
};

/**
 * Copy `from` to `to` when `to` is missing. "Missing" is `undefined` or a key
 * that was never there — an explicit `null` is a real value (a live row's
 * `deleted_at`) and is left alone.
 */
const backfill = (rec: Record<string, unknown>, to: string, from: string): void => {
  if (rec[to] !== undefined) return;
  const value = rec[from];
  if (value === undefined) return;
  rec[to] = value;
};

/**
 * Derive the snake_case identity half from the camelCase app object, matching
 * what `transformBookToDB` / `transformBookConfigToDB` / `transformBookNoteToDB`
 * would have produced server-side. An existing snake_case value always wins:
 * a pull-then-push round trip must not have its identity rewritten by a
 * camelCase field that drifted.
 *
 * `deleted_at` is forced to null when neither dialect carries it, because a
 * live row and a row whose tombstone the client simply omitted are the same
 * thing to Readest and must not read as "no opinion" to an upserting server.
 */
const withIdentity = (record: object, hashKey: 'hash' | 'bookHash'): Record<string, unknown> => {
  const out = encodeRecord(record) as Record<string, unknown>;
  backfill(out, 'book_hash', hashKey);
  backfill(out, 'meta_hash', 'metaHash');
  backfill(out, 'updated_at', 'updatedAt');
  backfill(out, 'deleted_at', 'deletedAt');
  if (out['deleted_at'] === undefined) out['deleted_at'] = null;
  return normalizeClocks(out);
};

/**
 * A `Book` has `hash`; a `BookConfig` and a `BookNote` have `bookHash`. Neither
 * has `book_hash`, which is the column Homebase upserts on.
 */
export const encodeBook = (book: object): HomebaseBookRecord => {
  const out = withIdentity(book, 'hash');
  // Books and configs are one row per book, so the row id IS the book hash.
  // Notes carry their own ULID and are excluded from this.
  backfill(out, 'id', 'book_hash');
  return out as HomebaseBookRecord;
};

export const encodeConfig = (config: object): HomebaseConfigRecord => {
  const out = withIdentity(config, 'bookHash');
  backfill(out, 'id', 'book_hash');
  return out as HomebaseConfigRecord;
};

/** A note's `id` is client-generated and already present; only the hashes need it. */
export const encodeNote = (note: object): HomebaseNoteRecord =>
  withIdentity(note, 'bookHash') as HomebaseNoteRecord;

/**
 * Stat records carry ISO `updated_at`, unlike the other three families — see
 * `StatBookRecord` / `StatPageRecord` in `libs/sync.ts`. `updated_at_ms` is a
 * RESPONSE-only cursor field and is never sent upward.
 */
export const encodeStatBook = (rec: StatBookRecord): HomebaseStatBookRecord => {
  const { updated_at_ms: _ms, ...rest } = rec;
  return rest;
};

export const encodeStatPage = (rec: StatPageRecord): HomebaseStatPageRecord => {
  const { updated_at_ms: _ms, ...rest } = rec;
  return rest;
};

/** A push payload in Readest's shape → one Homebase envelope. */
export const encodeSyncData = (payload: SyncData): HomebaseEnvelope => {
  const env: HomebaseEnvelope = { schema_version: HOMEBASE_WIRE_VERSION };
  if (payload.books) env.books = payload.books.map(encodeBook);
  if (payload.configs) env.configs = payload.configs.map(encodeConfig);
  if (payload.notes) env.notes = payload.notes.map(encodeNote);
  if (payload.statBooks) env.statBooks = payload.statBooks.map(encodeStatBook);
  if (payload.statPages) env.statPages = payload.statPages.map(encodeStatPage);
  return env;
};

/**
 * `updated_at_ms` is what `pullStats` reduces over to advance its cursor
 * (`statsSync.ts:89`). The Readest server attaches it on the GET; a Homebase
 * adapter that forgot it would leave the stats cursor pinned and re-pull the
 * whole history on every sync — silently, because the loop's own break
 * condition (`newest <= since`) would just fire on the first page forever.
 */
const withUpdatedAtMs = <T extends { updated_at?: string | null; updated_at_ms?: number }>(
  rows: T[] | null,
): T[] | null =>
  rows === null
    ? null
    : rows.map((row) => ({
        ...row,
        updated_at_ms: row.updated_at_ms ?? (row.updated_at ? Date.parse(row.updated_at) : 0),
      }));

const decodeRows = <T extends object>(rows: T[] | null | undefined): T[] | null =>
  rows ? rows.map(normalizeClocks) : null;

/**
 * Homebase rows → `SyncResult`, which is the same merged record shape they
 * arrive in. The casts are shape assertions across `Partial<>`, not conversions:
 * `SyncResult` requires the full record where a pull legitimately omits fields
 * the row does not have (`pull-configs.json` emits no `progress` when the page
 * count is unknown, on the grounds that a fabricated page number is worse than
 * none).
 */
export const decodeEnvelope = (env: HomebaseEnvelope): SyncResult => ({
  books: decodeRows(env.books) as unknown as SyncResult['books'],
  configs: decodeRows(env.configs) as unknown as SyncResult['configs'],
  notes: decodeRows(env.notes) as unknown as SyncResult['notes'],
  statBooks: withUpdatedAtMs<StatBookRecord>(
    (env.statBooks ?? null) as StatBookRecord[] | null,
  ) as SyncResult['statBooks'],
  statPages: withUpdatedAtMs<StatPageRecord>(
    (env.statPages ?? null) as StatPageRecord[] | null,
  ) as SyncResult['statPages'],
});
