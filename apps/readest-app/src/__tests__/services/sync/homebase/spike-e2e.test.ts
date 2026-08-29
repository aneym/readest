import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createHomebaseHttpAdapter } from '@/services/sync/homebase/httpAdapter';
import { createMemoryHomebaseAdapter } from '@/services/sync/homebase/memoryAdapter';
import { createMemoryOutboxStore, createSyncOutbox } from '@/services/sync/homebase/outbox';
import { HomebaseSyncClient } from '@/services/sync/homebase/recordSyncClient';
import type { HomebaseEnvelope } from '@/services/sync/homebase/types';
import type { SyncData } from '@/libs/sync';

/**
 * The executable spike: a real HTTP server on loopback, the real HTTP adapter,
 * and the memory reference server standing in for Homebase.
 *
 * This is the part mocks cannot cover — genuine JSON framing, query encoding,
 * status handling and outbox recovery across a socket. If Homebase implements
 * the wire documented in `httpAdapter.ts`, this is the flow it gets.
 */

const AUG = (d: string) => Date.parse(`2026-08-${d}T00:00:00.000Z`);

describe('Homebase spike — end to end over loopback HTTP', () => {
  const backend = createMemoryHomebaseAdapter();
  let server: Server;
  let baseUrl = '';
  /** Simulates a Homebase that is up but unreachable — a retryable failure. */
  let offline = false;
  const requests: string[] = [];

  const readBody = async (req: IncomingMessage): Promise<string> => {
    let body = '';
    req.setEncoding('utf-8');
    for await (const chunk of req) body += chunk;
    return body;
  };

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body === null ? '' : JSON.stringify(body));
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    requests.push(`${req.method} ${url.pathname}`);

    if (offline) return send(res, 503, { error: 'unavailable' });
    if (req.headers.authorization !== 'Bearer spike-token') {
      return send(res, 401, { error: 'unauthorized' });
    }
    if (url.pathname === '/reader/sync/capabilities') {
      return send(res, 200, {
        channels: ['books', 'configs', 'notes', 'statBooks', 'statPages'],
        storage: true,
        noteAudio: true,
        schemaVersion: 1,
      });
    }
    if (url.pathname !== '/reader/sync') return send(res, 404, { error: 'not found' });

    if (req.method === 'GET') {
      const type = url.searchParams.get('type');
      const bookHash = url.searchParams.get('book');
      return send(
        res,
        200,
        await backend.pull({
          since: Number(url.searchParams.get('since') ?? 0),
          ...(type ? { channel: type as 'books' } : {}),
          ...(bookHash ? { bookHash } : {}),
        }),
      );
    }
    if (req.method === 'POST') {
      const payload = JSON.parse(await readBody(req)) as HomebaseEnvelope;
      return send(res, 200, await backend.push(payload));
    }
    return send(res, 405, { error: 'method not allowed' });
  };

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void handle(req, res);
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
  });

  const makeClient = (token = 'spike-token') => {
    const adapter = createHomebaseHttpAdapter(
      {
        baseUrl,
        syncPath: '/reader/sync',
        storagePath: '/reader/storage',
        timeoutMs: 5000,
        clientId: 'spike-device',
      },
      { getToken: async () => token },
    );
    const outbox = createSyncOutbox({ store: createMemoryOutboxStore() });
    return { adapter, outbox, client: new HomebaseSyncClient({ adapter, outbox }) };
  };

  test('the capabilities probe answers over the wire', async () => {
    const caps = await makeClient().adapter.capabilities();
    expect(caps).toMatchObject({ storage: true, noteAudio: true, schemaVersion: 1 });
  });

  test('a book, a config and a voice-annotated highlight round-trip', async () => {
    const { client } = makeClient();
    // Exactly what `useSync` pushes: raw `Book` / `BookConfig` / `BookNote`
    // objects, camelCase, with no `book_hash` on any of them.
    await client.pushChanges({
      books: [
        {
          hash: 'spike-1',
          title: 'Piranesi',
          author: 'Susanna Clarke',
          format: 'EPUB',
          updatedAt: AUG('01'),
          coverHash: 'cov-1',
          coverUpdatedAt: AUG('01'),
        },
      ],
      configs: [{ bookHash: 'spike-1', xpointer: '/body/DocFragment[3]', updatedAt: AUG('01') }],
      notes: [
        {
          bookHash: 'spike-1',
          id: 'note-1',
          type: 'annotation',
          text: 'the halls',
          updatedAt: AUG('01'),
          hbKind: 'voice',
          hbAudioSha256: 'audio-obj-1',
          hbAudioDurationMs: 4200,
          hbTranscriptSource: 'asr',
        },
      ],
    } as unknown as SyncData);

    const pulled = await client.pullChanges(0);
    // The server keyed all three on `book_hash`, which no pushed object had.
    expect(pulled.books?.[0]).toMatchObject({ book_hash: 'spike-1', title: 'Piranesi' });
    expect(pulled.configs?.[0]).toMatchObject({
      book_hash: 'spike-1',
      xpointer: '/body/DocFragment[3]',
    });
    const note = pulled.notes?.[0] as unknown as Record<string, unknown>;
    expect(note['book_hash']).toBe('spike-1');
    expect(note['hbAudioSha256']).toBe('audio-obj-1');
    expect(note['hbAudioDurationMs']).toBe(4200);
  });

  test('a cover edit survives a page-turn that wins the row, across the wire', async () => {
    const { client } = makeClient();
    await client.pushChanges({
      books: [
        {
          hash: 'spike-1',
          title: 'Piranesi',
          updatedAt: AUG('20'),
          coverHash: 'stale-cover',
          coverUpdatedAt: Date.parse('2020-01-01T00:00:00.000Z'),
        },
      ],
    } as unknown as SyncData);
    const pulled = await client.pullChanges(0, 'books', 'spike-1');
    const row = pulled.books?.[0] as unknown as { updated_at?: number; coverHash?: string };
    expect(row.updated_at).toBe(AUG('20'));
    // The row went to the client; the cover did not, because its own clock is
    // six years older than the one already stored.
    expect(row.coverHash).toBe('cov-1');
  });

  test('a delete propagates as a tombstone, not a disappearance', async () => {
    const { client } = makeClient();
    await client.pushChanges({
      books: [{ hash: 'spike-1', updatedAt: AUG('21'), deletedAt: AUG('21') }],
    } as unknown as SyncData);
    const pulled = await client.pullChanges(0, 'books', 'spike-1');
    expect(pulled.books).toHaveLength(1);
    expect(pulled.books?.[0]?.deleted_at).toBe(AUG('21'));
  });

  test('a rejected token surfaces as a permanent AUTH_FAILED', async () => {
    const { client } = makeClient('wrong-token');
    await expect(client.pullChanges(0)).rejects.toMatchObject({
      code: 'AUTH_FAILED',
      retryable: false,
    });
  });

  test('an offline window queues locally and drains when the server returns', async () => {
    const { client, outbox } = makeClient();
    offline = true;

    // The reader keeps working: the push resolves, the write is queued.
    await expect(
      client.pushChanges({
        notes: [{ bookHash: 'spike-1', id: 'offline-note', updatedAt: AUG('22') }],
      } as unknown as SyncData),
    ).resolves.toBeTruthy();
    expect(await outbox.pending()).toHaveLength(1);

    offline = false;
    const flushed = await client.flushOutbox();
    expect(flushed?.pushed).toBe(1);
    expect(backend.rows('notes').some((r) => (r as { id: string }).id === 'offline-note')).toBe(
      true,
    );
    expect(await outbox.pending()).toEqual([]);
  });

  test('every assertion above went through a real socket', () => {
    expect(requests.filter((r) => r.startsWith('POST'))).not.toHaveLength(0);
    expect(requests.filter((r) => r.startsWith('GET'))).not.toHaveLength(0);
  });
});
