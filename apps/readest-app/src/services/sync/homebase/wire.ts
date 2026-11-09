import type { SyncData, SyncResult, StatBookRecord, StatPageRecord } from '@/libs/sync';
import type {
  HomebaseBookRecord,
  HomebaseConfigRecord,
  HomebaseEnvelope,
  HomebaseNoteRecord,
} from './types';
import { HOMEBASE_WIRE_VERSION } from './types';

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

const MS_CLOCKS = ['updated_at', 'deleted_at', 'createdAt', 'updatedAt', 'deletedAt'] as const;

const toMs = (value: unknown): number | null => {
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

const backfill = (rec: Record<string, unknown>, to: string, from: string): void => {
  if (rec[to] === undefined && rec[from] !== undefined) rec[to] = rec[from];
};

const withIdentity = (record: object, hashKey: 'hash' | 'bookHash'): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!DEVICE_LOCAL.has(key) && value !== undefined) out[key] = value;
  }
  backfill(out, 'book_hash', hashKey);
  backfill(out, 'meta_hash', 'metaHash');
  backfill(out, 'updated_at', 'updatedAt');
  backfill(out, 'deleted_at', 'deletedAt');
  out['deleted_at'] ??= null;
  return normalizeClocks(out);
};

export const encodeBook = (book: object): HomebaseBookRecord => {
  const out = withIdentity(book, 'hash');
  backfill(out, 'id', 'book_hash');
  return out as HomebaseBookRecord;
};

export const encodeConfig = (config: object): HomebaseConfigRecord => {
  const out = withIdentity(config, 'bookHash');
  backfill(out, 'id', 'book_hash');
  return out as HomebaseConfigRecord;
};

export const encodeNote = (note: object): HomebaseNoteRecord =>
  withIdentity(note, 'bookHash') as HomebaseNoteRecord;

export const encodeStat = <T extends { updated_at_ms?: number }>({
  updated_at_ms: _ms,
  ...rest
}: T): Omit<T, 'updated_at_ms'> => rest;

export const encodeSyncData = (payload: SyncData): HomebaseEnvelope => {
  const env: HomebaseEnvelope = { schema_version: HOMEBASE_WIRE_VERSION };
  if (payload.books) env.books = payload.books.map(encodeBook);
  if (payload.configs) env.configs = payload.configs.map(encodeConfig);
  if (payload.notes) env.notes = payload.notes.map(encodeNote);
  if (payload.statBooks) env.statBooks = payload.statBooks.map(encodeStat);
  if (payload.statPages) env.statPages = payload.statPages.map(encodeStat);
  return env;
};

const withUpdatedAtMs = <T extends { updated_at?: string | null; updated_at_ms?: number }>(
  rows: T[] | null | undefined,
): T[] | null =>
  rows
    ? rows.map((row) => ({
        ...row,
        updated_at_ms: row.updated_at_ms ?? (row.updated_at ? Date.parse(row.updated_at) : 0),
      }))
    : null;

const decodeRows = <T extends object>(rows: T[] | null | undefined): T[] | null =>
  rows ? rows.map(normalizeClocks) : null;

export const decodeEnvelope = (
  env: HomebaseEnvelope,
): SyncResult & Pick<HomebaseEnvelope, 'rejected'> => ({
  ...(env.rejected ? { rejected: env.rejected } : {}),
  books: decodeRows(env.books) as unknown as SyncResult['books'],
  configs: decodeRows(env.configs) as unknown as SyncResult['configs'],
  notes: decodeRows(env.notes) as unknown as SyncResult['notes'],
  statBooks: withUpdatedAtMs(env.statBooks as StatBookRecord[] | null | undefined),
  statPages: withUpdatedAtMs(env.statPages as StatPageRecord[] | null | undefined),
});
