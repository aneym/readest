import { describe, expect, test } from 'vitest';
import {
  createPersistentOutboxStore,
  getHomebaseToken,
  getOrCreateHomebaseClientId,
  type HomebaseStorage,
} from '@/services/sync/homebase/persistence';
import type { OutboxEntry } from '@/services/sync/homebase/outbox';

const createStorage = (): HomebaseStorage => {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
};

const entry: OutboxEntry = {
  key: 'books:a',
  channel: 'books',
  record: { book_hash: 'a', updated_at: 1 },
  queuedAt: 2,
  attempts: 0,
};

describe('Homebase persistence', () => {
  test('the outbox survives a store round-trip', async () => {
    const storage = createStorage();
    await createPersistentOutboxStore(storage).write([entry]);

    const afterRestart = createPersistentOutboxStore(storage);
    await expect(afterRestart.read()).resolves.toEqual([entry]);
  });

  test('the client id is generated once per install', () => {
    const storage = createStorage();
    const first = getOrCreateHomebaseClientId(storage);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(getOrCreateHomebaseClientId(storage)).toBe(first);
  });

  test("the token source reads localStorage's token key", async () => {
    const storage = createStorage();
    storage.setItem('token', 'paired-token');
    await expect(getHomebaseToken(storage)).resolves.toBe('paired-token');
  });
});
