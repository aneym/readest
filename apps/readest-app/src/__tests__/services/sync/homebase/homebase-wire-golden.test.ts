import { describe, expect, test } from 'vitest';
import type { HomebaseEnvelope } from '@/services/sync/homebase/types';
import { decodeEnvelope } from '@/services/sync/homebase/wire';
import {
  transformBookConfigFromDB,
  transformBookFromDB,
  transformBookNoteFromDB,
  transformBookNoteToDB,
} from '@/utils/transform';
import type { DBBook, DBBookConfig, DBBookNote } from '@/types/records';
import fixture from './fixtures/homebase-wire-golden.json';

// Copied from Homebase server/reader/__tests__/fixtures/readest-wire-golden.json; re-copy when that file changes.
const wire = fixture as unknown as HomebaseEnvelope;

describe('Homebase server wire through the reader pull path', () => {
  test('books, configs, and notes retain their server clocks and content', () => {
    const rows = decodeEnvelope(wire);
    const books = rows.books!.map((row) => transformBookFromDB(row as unknown as DBBook));
    const configs = rows.configs!.map((row) =>
      transformBookConfigFromDB(row as unknown as DBBookConfig),
    );
    const notes = rows.notes!.map((row) => transformBookNoteFromDB(row as unknown as DBBookNote));

    for (const row of [...books, ...notes]) {
      expect(Number.isFinite(row.createdAt)).toBe(true);
      expect(Number.isFinite(row.updatedAt)).toBe(true);
    }
    for (const row of configs) expect(Number.isFinite(row.updatedAt)).toBe(true);
    expect(books[0]?.createdAt).toBe(1699999940000);
    expect(books[0]?.coverImageUrl).toBe(fixture.books[0]!.coverImageUrl);
    expect(configs[0]?.progress).toEqual([50, 100]);
    const voice = notes.find((note) => note.id === 'voice-note')!;
    expect(voice).toMatchObject({
      hbKind: 'voice',
      hbAudioSha256: fixture.notes[1]!.hbAudioSha256,
      hbAudioDurationMs: 8420,
      hbTranscriptSource: 'asr',
    });
    expect(transformBookNoteFromDB(transformBookNoteToDB(voice, 'alex'))).toMatchObject({
      hbKind: 'voice',
      hbAudioSha256: fixture.notes[1]!.hbAudioSha256,
      hbAudioDurationMs: 8420,
      hbTranscriptSource: 'asr',
    });
    expect(notes.find((note) => note.id === 'deleted-note')?.deletedAt).toBe(1700000005000);
  });

  test('older camelCase-only clocks and invalid snake clocks fall back without NaN', () => {
    const oldBook = { ...fixture.books[0] } as Record<string, unknown>;
    const oldNote = { ...fixture.notes[0] } as Record<string, unknown>;
    delete oldBook['created_at'];
    delete oldNote['created_at'];
    const decoded = decodeEnvelope({ books: [oldBook], notes: [oldNote] });
    expect(transformBookFromDB(decoded.books![0] as unknown as DBBook).createdAt).toBe(
      1699999940000,
    );
    expect(transformBookNoteFromDB(decoded.notes![0] as unknown as DBBookNote).createdAt).toBe(
      1699999970000,
    );

    oldBook['created_at'] = 'invalid';
    oldBook['createdAt'] = 'invalid';
    oldNote['created_at'] = 'invalid';
    oldNote['createdAt'] = 'invalid';
    const invalid = decodeEnvelope({ books: [oldBook], notes: [oldNote] });
    const book = transformBookFromDB(invalid.books![0] as unknown as DBBook);
    const note = transformBookNoteFromDB(invalid.notes![0] as unknown as DBBookNote);
    expect(book.createdAt).toBe(book.updatedAt);
    expect(note.createdAt).toBe(note.updatedAt);
  });
});
