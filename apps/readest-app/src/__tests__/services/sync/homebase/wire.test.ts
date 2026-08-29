import { describe, expect, test } from 'vitest';
import {
  DEVICE_LOCAL,
  decodeEnvelope,
  encodeBook,
  encodeConfig,
  encodeNote,
  encodeStatBook,
  encodeStatPage,
  encodeSyncData,
} from '@/services/sync/homebase/wire';
import type { StatBookRecord, StatPageRecord, SyncData } from '@/libs/sync';

const AUG = (day: number) => Date.parse(`2026-08-${String(day).padStart(2, '0')}T00:00:00.000Z`);
const ISO = (day: number) => new Date(AUG(day)).toISOString();

/**
 * The wire is the app's own merged record shape, so most of these tests are
 * about what the adapter must NOT do: invent fields, drop unknown ones, or ship
 * a device's disk layout to every peer. The exception is the identity backfill,
 * which exists because `useSync` pushes camelCase app objects that carry no
 * `book_hash` at all.
 */

describe('encodeBook', () => {
  test('relays the record unchanged apart from the deny-list', () => {
    const source = {
      book_hash: 'a',
      id: 'a',
      hash: 'a',
      title: 'Piranesi',
      author: 'Susanna Clarke',
      tags: ['fiction'],
      updated_at: AUG(1),
      updatedAt: AUG(1),
      deleted_at: null,
    };
    expect(encodeBook(source)).toEqual(source);
  });

  test('carries all three field clocks by their app names', () => {
    const row = encodeBook({
      hash: 'a',
      readingStatusUpdatedAt: AUG(1),
      coverUpdatedAt: AUG(2),
      metadataUpdatedAt: AUG(3),
    });
    expect(row.readingStatusUpdatedAt).toBe(AUG(1));
    expect(row.coverUpdatedAt).toBe(AUG(2));
    expect(row.metadataUpdatedAt).toBe(AUG(3));
  });

  test('a clock arriving as ISO is coerced to epoch ms', () => {
    // A string here sorts lexicographically against the numbers everything else
    // carries, and the merge silently picks the wrong row.
    const row = encodeBook({ hash: 'a', updated_at: ISO(5), deleted_at: ISO(5) });
    expect(row.updated_at).toBe(AUG(5));
    expect(row.deleted_at).toBe(AUG(5));
  });

  test('a live row states deleted_at: null rather than omitting it', () => {
    // Every fixture row carries an explicit null. To an upserting server an
    // absent column reads as "no opinion", which is not what a live book means.
    expect(encodeBook({ hash: 'a', deleted_at: null }).deleted_at).toBeNull();
    expect(encodeBook({ hash: 'a' }).deleted_at).toBeNull();
  });

  test('backfills the identity half a Book object does not have', () => {
    // `useSync.ts:288` pushes raw `Book[]`. A `Book` has `hash`; it has no
    // `book_hash`, which is the column Homebase upserts on. Without this the
    // push arrives keyed on undefined and writes nothing, with a 200 back.
    const row = encodeBook({
      hash: 'dd76b92e',
      metaHash: 'meta-1',
      title: 'Sapiens',
      updatedAt: AUG(4),
    });
    expect(row.book_hash).toBe('dd76b92e');
    expect(row.id).toBe('dd76b92e');
    expect(row.meta_hash).toBe('meta-1');
    expect(row.updated_at).toBe(AUG(4));
    // The camel half is still there — the record stays the merged shape.
    expect(row.hash).toBe('dd76b92e');
  });

  test('an existing snake_case value beats the camelCase one', () => {
    // A pulled row pushed straight back must keep the identity the server gave
    // it, even if a camelCase field drifted.
    const row = encodeBook({
      book_hash: 'server',
      hash: 'stale',
      updated_at: AUG(9),
      updatedAt: 1,
    });
    expect(row.book_hash).toBe('server');
    expect(row.updated_at).toBe(AUG(9));
  });

  test('a camelCase tombstone becomes the snake_case one', () => {
    expect(encodeBook({ hash: 'a', deletedAt: AUG(6) }).deleted_at).toBe(AUG(6));
  });

  test('unknown fields ride through untouched', () => {
    // Without this a v1 client erases a v2 server field on every round trip.
    const row = encodeBook({ hash: 'a', shelfId: 'kitchen', lentTo: 'sam' }) as Record<
      string,
      unknown
    >;
    expect(row['shelfId']).toBe('kitchen');
    expect(row['lentTo']).toBe('sam');
  });

  test('device-local fields never leave the machine', () => {
    // One user's disk layout broadcast to every peer. `audiobook` is a
    // per-device recording pairing Readest already excludes from cloud sync.
    const row = encodeBook({
      hash: 'a',
      filePath: '/Users/someone/Books/x.epub',
      altFilePaths: ['/Volumes/usb/x.epub'],
      audiobook: { deviceId: 'phone' },
      downloadedAt: 1,
      coverDownloadedAt: 2,
      lastSyncedAtConfig: 3,
      lastPushedAtNotes: 4,
    });
    for (const field of DEVICE_LOCAL) expect(field in row).toBe(false);
    expect(row.hash).toBe('a');
  });

  test('undefined values are dropped rather than serialised as null', () => {
    // JSON.stringify would drop them anyway; doing it here keeps the encoded
    // record equal to what the server actually receives.
    expect('someExtra' in encodeBook({ hash: 'a', someExtra: undefined })).toBe(false);
  });
});

describe('encodeConfig', () => {
  test('keeps the KOReader-compatible xpointer alongside the CFI', () => {
    // A Homebase config row must be able to seed KOSync progress, and BookConfig
    // already carries both locator dialects — no new field is needed.
    const row = encodeConfig({
      bookHash: 'a',
      location: 'epubcfi(/6/4!/4/2/2)',
      xpointer: '/body/DocFragment[3]',
      updatedAt: AUG(1),
    });
    expect(row.xpointer).toBe('/body/DocFragment[3]');
    expect(row.location).toBe('epubcfi(/6/4!/4/2/2)');
  });

  test('viewSettings stay an object — the wire is not the DB row', () => {
    // The Readest server JSON-encodes this column. The record on the wire does
    // not; encoding it here would double-encode it on arrival.
    const row = encodeConfig({ bookHash: 'a', viewSettings: { fontSize: 18 }, updatedAt: AUG(1) });
    expect(row.viewSettings).toEqual({ fontSize: 18 });
  });

  test('a config takes its identity from bookHash, not hash', () => {
    // `BookConfig` names the field differently from `Book`. Reading the wrong
    // one is silent: the record still encodes, just keyed on undefined.
    const row = encodeConfig({ bookHash: 'dd76b92e', metaHash: 'm', updatedAt: AUG(2) });
    expect(row.book_hash).toBe('dd76b92e');
    expect(row.id).toBe('dd76b92e');
    expect(row.meta_hash).toBe('m');
  });
});

describe('encodeNote', () => {
  test('preserves the flat hb audio fields a stock Readest would drop', () => {
    const row = encodeNote({
      bookHash: 'a',
      id: 'n1',
      text: 'x',
      updatedAt: AUG(1),
      hbKind: 'voice',
      hbAudioSha256: 'sha-1',
      hbAudioDurationMs: 4200,
      hbTranscriptSource: 'asr',
    });
    expect(row.hbAudioSha256).toBe('sha-1');
    expect(row.hbAudioDurationMs).toBe(4200);
    expect(row.hbTranscriptSource).toBe('asr');
  });

  test('an hb field this client version has never heard of survives', () => {
    const row = encodeNote({ bookHash: 'a', id: 'n1', hbFutureThing: { a: 1 } }) as Record<
      string,
      unknown
    >;
    expect(row['hbFutureThing']).toEqual({ a: 1 });
  });

  test('a highlight tombstone round-trips as epoch ms', () => {
    const row = encodeNote({ bookHash: 'a', id: 'n1', updatedAt: AUG(1), deleted_at: AUG(7) });
    expect(row.deleted_at).toBe(AUG(7));
  });

  test('a note keeps its own ULID and is never re-keyed to the book', () => {
    // Books and configs are one row per book, so id === book_hash there. Notes
    // upsert on (book_hash, id); collapsing them would merge every annotation
    // in a book into one row.
    const row = encodeNote({ bookHash: 'dd76b92e', id: '01JQ00', updatedAt: AUG(1) });
    expect(row.book_hash).toBe('dd76b92e');
    expect(row.id).toBe('01JQ00');
  });
});

describe('stat encoding', () => {
  const page = {
    book_hash: 'a',
    page: 3,
    start_time: 100,
    duration: 30,
    total_pages: 300,
    updated_at: ISO(1),
    updated_at_ms: 12345,
  } as StatPageRecord;

  test('never sends updated_at_ms upward', () => {
    // It is a RESPONSE-only cursor field; echoing it back is meaningless and
    // invites a server that trusts it.
    const row = encodeStatPage(page);
    expect('updated_at_ms' in row).toBe(false);
    expect(row.page).toBe(3);
    expect(row.updated_at).toBe(ISO(1));
  });

  test('the same holds for stat books', () => {
    const book = {
      book_hash: 'a',
      title: 'T',
      authors: 'A',
      updated_at: ISO(1),
      updated_at_ms: 999,
    } as StatBookRecord;
    expect('updated_at_ms' in encodeStatBook(book)).toBe(false);
  });

  test('the stats ISO updated_at is NOT coerced to ms', () => {
    // Stats are the one family whose updated_at really is ISO on both sides
    // (`libs/sync.ts:20`, `:32`). Normalising it here would break the server.
    expect(typeof encodeStatPage(page).updated_at).toBe('string');
  });
});

describe('encodeSyncData', () => {
  test('omits channels the payload did not include', () => {
    const env = encodeSyncData({
      books: [{ hash: 'a', updatedAt: AUG(1) }],
    } as unknown as SyncData);
    expect(env.books).toHaveLength(1);
    expect('configs' in env).toBe(false);
    expect('notes' in env).toBe(false);
  });

  test('stamps the wire schema version', () => {
    expect(encodeSyncData({} as SyncData).schema_version).toBe(1);
  });
});

describe('decodeEnvelope', () => {
  test('an absent channel decodes to null, not an empty array', () => {
    // `useSync.setSyncResult` reads null as "not synced" and [] as "synced,
    // nothing changed". Collapsing them would clear local state.
    const res = decodeEnvelope({ books: [] });
    expect(res.books).toEqual([]);
    expect(res.configs).toBeNull();
    expect(res.notes).toBeNull();
  });

  test('derives updated_at_ms so the stats cursor can advance', () => {
    // statsSync.pullStats reduces over updated_at_ms and breaks when the newest
    // value is <= since. Omit it and the cursor pins and re-pulls the whole
    // history on every sync, silently.
    const res = decodeEnvelope({
      statPages: [
        {
          book_hash: 'a',
          page: 1,
          start_time: 1,
          duration: 5,
          total_pages: 10,
          updated_at: ISO(9),
        },
      ],
    });
    expect(res.statPages?.[0]?.updated_at_ms).toBe(AUG(9));
  });

  test('a server-supplied updated_at_ms is not overwritten', () => {
    const res = decodeEnvelope({
      statBooks: [
        { book_hash: 'a', title: 'T', authors: 'A', updated_at: ISO(1), updated_at_ms: 999 },
      ],
    });
    expect(res.statBooks?.[0]?.updated_at_ms).toBe(999);
  });

  test('tombstoned rows reach the app rather than being filtered', () => {
    const res = decodeEnvelope({ books: [{ book_hash: 'a', deleted_at: AUG(3) }] });
    expect(res.books).toHaveLength(1);
  });

  test('hb fields survive the decode into the app record', () => {
    const res = decodeEnvelope({
      notes: [{ book_hash: 'a', id: 'n1', hbAudioSha256: 'sha-1' }],
    });
    const note = res.notes?.[0] as unknown as Record<string, unknown>;
    expect(note['hbAudioSha256']).toBe('sha-1');
  });
});

describe('round trip', () => {
  test('a book survives encode → decode with both halves intact', () => {
    // The record Readest pushed is the record it reads back: identity half and
    // app half together, nothing renamed, nothing dropped except the deny-list.
    // The adapter adds identity fields; it never converts one half into the other.
    const source = {
      book_hash: 'a',
      hash: 'a',
      format: 'EPUB',
      title: 'Piranesi',
      author: 'Susanna Clarke',
      tags: ['fiction'],
      createdAt: AUG(1),
      updatedAt: AUG(2),
      updated_at: AUG(2),
      coverHash: 'cov',
      coverUpdatedAt: AUG(2),
      shelfId: 'kitchen',
      filePath: '/Users/someone/Books/x.epub',
    };
    const decoded = decodeEnvelope({ books: [encodeBook(source)] });
    const row = decoded.books?.[0] as unknown as Record<string, unknown>;
    expect(row['book_hash']).toBe('a');
    expect(row['title']).toBe('Piranesi');
    expect(row['author']).toBe('Susanna Clarke');
    expect(row['tags']).toEqual(['fiction']);
    expect(row['coverHash']).toBe('cov');
    expect(row['shelfId']).toBe('kitchen');
    // …minus the one thing that must never travel.
    expect('filePath' in row).toBe(false);
  });
});
