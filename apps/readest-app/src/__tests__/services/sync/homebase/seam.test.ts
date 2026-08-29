import { afterEach, describe, expect, test, vi } from 'vitest';
import { SyncClient } from '@/libs/sync';
import type { SyncData, SyncResult } from '@/libs/sync';
import { createMemoryHomebaseAdapter } from '@/services/sync/homebase/memoryAdapter';
import { HomebaseSyncError } from '@/services/sync/homebase/adapter';
import { createMemoryOutboxStore, createSyncOutbox } from '@/services/sync/homebase/outbox';
import {
  HomebaseSyncClient,
  type RecordSyncClient,
  type StockClientConformsToSeam,
} from '@/services/sync/homebase/recordSyncClient';
import { resolveRecordSyncClient } from '@/services/sync/homebase';

/**
 * The seam. Everything else in the spike is machinery; this file is the claim:
 * routing record sync to Homebase is a ONE-LINE change in `SyncContext.tsx`,
 * and it can be proved without making that change.
 */

/** Epoch ms for books/configs/notes; `ISO` for the stats families. */
const AUG = (d: string) => Date.parse(`2026-08-${d}T00:00:00.000Z`);
const ISO = (d: string) => `2026-08-${d}T00:00:00.000Z`;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('type-level conformance', () => {
  test('the stock SyncClient already satisfies RecordSyncClient', () => {
    // If `SyncClient` ever drifts from the seam, this line stops compiling —
    // which is the whole safety story for a landing that swaps the two.
    const proof: StockClientConformsToSeam = true;
    expect(proof).toBe(true);
  });

  test("both clients are assignable to the seam and to statsSync's Pick types", () => {
    const stock: RecordSyncClient = new SyncClient();
    const homebase: RecordSyncClient = new HomebaseSyncClient({
      adapter: createMemoryHomebaseAdapter(),
    });
    // `statsSync.ts` already depends on the client STRUCTURALLY, via
    // `Pick<SyncClient, 'pushChanges'>` / `Pick<SyncClient, 'pullChanges'>`.
    // That is half the seam, already shipping.
    const pushOnly: Pick<SyncClient, 'pushChanges'> = homebase;
    const pullOnly: Pick<SyncClient, 'pullChanges'> = homebase;
    expect(typeof stock.pullChanges).toBe('function');
    expect(typeof pushOnly.pushChanges).toBe('function');
    expect(typeof pullOnly.pullChanges).toBe('function');
  });
});

describe('runtime drop-in', () => {
  /** A consumer written against the seam, standing in for `useSync`. */
  const syncOnce = async (client: RecordSyncClient, payload: SyncData): Promise<SyncResult> => {
    await client.pushChanges(payload);
    return await client.pullChanges(0, 'books');
  };

  test('HomebaseSyncClient round-trips a book through the seam', async () => {
    const client = new HomebaseSyncClient({ adapter: createMemoryHomebaseAdapter() });
    const result = await syncOnce(client, {
      books: [{ hash: 'a', title: 'Piranesi', updatedAt: AUG('01') }],
    } as unknown as SyncData);
    expect(result.books).toHaveLength(1);
    // `hash` went in; `book_hash` came back. That is the backfill doing the one
    // thing a stock client pointed at Homebase would get silently wrong.
    expect(result.books?.[0]).toMatchObject({ book_hash: 'a', title: 'Piranesi' });
  });

  test("pullChanges('stats') returns both stat families", async () => {
    const server = createMemoryHomebaseAdapter();
    server.seed('statBooks', [
      { book_hash: 'a', title: 'Piranesi', authors: 'Susanna Clarke', updated_at: ISO('01') },
    ]);
    server.seed('statPages', [
      {
        book_hash: 'a',
        page: 1,
        start_time: 1,
        duration: 5,
        total_pages: 9,
        updated_at: ISO('01'),
      },
    ]);
    const client = new HomebaseSyncClient({ adapter: server });
    const result = await client.pullChanges(0, 'stats');
    expect(result.statBooks).toHaveLength(1);
    expect(result.statPages).toHaveLength(1);
    // And the cursor field statsSync reduces over is present.
    expect(result.statPages?.[0]?.updated_at_ms).toBeGreaterThan(0);
  });

  test('a tombstone pushed through the seam comes back as a tombstone', async () => {
    // `Book` carries `deletedAt`; the server reads `deleted_at`. Delete a book
    // on one device without the backfill and it quietly stays on every other.
    const client = new HomebaseSyncClient({ adapter: createMemoryHomebaseAdapter() });
    const result = await syncOnce(client, {
      books: [{ hash: 'a', updatedAt: AUG('02'), deletedAt: AUG('02') }],
    } as unknown as SyncData);
    expect(result.books?.[0]?.deleted_at).toBe(AUG('02'));
  });
});

describe('offline behaviour at the seam', () => {
  test('a retryable push failure queues instead of failing the caller', async () => {
    // The local write is already durable. Reporting failure to the user would
    // be a lie, and the stock client's "set syncError and forget it" loses the
    // highlight outright.
    const server = createMemoryHomebaseAdapter();
    const outbox = createSyncOutbox({ store: createMemoryOutboxStore() });
    const onQueued = vi.fn();
    const client = new HomebaseSyncClient({ adapter: server, outbox, onQueued });

    server.failNext(new HomebaseSyncError('offline', 'NETWORK'), 1);
    await expect(
      client.pushChanges({
        notes: [{ bookHash: 'a', id: 'n1', note: 'queued', updatedAt: AUG('01') }],
      } as unknown as SyncData),
    ).resolves.toMatchObject({ books: null, configs: null, notes: null });
    expect(onQueued).toHaveBeenCalledWith(1, expect.objectContaining({ code: 'NETWORK' }));
    expect(server.rows('notes')).toHaveLength(0);

    const flushed = await client.flushOutbox();
    expect(flushed?.pushed).toBe(1);
    expect(server.rows('notes')).toHaveLength(1);
  });

  test('a permanent failure still propagates, outbox or not', async () => {
    const server = createMemoryHomebaseAdapter();
    const client = new HomebaseSyncClient({
      adapter: server,
      outbox: createSyncOutbox({ store: createMemoryOutboxStore() }),
    });
    server.failNext(new HomebaseSyncError('revoked', 'AUTH_FAILED', 401), 1);
    await expect(client.pushChanges({ books: [] } as unknown as SyncData)).rejects.toMatchObject({
      code: 'AUTH_FAILED',
    });
  });

  test('without an outbox the failure propagates exactly like the stock client', async () => {
    const server = createMemoryHomebaseAdapter();
    const client = new HomebaseSyncClient({ adapter: server });
    server.failNext(new HomebaseSyncError('offline', 'NETWORK'), 1);
    await expect(client.pushChanges({ books: [] } as unknown as SyncData)).rejects.toBeInstanceOf(
      HomebaseSyncError,
    );
  });
});

describe('resolveRecordSyncClient — the one-line replacement', () => {
  test('returns the stock client when Homebase is unconfigured', () => {
    // This is the property that lets the flag land dark: with nothing set, the
    // swapped line produces exactly what ships today.
    expect(resolveRecordSyncClient()).toBeInstanceOf(SyncClient);
  });

  test('a base URL alone is not enough — the opt-in is separate', () => {
    // A deployment must be able to stage the endpoint (health checks, fixture
    // replay) before any device routes real reading data at it.
    vi.stubEnv('HOMEBASE_API_BASE_URL', 'https://homebase.lan');
    expect(resolveRecordSyncClient()).toBeInstanceOf(SyncClient);
  });

  test('returns the Homebase client only with both URL and flag', () => {
    vi.stubEnv('HOMEBASE_API_BASE_URL', 'https://homebase.lan');
    vi.stubEnv('HOMEBASE_SYNC_ENABLED', '1');
    expect(resolveRecordSyncClient()).toBeInstanceOf(HomebaseSyncClient);
  });

  test('the flag alone, with no endpoint, stays on the stock client', () => {
    vi.stubEnv('HOMEBASE_SYNC_ENABLED', 'true');
    expect(resolveRecordSyncClient()).toBeInstanceOf(SyncClient);
  });
});
