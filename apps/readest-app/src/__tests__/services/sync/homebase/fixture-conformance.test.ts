import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { resolveAnnotation, type AnnotationMergeSides } from '@/services/sync/homebase/clocks';
import type { HomebaseNoteRecord } from '@/services/sync/homebase/types';
import { decodeEnvelope, encodeConfig, encodeNote } from '@/services/sync/homebase/wire';

/**
 * Replays the Homebase fixtures against the spike.
 *
 * Everything else in this directory is a test I wrote against my own reading of
 * the protocol, which is exactly the kind of test that agrees with itself and
 * with nothing else. These cases came from the other side of the wire.
 *
 * The fixtures are vendored (see `fixtures/README.md`); the last test in this
 * file diffs the copy against the sibling repo so a stale snapshot fails loudly
 * instead of passing quietly.
 */

const FIXTURE_DIR = join(__dirname, 'fixtures');
const UPSTREAM_DIR =
  '/Volumes/StudioExt/repos/personal/homebase/docs/work/homebase-reader/readest-homebase/fixtures';

const load = <T>(name: string): T =>
  JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf-8')) as T;

/** Homebase's internal row names differ from the wire's. Map, don't guess. */
const asNote = (row: Record<string, unknown>): HomebaseNoteRecord & AnnotationMergeSides =>
  ({
    id: row['annotationId'],
    book_hash: row['fileHash'],
    profileId: row['profileId'],
    device: row['device'],
    deviceSeq: row['deviceSeq'],
    note: row['note'],
    updated_at: row['updatedAt'],
    deleted_at: row['deletedAt'] ?? null,
  }) as HomebaseNoteRecord & AnnotationMergeSides;

/** The camelCase half of a fixture record — what `useSync` actually pushes. */
const camelHalfOf = (record: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(record).filter(([key]) => !key.includes('_')));

interface PushCase {
  name: string;
  record: Record<string, unknown>;
  expect: { ok: boolean; reason?: string };
}

describe('pull-books.json — the decode relays what Homebase sends', () => {
  const fixture = load<{ cases: { name: string; expect: Record<string, unknown> }[] }>(
    'pull-books.json',
  );

  test.each(
    fixture.cases.map((c) => [c.name, c.expect] as const),
  )('relays every field of: %s', (_name, row) => {
    const decoded = decodeEnvelope({ books: [row] });
    // Not a subset match. A pull that quietly drops `synced_at` pins the
    // cursor; one that drops `uploaded_at` makes Readest show the book as
    // indexed but unavailable. Both are invisible until a user hits them.
    expect(decoded.books?.[0]).toEqual(row);
  });

  test('the tombstone case arrives as a row, not as an absence', () => {
    const tombstoned = fixture.cases[1]!.expect;
    expect(tombstoned['deleted_at']).toBe(1787799600000);
    expect(decodeEnvelope({ books: [tombstoned] }).books).toHaveLength(1);
  });
});

describe('push-configs.json — the identity half Homebase keys on', () => {
  const fixture = load<{ cases: PushCase[] }>('push-configs.json');

  test.each(
    fixture.cases.map((c) => [c.name, c.record] as const),
  )('derives book_hash from the camelCase half: %s', (_name, record) => {
    // Strip what `useSync.ts:309` never sends. A `BookConfig` has `bookHash`
    // and `updatedAt` and nothing else from the identity half — not even `id`,
    // which the fixture carries because Homebase echoes it back on the pull.
    const { id: _id, ...camel } = camelHalfOf(record);
    expect(camel['book_hash']).toBeUndefined();
    const encoded = encodeConfig(camel) as Record<string, unknown>;
    expect(encoded['book_hash']).toBe(record['book_hash']);
    expect(encoded['id']).toBe(record['id']);
    expect(encoded['updated_at']).toBe(record['updated_at']);
    expect(encoded['deleted_at']).toBe(record['deleted_at']);
  });

  test("the REJECT cases are the server's to make, and the client still sends them", () => {
    // A client that pre-filtered these would hide a broken device instead of
    // letting Homebase report `bad-clock` / `bad-file-hash` back.
    const rejects = fixture.cases.filter((c) => !c.expect.ok);
    expect(rejects.length).toBeGreaterThan(0);
    for (const c of rejects) {
      expect(encodeConfig(camelHalfOf(c.record))).toBeTruthy();
    }
  });
});

describe('push-notes.json — the identity half, minus the note ULID', () => {
  const fixture = load<{ cases: PushCase[] }>('push-notes.json');

  test.each(
    fixture.cases.map((c) => [c.name, c.record] as const),
  )('derives book_hash and keeps the annotation id: %s', (_name, record) => {
    const encoded = encodeNote(camelHalfOf(record)) as Record<string, unknown>;
    expect(encoded['book_hash']).toBe(record['book_hash']);
    expect(encoded['updated_at']).toBe(record['updated_at']);
    expect(encoded['deleted_at']).toBe(record['deleted_at']);
    // Notes upsert on (book_hash, id). Re-keying the id to the book hash the
    // way books and configs do would merge every annotation into one row.
    expect(encoded['id']).toBe(record['id']);
  });

  test('the locator fields reach the server untouched, in whichever dialect', () => {
    // Homebase classifies epubcfi / xpointer / pdf-page itself. A client that
    // normalised them would decide the classification and get it wrong on the
    // reflowable-vs-paged distinction, which it cannot see.
    const withXpointer = fixture.cases.find((c) => 'xpointer0' in c.record)!;
    const encoded = encodeNote(camelHalfOf(withXpointer.record)) as Record<string, unknown>;
    expect(encoded['xpointer0']).toBe(withXpointer.record['xpointer0']);
    expect(encoded['xpointer1']).toBe(withXpointer.record['xpointer1']);
  });
});

describe('merge-cases.json — the annotation ladder', () => {
  const fixture = load<{
    cases: {
      name: string;
      local: Record<string, unknown>;
      incoming: Record<string, unknown>;
      expect: 'local' | 'incoming';
    }[];
  }>('merge-cases.json');

  test.each(fixture.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const winner = resolveAnnotation(asNote(c.local), asNote(c.incoming));
    const expected = asNote(c.expect === 'local' ? c.local : c.incoming);
    // `note` is the only field that differs across every case, so it identifies
    // the winner without asserting on fields the client does not carry.
    expect(winner.note).toBe(expected.note);
    expect(winner.deleted_at).toBe(expected.deleted_at);
  });

  test('all seven rungs are exercised, not just the easy ones', () => {
    expect(fixture.cases).toHaveLength(7);
  });
});

describe('voice-roundtrip.json — a watch voice note through an unmodified reader', () => {
  const fixture = load<{
    expectPulled: Record<string, unknown>;
    cases: { name: string; pushed: Record<string, unknown> }[];
  }>('voice-roundtrip.json');

  test('the pulled note keeps its hb fields through the decode', () => {
    const decoded = decodeEnvelope({ notes: [fixture.expectPulled] });
    expect(decoded.notes?.[0]).toEqual(fixture.expectPulled);
  });

  test('a client that speaks hb sends them back instead of dropping them', () => {
    // This is the difference the spike buys. Homebase re-attaches server-owned
    // fields because a stock Readest strips them; a client that preserves them
    // makes that re-attach a safety net rather than the only thing between a
    // voice note and silence.
    const pulled = decodeEnvelope({ notes: [fixture.expectPulled] })
      .notes?.[0] as unknown as Record<string, unknown>;
    const pushedBack = encodeNote(pulled) as Record<string, unknown>;
    expect(pushedBack['hbAudioSha256']).toBe(fixture.expectPulled['hbAudioSha256']);
    expect(pushedBack['hbAudioDurationMs']).toBe(8420);
    expect(pushedBack['hbKind']).toBe('voice');
  });

  test('an unmodified push loses the audio, and the local row restores it', () => {
    const stored = decodeEnvelope({ notes: [fixture.expectPulled] })
      .notes?.[0] as unknown as HomebaseNoteRecord;
    const pushed = encodeNote(camelHalfOf(fixture.cases[0]!.pushed));
    expect(pushed.hbAudioSha256).toBeUndefined();

    const merged = resolveAnnotation(stored, pushed);
    expect(merged.note).toBe(fixture.cases[0]!.pushed['note']);
    expect(merged.hbAudioSha256).toBe(fixture.expectPulled['hbAudioSha256']);
    expect(merged.hbAudioDurationMs).toBe(8420);
  });

  test('a stale push cannot resurrect the pre-edit transcript', () => {
    const stored = decodeEnvelope({ notes: [fixture.expectPulled] })
      .notes?.[0] as unknown as HomebaseNoteRecord;
    const stale = encodeNote({ ...camelHalfOf(fixture.cases[0]!.pushed), updatedAt: 1 });
    expect(resolveAnnotation(stored, stale).note).toBe(fixture.expectPulled['note']);
  });
});

describe('provenance', () => {
  const names = [
    'pull-books.json',
    'push-configs.json',
    'push-notes.json',
    'merge-cases.json',
    'voice-roundtrip.json',
  ];

  test.runIf(existsSync(UPSTREAM_DIR)).each(names)(
    'the vendored %s still matches the sibling repo',
    (name) => {
      const mine = readFileSync(join(FIXTURE_DIR, name), 'utf-8');
      const theirs = readFileSync(join(UPSTREAM_DIR, name), 'utf-8');
      expect(JSON.parse(mine)).toEqual(JSON.parse(theirs));
    },
  );
});
