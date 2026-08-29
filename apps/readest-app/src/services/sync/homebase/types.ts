/**
 * Wire types for the Homebase sync adapter (REVIEW-ONLY SPIKE).
 *
 * Nothing in `services/sync/homebase/` is imported by shipping code. The point
 * of the spike is to show how small the client-side seam is if Homebase — not
 * Readest Cloud — becomes the canonical store for books/configs/notes/stats and
 * the object store for book bytes, while KOSync keeps carrying KOReader-
 * compatible progress unchanged.
 *
 * THE WIRE IS THE APP'S OWN RECORD SHAPE, not a schema of its own. `SyncData`
 * push elements are `Partial<BookRecord>` and `BookRecord extends BookDataRecord,
 * Book` (`libs/sync.ts:47`, `:11`), so one record may hold the snake_case
 * identity half and the camelCase app half together, and every fixture in
 * `../homebase-reader/readest-homebase/fixtures/` does exactly that.
 *
 * What the TYPE permits is not what the app SENDS, and the gap is the adapter's
 * only real job. `useSync.pushChanges` hands the client raw `Book[]` /
 * `BookConfig[]` / `BookNote[]` (`useSync.ts:288`, `:309`, `:334`) — camel half
 * only, no `book_hash` anywhere — because Readest's own server runs
 * `transformBookToDB` on arrival. Homebase upserts on `book_hash`, so `wire.ts`
 * backfills the four identity fields on push. Pull needs nothing: the response
 * already carries both halves and `useSync` runs `transformBookFromDB` itself.
 *
 * The adapter therefore does no camelCase↔snake_case conversion. On top of the
 * backfill it adds three things the stock client has no place for: unknown-field
 * preservation, the `updated_at_ms` stats cursor, and a device-local deny-list.
 *
 * Timestamp discipline, pinned by the fixtures. There are two dialects, and
 * mixing them is how a merge silently picks the wrong row:
 *
 *   books / configs / notes — `updated_at`, `deleted_at`, `createdAt`,
 *     `updatedAt`, `deletedAt` are epoch ms; `synced_at` and `uploaded_at` are
 *     ISO-8601, server-stamped. Matches `BookDataRecord` (`types/book.ts:624`).
 *   statBooks / statPages — `updated_at` is ISO, there is no `synced_at`, and
 *     the cursor is a numeric `updated_at_ms` the server attaches on pull
 *     (`libs/sync.ts:20`, `:32`).
 *
 * An earlier draft of this spike used ISO strings for everything. A string where
 * a number belongs sorts lexicographically, so `wire.ts` coerces the first group
 * on the way in and leaves the second alone.
 */

import type { SyncData, SyncResult } from '@/libs/sync';

/** The record families Homebase would own. Mirrors `SyncType` plus split stats. */
export type HomebaseChannel = 'books' | 'configs' | 'notes' | 'statBooks' | 'statPages';

export const HOMEBASE_CHANNELS: readonly HomebaseChannel[] = [
  'books',
  'configs',
  'notes',
  'statBooks',
  'statPages',
] as const;

/**
 * Wire schema version. Bumped when a field's MEANING changes, never when a
 * field is added — unknown fields round-trip untouched (see `wire.ts`), which
 * is what makes the audio-note extension additive.
 */
export const HOMEBASE_WIRE_VERSION = 1;

/**
 * Server-owned fields Readest has no schema for, carried on the flat record
 * under an `hb` prefix. `voice-roundtrip.json` pins this shape and the reason
 * for it: an unmodified Readest reads a voice note, edits its transcript, and
 * pushes back a plain `BookNote` with the audio pointer gone. Homebase re-
 * attaches from its own row, so nothing is lost either way — but a client that
 * PRESERVES them (which `wire.ts` does) makes the re-attach a safety net rather
 * than the only thing standing between a voice note and silence.
 *
 * The bytes live in object storage under the `note-audio` class, addressed by
 * `hbAudioSha256` through `HomebaseStorageAdapter`.
 */
export interface HomebaseAudioFields {
  /** Homebase's own annotation kind, wider than `BookNote['type']`. */
  hbKind?: string;
  /** Content address of the audio blob; the storage adapter resolves it. */
  hbAudioSha256?: string;
  hbAudioDurationMs?: number;
  /** `asr` until a human edits the transcript text, then `human`. */
  hbTranscriptSource?: 'asr' | 'human';
}

/** Any `hb`-prefixed key, known or not. Unknown ones survive a round trip. */
export type HomebaseExtFields = Record<`hb${string}`, unknown>;

export type PulledBook = NonNullable<SyncResult['books']>[number];
export type PulledConfig = NonNullable<SyncResult['configs']>[number];
export type PulledNote = NonNullable<SyncResult['notes']>[number];

/**
 * A book row. `synced_at` is server receipt time and is the pull cursor — never
 * the client's clock, or a device with a fast clock stops receiving its own
 * writes (`pull-books.json`). `uploaded_at` is always set by Homebase because
 * Homebase always holds the bytes; leaving it null makes Readest show the book
 * as indexed but unavailable.
 */
export type HomebaseBookRecord = Partial<PulledBook> & HomebaseExtFields;

/**
 * A config row. Homebase emits exactly ONE per book — the resume winner across
 * every device, chosen by server receipt time — because Readest upserts configs
 * on `book_hash` alone (`pull-configs.json`).
 *
 * `BookConfig` already carries both locator dialects: `location` is the CFI and
 * `xpointer` exists for KOReader interoperability. No new field is needed for
 * the KOSync hand-off.
 */
export type HomebaseConfigRecord = Partial<PulledConfig> & HomebaseExtFields;

/** A note row, plus the server-owned audio fields. Upserts on `(book_hash, id)`. */
export type HomebaseNoteRecord = Partial<PulledNote> & HomebaseAudioFields & HomebaseExtFields;

export type HomebaseStatBookRecord = NonNullable<SyncResult['statBooks']>[number];
export type HomebaseStatPageRecord = NonNullable<SyncResult['statPages']>[number];

/** One pull/push response body. Absent channel = "not asked for". */
export interface HomebaseEnvelope {
  books?: HomebaseBookRecord[] | null;
  configs?: HomebaseConfigRecord[] | null;
  notes?: HomebaseNoteRecord[] | null;
  statBooks?: HomebaseStatBookRecord[] | null;
  statPages?: HomebaseStatPageRecord[] | null;
  /** Server clock, for skew diagnostics. Never used as a merge input. */
  server_time?: string;
  schema_version?: number;
}

export type HomebaseRecord =
  | HomebaseBookRecord
  | HomebaseConfigRecord
  | HomebaseNoteRecord
  | HomebaseStatBookRecord
  | HomebaseStatPageRecord;

/** The push payload, which is the app's own `SyncData` unchanged. */
export type HomebasePushData = SyncData;
