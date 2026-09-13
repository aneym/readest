import { describe, expect, it } from 'vitest';
import { transformBookConfigFromDB, transformBookFromDB } from '@/utils/transform';
import type { DBBook, DBBookConfig } from '@/types/records';

const book = (metadata: unknown) =>
  ({
    book_hash: 'local-book',
    format: 'EPUB',
    title: 'Offline book',
    author: 'Author',
    created_at: 100,
    updated_at: 200,
    metadata,
    metadata_updated_at: 200,
  }) as unknown as DBBook;
const config = (fields: Record<string, unknown>) =>
  ({ book_hash: 'local-book', updated_at: 200, ...fields }) as unknown as DBBookConfig;

describe('Homebase decoded JSON crash regressions', () => {
  it('accepts already-decoded metadata at the exact crashing book transform', () => {
    const metadata = { language: 'en', description: 'keep me' };
    expect(transformBookFromDB(book(metadata)).metadata).toEqual(metadata);
    expect(transformBookFromDB(book(JSON.stringify(metadata))).metadata).toEqual(metadata);
  });
  it('accepts decoded and serialized configuration fields', () => {
    for (const encode of [(v: unknown) => v, JSON.stringify]) {
      expect(
        transformBookConfigFromDB(
          config({
            progress: encode([4, 10]),
            view_settings: encode({ fontSize: 24 }),
            search_config: encode({ query: 'test' }),
            rsvp_position: encode({ wordIndex: 7 }),
          }),
        ),
      ).toMatchObject({
        progress: [4, 10],
        viewSettings: { fontSize: 24 },
        searchConfig: { query: 'test' },
        rsvpPosition: { wordIndex: 7 },
      });
    }
  });
  it.each([
    '[object Object]',
    '{broken',
    'null',
    '42',
    '[]',
    42,
    [],
  ])('omits malformed object fields without replacing existing local data: %j', (value) => {
    const incoming = transformBookFromDB(book(value));
    expect(incoming).not.toHaveProperty('metadata');
    expect(incoming).not.toHaveProperty('metadataUpdatedAt');
    const local = { metadata: { language: 'fr' }, metadataUpdatedAt: 100 };
    expect({ ...local, ...incoming }.metadata).toEqual(local.metadata);
    const incomingConfig = transformBookConfigFromDB(
      config({ view_settings: value, search_config: value }),
    );
    expect(incomingConfig).not.toHaveProperty('viewSettings');
    expect(incomingConfig).not.toHaveProperty('searchConfig');
  });
  it.each([
    'broken',
    {},
    [1],
    [1, '2'],
    [1, Infinity],
    [-1, 10],
    [3, 0],
  ])('ignores invalid progress without clearing local position: %j', (progress) => {
    const incoming = transformBookConfigFromDB(config({ progress }));
    expect(incoming).not.toHaveProperty('progress');
    expect({ progress: [3, 10], ...incoming }.progress).toEqual([3, 10]);
  });
});
