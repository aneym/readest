import { describe, expect, test, vi } from 'vitest';
import { HomebaseSyncError } from '@/services/sync/homebase/adapter';
import { createHomebaseHttpAdapter } from '@/services/sync/homebase/httpAdapter';
import { createMemoryHomebaseAdapter } from '@/services/sync/homebase/memoryAdapter';
import type { HomebaseSyncConfig } from '@/services/sync/homebase/config';
import type { HomebaseChannel, HomebaseRecord } from '@/services/sync/homebase/types';
import { runAdapterSemanticContract, type AdapterScenario } from './adapterSemanticContract';

const CONFIG: HomebaseSyncConfig = {
  baseUrl: 'https://homebase.lan',
  syncPath: '/reader/sync',
  storagePath: '/reader/storage',
  timeoutMs: 15000,
  clientId: 'test-device',
};

const json = (status: number, body: unknown) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/** HTTP scenario: stage wire responses on a fetch mock. */
const httpScenario = (): AdapterScenario => {
  let next: () => Promise<Response> = async () => json(200, {});
  const fetchImpl = vi.fn(async () => await next());
  return {
    makeAdapter: () =>
      createHomebaseHttpAdapter(CONFIG, {
        getToken: async () => 'token',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    stageRows: (channel, rows) => {
      next = async () => json(200, { [channel]: rows });
    },
    stageAuthFailure: () => {
      next = async () => json(401, { error: 'expired' });
    },
    stageNetworkFailure: () => {
      next = async () => {
        throw new TypeError('Failed to fetch');
      };
    },
    stageMissingCapabilities: () => {
      next = async () => json(404, null);
    },
  };
};

/** Memory scenario: the adapter IS the server, so staging means seeding. */
const memoryScenario = (): AdapterScenario => {
  const adapter = createMemoryHomebaseAdapter({
    now: () => Date.parse('2026-08-10T00:00:00.000Z'),
  });
  return {
    makeAdapter: () => adapter,
    stageRows: (channel: HomebaseChannel, rows: HomebaseRecord[]) => adapter.seed(channel, rows),
    stageAuthFailure: () =>
      adapter.failNext(new HomebaseSyncError('expired', 'AUTH_FAILED', 401), 1),
    stageNetworkFailure: () => adapter.failNext(new HomebaseSyncError('offline', 'NETWORK'), 1),
    stageMissingCapabilities: () => {
      // A memory server with no capability table is the same signal as a 404:
      // "assume v1", not "unusable".
      const bare = createMemoryHomebaseAdapter({ capabilities: null });
      adapter.capabilities = bare.capabilities.bind(bare);
    },
  };
};

runAdapterSemanticContract('http', httpScenario);
runAdapterSemanticContract('memory', memoryScenario);

describe('HTTP adapter — wire details', () => {
  test('sends the bearer token, client id and schema header', async () => {
    const fetchImpl = vi.fn(async () => json(200, {}));
    const adapter = createHomebaseHttpAdapter(CONFIG, {
      getToken: async () => 'secret-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await adapter.pull({ since: 0 });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer secret-token');
    expect(headers['X-Homebase-Client']).toBe('test-device');
    expect(headers['X-Homebase-Schema']).toBe('1');
  });

  test('refuses to call the server when signed out', async () => {
    const fetchImpl = vi.fn(async () => json(200, {}));
    const adapter = createHomebaseHttpAdapter(CONFIG, {
      getToken: async () => null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(adapter.pull({ since: 0 })).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('encodes the pull cursor and filters as query params', async () => {
    const fetchImpl = vi.fn(async () => json(200, {}));
    const adapter = createHomebaseHttpAdapter(CONFIG, {
      getToken: async () => 't',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await adapter.pull({ since: 1700, channel: 'notes', bookHash: 'h', metaHash: 'm', limit: 50 });
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toContain('https://homebase.lan/reader/sync?');
    expect(url).toContain('since=1700');
    expect(url).toContain('type=notes');
    expect(url).toContain('book=h');
    expect(url).toContain('meta_hash=m');
    expect(url).toContain('limit=50');
  });

  test('maps 429 and 5xx to retryable, 409 to a permanent conflict', async () => {
    const cases: [number, string, boolean][] = [
      [429, 'RATE_LIMITED', true],
      [503, 'NETWORK', true],
      [409, 'CONFLICT', false],
      [400, 'UNKNOWN', false],
    ];
    for (const [status, code, retryable] of cases) {
      const adapter = createHomebaseHttpAdapter(CONFIG, {
        getToken: async () => 't',
        fetchImpl: (async () => json(status, { error: 'x' })) as unknown as typeof fetch,
      });
      const err = (await adapter.pull({ since: 0 }).catch((e) => e)) as HomebaseSyncError;
      expect(err.code).toBe(code);
      expect(err.retryable).toBe(retryable);
    }
  });

  test('a timeout aborts and surfaces as retryable NETWORK', async () => {
    const adapter = createHomebaseHttpAdapter(
      { ...CONFIG, timeoutMs: 5 },
      {
        getToken: async () => 't',
        fetchImpl: ((_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          })) as unknown as typeof fetch,
      },
    );
    const err = (await adapter.pull({ since: 0 }).catch((e) => e)) as HomebaseSyncError;
    expect(err.code).toBe('NETWORK');
    expect(err.retryable).toBe(true);
  });
});

describe('memory adapter — reference server behaviour', () => {
  test('advances the cursor with synced_at, not updated_at', async () => {
    // #4678: a server-resolved merge must reach peers without reordering a
    // date-sorted library, so the pull cursor is the server clock.
    let clock = Date.parse('2026-08-10T00:00:00.000Z');
    const adapter = createMemoryHomebaseAdapter({ now: () => clock });
    const stale = Date.parse('2020-01-01T00:00:00.000Z');
    await adapter.push({ books: [{ book_hash: 'a', updated_at: stale }] });
    const env = await adapter.pull({ since: clock - 1, channel: 'books' });
    expect(env.books).toHaveLength(1);
    // The row's own updated_at is six years stale; it is still newly synced,
    // and the server did not rewrite the client's clock to make that true.
    expect(env.books?.[0]?.updated_at).toBe(stale);

    clock += 1000;
    const after = await adapter.pull({ since: clock, channel: 'books' });
    expect(after.books).toEqual([]);
  });

  test("expands the 'stats' selector into both stat families", async () => {
    const adapter = createMemoryHomebaseAdapter();
    // Stats are the one family whose `updated_at` really is ISO on the wire.
    adapter.seed('statBooks', [
      { book_hash: 'a', title: 'T', authors: 'A', updated_at: '2026-08-01T00:00:00.000Z' },
    ]);
    adapter.seed('statPages', [
      {
        book_hash: 'a',
        page: 1,
        start_time: 1,
        duration: 10,
        total_pages: 300,
        updated_at: '2026-08-01T00:00:00.000Z',
      },
    ]);
    const env = await adapter.pull({ since: 0, channel: 'stats' });
    expect(env.statBooks).toHaveLength(1);
    expect(env.statPages).toHaveLength(1);
    expect(env.books).toBeUndefined();
  });

  test('upserts notes on (book_hash, id), not book_hash alone', async () => {
    const adapter = createMemoryHomebaseAdapter();
    await adapter.push({
      notes: [
        { book_hash: 'a', id: 'n1', text: 'one', updated_at: Date.parse('2026-08-01T00:00:00Z') },
        { book_hash: 'a', id: 'n2', text: 'two', updated_at: Date.parse('2026-08-01T00:00:00Z') },
      ],
    });
    expect(adapter.rows('notes')).toHaveLength(2);
  });

  test('returns the winning row to a client that lost the merge', async () => {
    const adapter = createMemoryHomebaseAdapter();
    adapter.seed('books', [
      { book_hash: 'a', title: 'Server', updated_at: Date.parse('2026-08-05T00:00:00Z') },
    ]);
    const applied = await adapter.push({
      books: [{ book_hash: 'a', title: 'Stale', updated_at: Date.parse('2026-08-01T00:00:00Z') }],
    });
    expect(applied.books?.[0]?.title).toBe('Server');
  });
});
