import { describe, expect, test, vi } from 'vitest';
import { createImmersionClient, ImmersionApiError } from '@/services/homebase/immersion/client';

const half = { state: 'have', id: '1' };
const pair = { state: 'aligned', pairId: 'p/1', stage: 'done', progress: 1 };
const result = {
  key: 'title|author',
  title: 'Title',
  author: 'Author',
  ebook: half,
  audiobook: half,
  pair,
};
const record = {
  id: 'r1',
  profileId: 'profile',
  deviceId: 'device',
  title: 'Title',
  author: 'Author',
  want: 'pair',
  ebook: half,
  audiobook: half,
  pair,
  createdAt: 1,
  updatedAt: 2,
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const setup = (response: unknown = { ok: true }) => {
  const fakeFetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => json(response));
  const client = createImmersionClient({
    baseUrl: 'https://home.example///',
    token: 'private-token',
    fetch: fakeFetch as typeof fetch,
  });
  if (!client) throw new Error('Expected configured client');
  return { client, fakeFetch };
};

describe('Homebase immersion client', () => {
  test('routes all methods to the origin with JSON and bearer authorization', async () => {
    const bodies = [
      { ok: true, results: [result] },
      { ok: true, request: record },
      { ok: true, requests: [record] },
      { ok: true, books: { hash: pair } },
      { ok: true, pair },
      { ok: true, pair },
    ];
    const fakeFetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      json(bodies.shift()),
    );
    const client = createImmersionClient({
      baseUrl: 'https://home.example///',
      token: 'private-token',
      fetch: fakeFetch as typeof fetch,
    });
    expect(client).not.toBeNull();
    await expect(client!.search('  A & B  ')).resolves.toEqual([result]);
    await expect(
      client!.createRequest({ title: 'Title', author: 'Author', want: 'pair' }),
    ).resolves.toEqual(record);
    await expect(client!.listRequests()).resolves.toEqual([record]);
    await expect(client!.status()).resolves.toEqual({ hash: pair });
    await expect(client!.confirmPair('p/1 ?')).resolves.toEqual(pair);
    await expect(client!.realignPair('p/1 ?')).resolves.toEqual(pair);
    expect(fakeFetch.mock.calls.map(([url]) => url)).toEqual([
      'https://home.example/api/readest/immersion/search?q=A%20%26%20B',
      'https://home.example/api/readest/immersion/requests',
      'https://home.example/api/readest/immersion/requests',
      'https://home.example/api/readest/immersion/status',
      'https://home.example/api/readest/immersion/pairs/p%2F1%20%3F/confirm',
      'https://home.example/api/readest/immersion/pairs/p%2F1%20%3F/realign',
    ]);
    for (const [, init] of fakeFetch.mock.calls) {
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer private-token',
        Accept: 'application/json',
      });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(fakeFetch.mock.calls[1]?.[1]?.headers).toMatchObject({
      'Content-Type': 'application/json',
    });
    expect(fakeFetch.mock.calls[1]?.[1]?.body).toBe(
      JSON.stringify({ title: 'Title', author: 'Author', want: 'pair' }),
    );
    expect(fakeFetch.mock.calls[4]?.[1]?.headers).toMatchObject({
      'Content-Type': 'application/json',
    });
  });

  test('returns empty results for an empty query without fetching', async () => {
    const { client, fakeFetch } = setup();
    await expect(client.search(' \n ')).resolves.toEqual([]);
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  test('drops malformed list rows and status entries', async () => {
    const responses = [
      { ok: true, results: [result, { ...result, audiobook: { state: 'bad' } }, null] },
      { ok: true, requests: [record, { ...record, createdAt: 'yesterday' }, {}] },
      { ok: true, books: { good: pair, bad: { state: 'unknown' } } },
      { ok: true },
      { ok: true },
    ];
    const fakeFetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      json(responses.shift()),
    );
    const client = createImmersionClient({
      baseUrl: 'https://home.example',
      token: 't',
      fetch: fakeFetch as typeof fetch,
    })!;
    await expect(client.search('Title')).resolves.toEqual([result]);
    await expect(client.listRequests()).resolves.toEqual([record]);
    await expect(client.status()).resolves.toEqual({ good: pair });
    await expect(client.search('Title')).resolves.toEqual([]);
    await expect(client.listRequests()).resolves.toEqual([]);
  });

  test.each([
    [403, { ok: false, error: 'rejected private-token', code: 'DENIED' }],
    [500, { ok: true, error: 'server failed', code: 'FAILED' }],
    [200, { ok: false, error: 'bad request', code: 'BAD_REQUEST' }],
  ])('maps HTTP %i and API failures to sanitized typed errors', async (status, body) => {
    const fakeFetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      json(body, status),
    );
    const client = createImmersionClient({
      baseUrl: 'https://home.example',
      token: 'private-token',
      fetch: fakeFetch as typeof fetch,
    })!;
    const error = await client.search('Title').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ImmersionApiError);
    expect(error).toMatchObject({ status, code: body.code });
    expect((error as ImmersionApiError).message).not.toContain('private-token');
  });

  test('does not create a client without a base URL or token', () => {
    expect(createImmersionClient({ baseUrl: null, token: 'token' })).toBeNull();
    expect(createImmersionClient({ baseUrl: 'https://home.example', token: null })).toBeNull();
  });
});
