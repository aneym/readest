import { describe, expect, test, vi } from 'vitest';
import { HomebaseSyncError } from '@/services/sync/homebase/adapter';
import { createMemoryHomebaseAdapter } from '@/services/sync/homebase/memoryAdapter';
import {
  createMemoryOutboxStore,
  createSyncOutbox,
  outboxKey,
} from '@/services/sync/homebase/outbox';
import type { HomebaseEnvelope } from '@/services/sync/homebase/types';

/** Epoch ms — the dialect books/configs/notes carry on `updated_at`. */
const AUG = (d: string) => Date.parse(`2026-08-${d}T00:00:00.000Z`);

const makeOutbox = (over: { maxAttempts?: number; batchSize?: number } = {}) => {
  let t = 0;
  return createSyncOutbox({
    store: createMemoryOutboxStore(),
    now: () => ++t,
    ...over,
  });
};

describe('outboxKey', () => {
  test('matches the server upsert keys per channel', () => {
    expect(outboxKey('books', { book_hash: 'a' })).toBe('books:a');
    expect(outboxKey('configs', { book_hash: 'a' })).toBe('configs:a');
    expect(outboxKey('notes', { book_hash: 'a', id: 'n1' })).toBe('notes:a:n1');
    expect(
      outboxKey('statPages', {
        book_hash: 'a',
        page: 4,
        start_time: 900,
        duration: 1,
        total_pages: 10,
      }),
    ).toBe('statPages:a:4:900');
  });
});

describe('coalescing', () => {
  test('twenty minutes of page-turns collapse to one queued row', () => {
    // The failure this prevents: an offline reader queues 400 near-identical
    // config rows and then pushes all of them the moment the train exits a
    // tunnel.
    const outbox = makeOutbox();
    return (async () => {
      for (let i = 1; i <= 400; i++) {
        await outbox.enqueue('configs', [
          { book_hash: 'a', updated_at: 1_700_000_000_000 + i * 1000 },
        ]);
      }
      const pending = await outbox.pending();
      expect(pending).toHaveLength(1);
      expect(pending[0]?.record.updated_at).toBe(1_700_000_000_000 + 400_000);
    })();
  });

  test('coalescing keeps the LATEST row by the same clock the server uses', async () => {
    const outbox = makeOutbox();
    await outbox.enqueue('books', [{ book_hash: 'a', title: 'new', updated_at: AUG('09') }]);
    await outbox.enqueue('books', [{ book_hash: 'a', title: 'stale', updated_at: AUG('01') }]);
    const pending = await outbox.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.record).toMatchObject({ title: 'new' });
  });

  test('coalescing preserves the ORIGINAL queue position', async () => {
    // Refreshing queuedAt would push an old write behind a newer one for a
    // different book, and the server's LWW would then keep the wrong row.
    const outbox = makeOutbox();
    await outbox.enqueue('books', [{ book_hash: 'first', updated_at: AUG('01') }]);
    await outbox.enqueue('books', [{ book_hash: 'second', updated_at: AUG('01') }]);
    await outbox.enqueue('books', [{ book_hash: 'first', updated_at: AUG('02') }]);
    const pending = await outbox.pending();
    expect(pending.map((e) => e.record.book_hash)).toEqual(['first', 'second']);
  });

  test('different notes on the same book stay separate entries', async () => {
    const outbox = makeOutbox();
    await outbox.enqueue('notes', [
      { book_hash: 'a', id: 'n1', updated_at: AUG('01') },
      { book_hash: 'a', id: 'n2', updated_at: AUG('01') },
    ]);
    expect(await outbox.pending()).toHaveLength(2);
  });
});

describe('flush', () => {
  test('drains into the adapter and empties the queue', async () => {
    const outbox = makeOutbox();
    const server = createMemoryHomebaseAdapter();
    await outbox.enqueue('books', [{ book_hash: 'a', updated_at: AUG('01') }]);
    await outbox.enqueue('notes', [{ book_hash: 'a', id: 'n1', updated_at: AUG('01') }]);

    const result = await outbox.flush((env) => server.push(env));
    expect(result.pushed).toBe(2);
    expect(result.remaining).toBe(0);
    expect(await outbox.pending()).toEqual([]);
    expect(server.rows('books')).toHaveLength(1);
    expect(server.rows('notes')).toHaveLength(1);
  });

  test('a batch carries every channel in one envelope', async () => {
    const outbox = makeOutbox();
    const sent: HomebaseEnvelope[] = [];
    await outbox.enqueue('books', [{ book_hash: 'a', updated_at: AUG('01') }]);
    await outbox.enqueue('configs', [{ book_hash: 'a', updated_at: AUG('01') }]);
    await outbox.flush(async (env) => {
      sent.push(env);
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.books).toHaveLength(1);
    expect(sent[0]?.configs).toHaveLength(1);
  });

  test('stops at the first retryable failure and keeps ORDER', async () => {
    // Draining past a failure lets a later write land before an earlier one,
    // and the server's LWW then keeps the wrong row.
    const outbox = makeOutbox({ batchSize: 1 });
    for (const hash of ['a', 'b', 'c']) {
      await outbox.enqueue('books', [{ book_hash: hash, updated_at: AUG('01') }]);
    }
    const push = vi
      .fn<(env: HomebaseEnvelope) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new HomebaseSyncError('offline', 'NETWORK'));

    const result = await outbox.flush(push);
    expect(result.pushed).toBe(1);
    expect(result.remaining).toBe(2);
    expect(result.stoppedBy?.code).toBe('NETWORK');
    expect(push).toHaveBeenCalledTimes(2);
    expect((await outbox.pending()).map((e) => e.record.book_hash)).toEqual(['b', 'c']);
  });

  test('resumes from where it stopped on the next flush', async () => {
    const outbox = makeOutbox({ batchSize: 1 });
    const server = createMemoryHomebaseAdapter();
    for (const hash of ['a', 'b']) {
      await outbox.enqueue('books', [{ book_hash: hash, updated_at: AUG('01') }]);
    }
    server.failNext(new HomebaseSyncError('offline', 'NETWORK'), 1);
    await outbox.flush((env) => server.push(env));
    expect(await outbox.pending()).toHaveLength(2);

    const second = await outbox.flush((env) => server.push(env));
    expect(second.pushed).toBe(2);
    expect(
      server
        .rows('books')
        .map((r) => r.book_hash)
        .sort(),
    ).toEqual(['a', 'b']);
  });

  test('a permanent failure poisons immediately instead of hammering the server', async () => {
    const outbox = makeOutbox();
    await outbox.enqueue('books', [{ book_hash: 'a', updated_at: AUG('01') }]);
    const result = await outbox.flush(async () => {
      throw new HomebaseSyncError('bad request', 'UNKNOWN', 400);
    });
    expect(result.pushed).toBe(0);
    expect(result.poisoned).toHaveLength(1);
    expect(result.poisoned[0]?.lastError).toBe('bad request');
    // Poisoned entries are OUT of the retry path but still visible.
    expect(await outbox.pending()).toEqual([]);
    expect(await outbox.clearPoisoned()).toHaveLength(1);
  });

  test('a retryable failure poisons only after maxAttempts', async () => {
    const outbox = makeOutbox({ maxAttempts: 3 });
    await outbox.enqueue('books', [{ book_hash: 'a', updated_at: AUG('01') }]);
    const fail = async () => {
      throw new HomebaseSyncError('offline', 'NETWORK');
    };
    expect((await outbox.flush(fail)).poisoned).toHaveLength(0);
    expect((await outbox.flush(fail)).poisoned).toHaveLength(0);
    const third = await outbox.flush(fail);
    expect(third.poisoned).toHaveLength(1);
    // One malformed record must not wedge the queue forever.
    expect(await outbox.pending()).toEqual([]);
  });

  test('a non-HomebaseSyncError is treated as permanent', async () => {
    const outbox = makeOutbox();
    await outbox.enqueue('books', [{ book_hash: 'a', updated_at: AUG('01') }]);
    const result = await outbox.flush(async () => {
      throw new TypeError('undefined is not a function');
    });
    expect(result.poisoned).toHaveLength(1);
  });

  test('flushing an empty outbox is a no-op', async () => {
    const push = vi.fn();
    const result = await makeOutbox().flush(push);
    expect(result).toMatchObject({ pushed: 0, remaining: 0 });
    expect(push).not.toHaveBeenCalled();
  });
});

describe('enqueueEnvelope', () => {
  test('splits a push payload back into per-channel entries', async () => {
    const outbox = makeOutbox();
    await outbox.enqueueEnvelope({
      books: [{ book_hash: 'a', updated_at: AUG('01') }],
      notes: [{ book_hash: 'a', id: 'n1', updated_at: AUG('01') }],
      statPages: null,
    });
    const pending = await outbox.pending();
    expect(pending.map((e) => e.channel).sort()).toEqual(['books', 'notes']);
  });
});
