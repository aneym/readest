/**
 * Merge rules (REVIEW-ONLY SPIKE).
 *
 * Two authorities meet here and they do NOT resolve the same way, so they are
 * kept apart on purpose:
 *
 *   1. Readest's own per-field clocks on a books row. Three of them, each added
 *      because a page-turn bumps `updatedAt` constantly and would otherwise
 *      clobber an edit made on another device: `readingStatusUpdatedAt` (#4634),
 *      `coverUpdatedAt` (#4544), `metadataUpdatedAt` (#5438). A Homebase adapter
 *      that ignored these would lose a cover the first time someone changed it
 *      on the phone and then read a page on the desktop.
 *
 *   2. Homebase's annotation ladder, pinned by `merge-cases.json`: client clock,
 *      then device sequence, then device id, then keep local. The last two rungs
 *      exist for an outbox draining several edits inside one millisecond, and
 *      they are SERVER-side — a Readest client never sees `deviceSeq`.
 *
 * The client still needs (1) even though the server also runs it: an offline
 * outbox coalesces several local edits before pushing, and reconciling a pull
 * against unpushed local state happens on-device with no server in the loop.
 * Both are merges, and both must agree with the server's answer.
 *
 * Clocks are epoch ms, matching `BookDataRecord` and every fixture record.
 */

import type { HomebaseBookRecord, HomebaseNoteRecord } from './types';

/** Epoch-ms-or-null → number. A missing clock is 0, never "now". */
export const clockMs = (at?: number | string | null): number => {
  if (at === null || at === undefined) return 0;
  return typeof at === 'number' ? at : new Date(at).getTime();
};

/** The field groups on a books row that resolve on their own clock. */
export type BookClockGroup = 'readingStatus' | 'cover' | 'metadata';

interface ClockGroupSpec {
  /** The clock field that decides this group. */
  clock: keyof HomebaseBookRecord & string;
  /** The value fields the clock governs. */
  fields: readonly (keyof HomebaseBookRecord & string)[];
  /**
   * Who wins an exact tie. 'client' for status/cover; 'row' for metadata, which
   * defers to whoever won the whole row on `updated_at`, so unstamped legacy
   * rows keep their historical whole-row behaviour instead of letting a stale
   * push graft its metadata onto a newer server row.
   */
  tie: 'client' | 'row';
}

export const BOOK_CLOCK_GROUPS: Record<BookClockGroup, ClockGroupSpec> = {
  readingStatus: {
    clock: 'readingStatusUpdatedAt',
    fields: ['readingStatus'],
    tie: 'client',
  },
  cover: {
    clock: 'coverUpdatedAt',
    fields: ['coverHash', 'coverImageUrl'],
    tie: 'client',
  },
  metadata: {
    clock: 'metadataUpdatedAt',
    fields: ['title', 'author', 'tags', 'metadata'],
    tie: 'row',
  },
};

const pickGroup = (
  record: HomebaseBookRecord,
  spec: ClockGroupSpec,
): Partial<HomebaseBookRecord> => {
  const out: Record<string, unknown> = {};
  const source = record as Record<string, unknown>;
  for (const field of [...spec.fields, spec.clock]) {
    if (field in record) out[field] = source[field];
  }
  return out as Partial<HomebaseBookRecord>;
};

const clockOf = (record: HomebaseBookRecord, field: string): number =>
  clockMs((record as Record<string, unknown>)[field] as number | string | null | undefined);

/** Whether the client side owns one clock group. Exported for the contract test. */
export const clientWinsGroup = (
  group: BookClockGroup,
  client: HomebaseBookRecord,
  server: HomebaseBookRecord,
  clientRowWins: boolean,
): boolean => {
  const spec = BOOK_CLOCK_GROUPS[group];
  const c = clockOf(client, spec.clock);
  const s = clockOf(server, spec.clock);
  if (c !== s) return c > s;
  return spec.tie === 'client' ? true : clientRowWins;
};

/**
 * Merge one books row. The row winner (by `updated_at`, ties → client, matching
 * Readest's server) supplies every ordinary field; each clock group is then
 * grafted on from whichever side owns it.
 *
 * Tombstones are NOT a clock group: a delete is decided by the row clock, and a
 * `deleted_at` on the winning side is carried through as-is. Undeleting is a
 * fresh write with a newer `updated_at` and `deleted_at: null`, which the same
 * rule handles without a special case.
 */
export const mergeBookRecord = (
  client: HomebaseBookRecord,
  server: HomebaseBookRecord,
): HomebaseBookRecord => {
  const clientRowWins = clockMs(client.updated_at) >= clockMs(server.updated_at);
  const merged: HomebaseBookRecord = { ...(clientRowWins ? client : server) };
  for (const group of Object.keys(BOOK_CLOCK_GROUPS) as BookClockGroup[]) {
    const spec = BOOK_CLOCK_GROUPS[group];
    const winner = clientWinsGroup(group, client, server, clientRowWins) ? client : server;
    Object.assign(merged, pickGroup(winner, spec));
  }
  return merged;
};

/**
 * Merge a non-books record. Whole-row LWW on `updated_at`, ties to the client —
 * the rule the server applies to families that carry no field clocks.
 *
 * `updated_at` is widened to accept a string because the two record families
 * this covers do not agree on its dialect: configs and notes carry epoch ms,
 * while `StatBookRecord` / `StatPageRecord` carry ISO (`libs/sync.ts:20`, `:32`).
 * `clockMs` normalises both, which is the whole reason it takes a union.
 */
export const mergeRowLww = <T extends { updated_at?: number | string | null }>(
  client: T,
  server: T,
): T => (clockMs(client.updated_at) >= clockMs(server.updated_at) ? client : server);

/**
 * The Homebase-side fields an annotation row carries that a Readest record has
 * no schema for. `deviceSeq` and `device` are the tie-break rungs; the `hb*`
 * fields are the server-owned payload (audio pointer, duration, transcript
 * provenance) that `voice-roundtrip.json` requires survive a round trip through
 * an unmodified reader.
 */
export interface AnnotationMergeSides {
  profileId?: string;
  device?: string;
  deviceSeq?: number;
}

/** Every `hb`-prefixed key on a record. These are server-owned. */
export const serverOwnedFields = (record: HomebaseNoteRecord): Record<string, unknown> =>
  Object.fromEntries(Object.entries(record).filter(([key]) => key.startsWith('hb')));

/**
 * Resolve two annotation rows, `merge-cases.json` ladder in order:
 *
 *   different profile → keep local. A newer write from another profile on the
 *     same client-generated ULID is invalid input, not a merge; without this a
 *     shared household id collision silently overwrites someone else's note.
 *   newer `updated_at` wins, whichever arrived first.
 *   exact tie → higher `deviceSeq`.
 *   still tied → higher device id, which orders the same way on every peer.
 *   total tie → keep local, because an unresolvable tie should not churn.
 *
 * A tombstone is an ordinary write and wins on time like any other.
 *
 * Then the re-attach: the winner's `hb*` fields are backfilled from the local
 * row when the winner carries none. A Readest push never sends them, so without
 * this the first desktop sync of a watch voice note turns it into a plain one.
 */
export const resolveAnnotation = <T extends HomebaseNoteRecord & AnnotationMergeSides>(
  local: T,
  incoming: T,
): T => {
  if (local.profileId && incoming.profileId && local.profileId !== incoming.profileId) return local;

  const winner = ((): T => {
    const l = clockMs(local.updated_at ?? local.updatedAt);
    const i = clockMs(incoming.updated_at ?? incoming.updatedAt);
    if (l !== i) return i > l ? incoming : local;
    const ls = local.deviceSeq ?? -1;
    const is = incoming.deviceSeq ?? -1;
    if (ls !== is) return is > ls ? incoming : local;
    const ld = local.device ?? '';
    const id = incoming.device ?? '';
    if (ld !== id) return id > ld ? incoming : local;
    return local;
  })();

  const carried = serverOwnedFields(local);
  const own = serverOwnedFields(winner);
  // Only backfill what the winner does not already state. An incoming row that
  // DOES carry hb fields is a modified client speaking for itself.
  return { ...carried, ...winner, ...own } as T;
};
