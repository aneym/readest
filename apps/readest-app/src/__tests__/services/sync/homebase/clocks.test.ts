import { describe, expect, test } from 'vitest';
import {
  BOOK_CLOCK_GROUPS,
  clientWinsGroup,
  clockMs,
  mergeBookRecord,
  mergeRowLww,
  resolveAnnotation,
  serverOwnedFields,
  type AnnotationMergeSides,
} from '@/services/sync/homebase/clocks';
import type { HomebaseBookRecord, HomebaseNoteRecord } from '@/services/sync/homebase/types';

/**
 * Clocks on records are epoch ms, matching `BookDataRecord` and every fixture.
 * `AUG(10)` reads better in an assertion than 1786665600000 does.
 */
const AUG = (day: number) => Date.parse(`2026-08-${String(day).padStart(2, '0')}T00:00:00.000Z`);

const bk = (over: Partial<HomebaseBookRecord>): HomebaseBookRecord => ({
  book_hash: 'a',
  updated_at: AUG(1),
  ...over,
});

describe('clockMs', () => {
  test('an absent clock is epoch 0, never now', () => {
    // "Now" would make every unstamped legacy row win every merge it enters.
    expect(clockMs(null)).toBe(0);
    expect(clockMs(undefined)).toBe(0);
    expect(clockMs(AUG(1))).toBe(AUG(1));
  });

  test('an ISO string normalises to the same instant as its epoch ms', () => {
    // `synced_at` and the stats `updated_at` arrive as ISO; the book clocks do
    // not. One comparator has to accept both or the two dialects never sort
    // against each other.
    expect(clockMs('2026-08-01T00:00:00.000Z')).toBe(AUG(1));
  });
});

describe('book field clocks', () => {
  test('a page-turn that wins the row does not clobber a newer cover', () => {
    // The bug the cover clock exists to prevent (#4544): reading on the desktop
    // bumps updatedAt every few seconds, and the phone's cover edit is older.
    const client = bk({ updated_at: AUG(10), coverHash: 'desktop', coverUpdatedAt: AUG(1) });
    const server = bk({ updated_at: AUG(5), coverHash: 'phone', coverUpdatedAt: AUG(9) });
    const merged = mergeBookRecord(client, server);
    expect(merged.updated_at).toBe(AUG(10));
    expect(merged.coverHash).toBe('phone');
    expect(merged.coverUpdatedAt).toBe(AUG(9));
  });

  test('reading status resolves on its own clock (#4634)', () => {
    const client = bk({
      updated_at: AUG(1),
      readingStatus: 'reading',
      readingStatusUpdatedAt: AUG(12),
    });
    const server = bk({
      updated_at: AUG(20),
      readingStatus: 'finished',
      readingStatusUpdatedAt: AUG(3),
    });
    const merged = mergeBookRecord(client, server);
    expect(merged.updated_at).toBe(AUG(20));
    expect(merged.readingStatus).toBe('reading');
  });

  test('the metadata group moves as one unit (#5438)', () => {
    const client = bk({
      updated_at: AUG(20),
      title: 'Client title',
      author: 'Client author',
      tags: ['c'],
      metadataUpdatedAt: AUG(2),
    });
    const server = bk({
      updated_at: AUG(1),
      title: 'Server title',
      author: 'Server author',
      tags: ['s'],
      metadataUpdatedAt: AUG(9),
    });
    const merged = mergeBookRecord(client, server);
    // Row went to the client; the whole metadata group still came from the
    // server. A half-merged title/author pair is worse than either side.
    expect(merged.title).toBe('Server title');
    expect(merged.author).toBe('Server author');
    expect(merged.tags).toEqual(['s']);
  });

  test('status and cover ties go to the CLIENT', () => {
    for (const group of ['readingStatus', 'cover'] as const) {
      const clock = BOOK_CLOCK_GROUPS[group].clock;
      const client = bk({ [clock]: AUG(7) });
      const server = bk({ [clock]: AUG(7) });
      expect(clientWinsGroup(group, client, server, false)).toBe(true);
    }
  });

  test('a metadata tie follows the ROW winner, not the client', () => {
    const client = bk({ metadataUpdatedAt: AUG(7) });
    const server = bk({ metadataUpdatedAt: AUG(7) });
    expect(clientWinsGroup('metadata', client, server, true)).toBe(true);
    // This is the asymmetry: a stale client push must not graft its metadata
    // onto a newer server row just because neither side stamped the clock.
    expect(clientWinsGroup('metadata', client, server, false)).toBe(false);
  });

  test('unstamped legacy rows on both sides degrade to whole-row LWW', () => {
    const client = bk({ updated_at: AUG(1), title: 'Client' });
    const server = bk({ updated_at: AUG(9), title: 'Server' });
    expect(mergeBookRecord(client, server).title).toBe('Server');
  });

  test('a tombstone rides the row clock and needs no special case', () => {
    const deleted = bk({ updated_at: AUG(10), deleted_at: AUG(10) });
    const live = bk({ updated_at: AUG(2), deleted_at: null });
    expect(mergeBookRecord(deleted, live).deleted_at).toBe(AUG(10));
    // Undelete is just a newer write with deleted_at null.
    const undeleted = bk({ updated_at: AUG(11), deleted_at: null });
    expect(mergeBookRecord(undeleted, deleted).deleted_at).toBeNull();
  });
});

describe('row LWW', () => {
  test('newer wins, ties go to the client', () => {
    expect(mergeRowLww({ updated_at: AUG(9), v: 'c' }, { updated_at: AUG(1), v: 's' }).v).toBe('c');
    expect(mergeRowLww({ updated_at: AUG(1), v: 'c' }, { updated_at: AUG(9), v: 's' }).v).toBe('s');
    expect(mergeRowLww({ updated_at: AUG(5), v: 'c' }, { updated_at: AUG(5), v: 's' }).v).toBe('c');
  });

  test('the stats dialect sorts against the same comparator', () => {
    // `StatBookRecord.updated_at` is ISO while a config's is epoch ms. Both
    // reach mergeRowLww, so a string-vs-number mix must not sort by type.
    const older = { updated_at: '2026-08-01T00:00:00.000Z', v: 'old' };
    const newer = { updated_at: '2026-08-09T00:00:00.000Z', v: 'new' };
    expect(mergeRowLww(older, newer).v).toBe('new');
  });
});

describe('annotation ladder (merge-cases.json)', () => {
  const note = (
    over: Partial<HomebaseNoteRecord & AnnotationMergeSides>,
  ): HomebaseNoteRecord & AnnotationMergeSides => ({
    book_hash: 'a',
    id: '01JQ0000000000000000000000',
    updated_at: AUG(1),
    ...over,
  });

  test('the newer client clock wins whichever side it arrived on', () => {
    const local = note({ updated_at: AUG(1), note: 'local' });
    const incoming = note({ updated_at: AUG(9), note: 'incoming' });
    expect(resolveAnnotation(local, incoming).note).toBe('incoming');
    expect(resolveAnnotation(incoming, local).note).toBe('incoming');
  });

  test('an exact tie falls through to the higher device sequence', () => {
    // The outbox drains several edits inside one millisecond; without this rung
    // the merge is decided by arrival order, which differs per peer.
    const local = note({ updated_at: AUG(5), deviceSeq: 7, note: 'local' });
    const incoming = note({ updated_at: AUG(5), deviceSeq: 9, note: 'incoming' });
    expect(resolveAnnotation(local, incoming).note).toBe('incoming');
  });

  test('a full tie falls through to the device id, then keeps local', () => {
    const local = note({ updated_at: AUG(5), deviceSeq: 3, device: 'aaa', note: 'local' });
    const higher = note({ updated_at: AUG(5), deviceSeq: 3, device: 'zzz', note: 'incoming' });
    expect(resolveAnnotation(local, higher).note).toBe('incoming');
    // Identical on every rung: keep local rather than churn a row for nothing.
    const twin = note({ updated_at: AUG(5), deviceSeq: 3, device: 'aaa', note: 'incoming' });
    expect(resolveAnnotation(local, twin).note).toBe('local');
  });

  test('a write from a different profile never wins, however new it is', () => {
    // Two profiles colliding on one client-generated ULID is invalid input, not
    // a merge. Resolving it on time would silently overwrite someone else.
    const local = note({ updated_at: AUG(1), profileId: 'alex', note: 'mine' });
    const other = note({ updated_at: AUG(30), profileId: 'alexandra', note: 'theirs' });
    expect(resolveAnnotation(local, other).note).toBe('mine');
  });

  test('a tombstone is an ordinary write and wins on time', () => {
    const live = note({ updated_at: AUG(1), note: 'text' });
    const deleted = note({ updated_at: AUG(2), deleted_at: AUG(2) });
    expect(resolveAnnotation(live, deleted).deleted_at).toBe(AUG(2));
  });
});

describe('server-owned hb fields', () => {
  const voice = (over: Partial<HomebaseNoteRecord & AnnotationMergeSides>) =>
    ({ book_hash: 'a', id: 'n1', updated_at: AUG(1), ...over }) as HomebaseNoteRecord &
      AnnotationMergeSides;

  test('serverOwnedFields picks up every hb key, known or not', () => {
    const picked = serverOwnedFields(
      voice({ note: 'text', hbAudioSha256: 'sha', hbSomethingNewer: 1 } as never),
    );
    expect(picked).toEqual({ hbAudioSha256: 'sha', hbSomethingNewer: 1 });
    expect('note' in picked).toBe(false);
  });

  test('an unmodified Readest push does not silence a voice note', () => {
    // voice-roundtrip.json: the reader reads a voice note, edits the transcript
    // text, and pushes back a plain BookNote with the audio pointer gone. The
    // local row still has it, so the winner gets it back.
    const stored = voice({
      updated_at: AUG(1),
      note: 'asr text',
      hbKind: 'voice',
      hbAudioSha256: 'sha-1',
      hbAudioDurationMs: 4200,
      hbTranscriptSource: 'asr',
    });
    const pushed = voice({ updated_at: AUG(2), note: 'corrected text' });
    const merged = resolveAnnotation(stored, pushed);
    expect(merged.note).toBe('corrected text');
    expect(merged.hbAudioSha256).toBe('sha-1');
    expect(merged.hbAudioDurationMs).toBe(4200);
  });

  test('a client that DOES speak hb keeps its own values', () => {
    // The backfill is a safety net for readers with no schema for these fields,
    // not an override — a modified client re-recording the audio must win.
    const stored = voice({ updated_at: AUG(1), hbAudioSha256: 'old-sha' });
    const pushed = voice({ updated_at: AUG(2), hbAudioSha256: 'new-sha' });
    expect(resolveAnnotation(stored, pushed).hbAudioSha256).toBe('new-sha');
  });

  test('a note with no hb fields anywhere merges as a plain row', () => {
    const merged = resolveAnnotation(
      voice({ updated_at: AUG(1), note: 'c' }),
      voice({ updated_at: AUG(9), note: 's' }),
    );
    expect(merged.note).toBe('s');
    expect(Object.keys(merged).some((k) => k.startsWith('hb'))).toBe(false);
  });
});
