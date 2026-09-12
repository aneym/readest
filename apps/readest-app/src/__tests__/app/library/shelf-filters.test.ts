import { describe, expect, test } from 'vitest';
import type { Book } from '@/types/book';
import {
  applyShelfFilter,
  ensureShelfFilterId,
  hasShelfCategories,
  isNewArrival,
  isReadingBook,
  shelfFilterCounts,
} from '@/app/library/shelf/shelfFilters';

const DAY = 86_400_000;
const NOW = 1_790_000_000_000;
const book = (overrides: Partial<Book> = {}): Book => ({
  hash: Math.random().toString(16).slice(2),
  format: 'EPUB',
  title: 'Book',
  author: 'Author',
  createdAt: NOW - 100 * DAY,
  updatedAt: NOW - 100 * DAY,
  ...overrides,
});

describe('reading detection', () => {
  test('past 1% and touched within 45 days counts as reading', () => {
    expect(isReadingBook(book({ progress: [30, 100], updatedAt: NOW - 3 * DAY }), NOW)).toBe(true);
  });
  test('a book opened once on its cover is sampling, not reading', () => {
    expect(isReadingBook(book({ progress: [1, 400], updatedAt: NOW }), NOW)).toBe(false);
  });
  test('a stale half-read book drops out; an explicit Reading status keeps it', () => {
    expect(isReadingBook(book({ progress: [50, 100], updatedAt: NOW - 60 * DAY }), NOW)).toBe(
      false,
    );
    expect(
      isReadingBook(
        book({ progress: [50, 100], updatedAt: NOW - 60 * DAY, readingStatus: 'reading' }),
        NOW,
      ),
    ).toBe(true);
  });
  test('finished, abandoned and unread never read as reading', () => {
    for (const readingStatus of ['finished', 'abandoned', 'unread'] as const) {
      expect(isReadingBook(book({ progress: [50, 100], updatedAt: NOW, readingStatus }), NOW)).toBe(
        false,
      );
    }
  });
  test('an unopened book that arrived this fortnight is a new arrival', () => {
    expect(isNewArrival(book({ createdAt: NOW - 2 * DAY }), NOW)).toBe(true);
    expect(isNewArrival(book({ createdAt: NOW - 30 * DAY }), NOW)).toBe(false);
    expect(isNewArrival(book({ createdAt: NOW - 2 * DAY, progress: [5, 100] }), NOW)).toBe(false);
  });
});

describe('applyShelfFilter', () => {
  const reading = book({
    title: 'reading',
    tags: ['Fiction'],
    progress: [40, 100],
    updatedAt: NOW - DAY,
  });
  const arrival = book({ title: 'arrival', tags: ['Volumes'], createdAt: NOW - DAY });
  const fiction = book({ title: 'fiction', tags: ['Fiction'] });
  const nonfiction = book({ title: 'nonfiction', tags: ['Nonfiction', 'Decision making'] });
  const volume = book({ title: 'volume', tags: ['Volumes'] });
  const finished = book({ title: 'finished', tags: ['Fiction'], readingStatus: 'finished' });
  const abandoned = book({ title: 'abandoned', tags: ['Nonfiction'], readingStatus: 'abandoned' });
  const hidden = book({ title: 'hidden', tags: ['Fiction', 'Hidden'] });
  const deleted = book({ title: 'deleted', tags: ['Fiction'], deletedAt: NOW });
  const subjectOnly = book({ title: 'subject', metadata: { subjects: ['nonfiction'] } as never });
  const all = [
    reading,
    arrival,
    fiction,
    nonfiction,
    volume,
    finished,
    abandoned,
    hidden,
    deleted,
    subjectOnly,
  ];
  const titles = (f: Parameters<typeof applyShelfFilter>[1]) =>
    applyShelfFilter(all, f, NOW).map((b) => b.title);

  test('Reading = being read now plus new arrivals', () => {
    expect(titles('reading')).toEqual(['reading', 'arrival']);
  });
  test('category chips exclude done and hidden books', () => {
    expect(titles('fiction')).toEqual(['reading', 'fiction']);
    expect(titles('nonfiction')).toEqual(['nonfiction', 'subject']);
    expect(titles('volumes')).toEqual(['arrival', 'volume']);
  });
  test('All hides finished, abandoned, hidden and deleted; Finished holds the done ones', () => {
    expect(titles('all')).toEqual([
      'reading',
      'arrival',
      'fiction',
      'nonfiction',
      'volume',
      'subject',
    ]);
    expect(titles('finished')).toEqual(['finished', 'abandoned']);
  });
  test('counts line up with the filters and tags are matched case-insensitively', () => {
    expect(shelfFilterCounts(all, NOW)).toEqual({
      reading: 2,
      fiction: 2,
      nonfiction: 2,
      volumes: 2,
      all: 6,
      finished: 2,
    });
    expect(hasShelfCategories(all)).toBe(true);
    expect(hasShelfCategories([book({ tags: ['Whaling -- Fiction'] })])).toBe(false);
  });
  test('an unknown persisted filter falls back to Reading', () => {
    expect(ensureShelfFilterId('bogus')).toBe('reading');
    expect(ensureShelfFilterId('volumes')).toBe('volumes');
  });
});
