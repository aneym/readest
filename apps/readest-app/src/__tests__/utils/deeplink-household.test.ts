import { describe, expect, it } from 'vitest';
import type { Book } from '@/types/book';
import { parseHouseholdOpenLink, resolveHouseholdBook } from '@/utils/deeplink';
import { transformBookFromDB } from '@/utils/transform';
import type { DBBook } from '@/types/records';

const hash = '0123456789abcdef0123456789abcdef';
const otherHash = 'abcdef0123456789abcdef0123456789';
const book = (overrides: Partial<Book> = {}): Book => ({
  hash,
  calibreId: 131,
  format: 'EPUB',
  title: 'Title',
  author: 'Author',
  createdAt: 100,
  updatedAt: 100,
  ...overrides,
});

describe('Palma launcher deep link', () => {
  it('accepts a Calibre-only link and defaults to read', () => {
    expect(parseHouseholdOpenLink('palma-readest://open?calibreId=131')).toEqual({
      calibreId: 131,
      mode: 'read',
    });
  });

  it('accepts an optional hash and listen mode while ignoring unrelated params', () => {
    expect(
      parseHouseholdOpenLink(`palma-readest://open?calibreId=131&hash=${hash}&mode=listen&extra=1`),
    ).toEqual({ calibreId: 131, hash, mode: 'listen' });
  });

  it.each([
    `palma-readest://open?hash=${hash}`,
    'readest://open?calibreId=131',
    'palma-readest://elsewhere?calibreId=131',
    'palma-readest://open/elsewhere?calibreId=131',
    'palma-readest://open?calibreId=0',
    'palma-readest://open?calibreId=1.1',
    'palma-readest://open?calibreId=9007199254740992',
    'palma-readest://open?calibreId=131&hash=not-a-hash',
    'palma-readest://open?calibreId=131&mode=play',
  ])('rejects malformed requests: %s', (url) => {
    expect(parseHouseholdOpenLink(url)).toBeNull();
  });
});

describe('local household book resolution', () => {
  it('prefers the exact live hash over the matching Calibre ID', () => {
    const exact = book({ hash, calibreId: 555, format: 'PDF' });
    const alternate = book({ hash: otherHash, updatedAt: 500 });
    expect(resolveHouseholdBook([alternate, exact], { hash, calibreId: 131 })).toBe(exact);
  });

  it('skips deleted files and prefers EPUB, then the most recently updated book', () => {
    const deleted = book({ hash, deletedAt: 10 });
    const pdf = book({ hash: otherHash, format: 'PDF', updatedAt: 300 });
    const older = book({ hash: 'older', updatedAt: 100 });
    const newer = book({ hash: 'newer', updatedAt: 200 });
    expect(resolveHouseholdBook([deleted, pdf, older, newer], { hash, calibreId: 131 })).toBe(
      newer,
    );
    expect(resolveHouseholdBook([deleted], { hash, calibreId: 131 })).toBeNull();
    expect(resolveHouseholdBook([pdf], { calibreId: 999 })).toBeNull();
  });
});

describe('Calibre ID from a DB book row', () => {
  const row: DBBook = {
    user_id: 'user',
    book_hash: hash,
    format: 'EPUB',
    title: 'Title',
    author: 'Author',
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
  };

  it('retains a positive integer ID without inventing one for a legacy row', () => {
    expect(transformBookFromDB({ ...row, calibre_id: 131 } as DBBook).calibreId).toBe(131);
    expect(transformBookFromDB(row).calibreId).toBeUndefined();
  });
});
