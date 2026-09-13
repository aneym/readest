import { describe, expect, it } from 'vitest';
import { createSyncOutbox, createMemoryOutboxStore } from '@/services/sync/homebase/outbox';
import { createPersistentOutboxStore } from '@/services/sync/homebase/persistence';
import { HomebaseSyncError } from '@/services/sync/homebase/adapter';
const note = (id: string, time = 1) => ({ id, book_hash: 'hash', updated_at: time });
describe('durable queue regressions', () => {
  it('concurrent enqueue and in-flight replacement survive an old acknowledgement', async () => {
    const store = createMemoryOutboxStore(),
      box = createSyncOutbox({ store });
    await Promise.all([box.enqueue('notes', [note('a')]), box.enqueue('notes', [note('b')])]);
    expect(await box.pending()).toHaveLength(2);
    let unblock!: () => void, started!: () => void;
    const began = new Promise<void>((r) => (started = r)),
      gate = new Promise<void>((r) => (unblock = r));
    const flush = box.flush(async () => {
      started();
      await gate;
    });
    await began;
    await box.enqueue('notes', [note('a', 2), note('c')]);
    unblock();
    await flush;
    const remaining = await box.pending();
    expect(remaining.map((x) => ('id' in x.record ? x.record.id : undefined)).sort()).toEqual([
      'a',
      'c',
    ]);
    expect(
      remaining.find((x) => ('id' in x.record ? x.record.id : undefined) === 'a')?.record
        .updated_at,
    ).toBe(2);
  });
  it('persists each acknowledged batch before the next request and never poisons offline rows', async () => {
    const store = createMemoryOutboxStore(),
      box = createSyncOutbox({ store, batchSize: 1, maxAttempts: 1 });
    await box.enqueue('notes', [note('a'), note('b')]);
    let calls = 0;
    const result = await box.flush(async () => {
      if (++calls === 2) {
        expect(
          (await store.read()).map((x) => ('id' in x.record ? x.record.id : undefined)),
        ).toEqual(['b']);
        throw new HomebaseSyncError('offline', 'NETWORK');
      }
    });
    expect(result.poisoned).toHaveLength(0);
    expect(result.remaining).toBe(1);
  });
  it('cannot report durable success without storage or overwrite corrupt queue data', async () => {
    await expect(createPersistentOutboxStore(null).write([])).rejects.toThrow();
    const storage = {
      getItem: () => '{corrupt',
      setItem: () => {
        throw Error('must not overwrite');
      },
    };
    await expect(createPersistentOutboxStore(storage).read()).rejects.toThrow();
  });
});
