import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  enqueueRequest,
  flushQueue,
  loadQueue,
  loadRejected,
  startQueueAutoFlush,
  submitRequest,
} from '@/services/discover/requestQueue';

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));
vi.mock('@/services/sync/homebase/config', () => ({
  getHomebaseBaseUrl: () => 'https://studio.tailf266ac.ts.net:3148/api/readest',
}));

type Reply = number | 'network';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

let online = true;
let vpn: 'ok' | 'vpn_down' = 'ok';
/** Status to answer POST /requests with, by title; default 202. A list is used up one send at a time. */
let replies: Record<string, Reply | Reply[]> = {};
/** Server error text to answer a refused POST with, by title. */
let errorText: Record<string, string> = {};
const posted: { title: string; want: string; requestId?: string }[] = [];

const server = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.endsWith('/providers')) {
    return json(200, { providers: [], acquisition: { state: vpn, detail: null, checkedAt: 1 } });
  }
  if (url.endsWith('/requests')) {
    const body = JSON.parse(String(init?.body));
    posted.push(body);
    const planned = replies[body.title];
    const reply = (Array.isArray(planned) ? planned.shift() : planned) ?? 202;
    if (reply === 'network') throw new TypeError('Failed to fetch');
    if (reply === 202) return json(202, { jobs: [{ id: `job-${body.title}` }] });
    return json(reply, { error: errorText[body.title] ?? 'server text that must not surface' });
  }
  return json(404, { error: 'Discover route not found' });
});

beforeEach(() => {
  localStorage.clear();
  online = true;
  vpn = 'ok';
  replies = {};
  errorText = {};
  posted.length = 0;
  vi.stubEnv('NEXT_PUBLIC_APP_PLATFORM', 'web');
  vi.stubGlobal('fetch', server);
  vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  server.mockClear();
});

describe('Discover request queue', () => {
  test('a request made offline is stored with a replayable id and sends nothing', async () => {
    online = false;

    const result = await submitRequest({
      title: 'Dune',
      author: 'Frank Herbert',
      want: 'ebook',
      ebookOfferId: 'offer-that-will-expire',
    });

    expect(result.outcome).toBe('queued');
    expect(server).not.toHaveBeenCalled();
    const queue = loadQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0]!.requestId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(queue[0]!.body).toEqual({
      title: 'Dune',
      author: 'Frank Herbert',
      want: 'ebook',
      requestId: queue[0]!.requestId,
    });
  });

  test('a network failure while sending queues the request under the id it was sent with', async () => {
    replies = { Dune: 'network' };

    const result = await submitRequest({ title: 'Dune', author: 'Frank Herbert', want: 'pair' });

    expect(result.outcome).toBe('queued');
    expect(loadQueue().map((entry) => entry.requestId)).toEqual([posted[0]!.requestId]);
  });

  test('the same title, author and want is queued once, however it is typed', () => {
    enqueueRequest({
      title: 'The Left Hand of Darkness',
      author: 'Ursula K. Le Guin',
      want: 'pair',
    });
    enqueueRequest({
      title: 'the left hand of darkness ',
      author: 'Ursula K Le Guin',
      want: 'pair',
    });
    enqueueRequest({ title: 'Cien años de soledad', author: 'García Márquez', want: 'ebook' });
    enqueueRequest({ title: 'Cien anos de soledad', author: 'Garcia Marquez', want: 'ebook' });
    enqueueRequest({
      title: 'The Left Hand of Darkness',
      author: 'Ursula K. Le Guin',
      want: 'ebook',
    });

    expect(loadQueue().map((entry) => `${entry.body.title}|${entry.body.want}`)).toEqual([
      'The Left Hand of Darkness|pair',
      'Cien años de soledad|ebook',
      'The Left Hand of Darkness|ebook',
    ]);
  });

  test('coming back online flushes the queue oldest first', async () => {
    online = false;
    enqueueRequest({ title: 'First', author: 'A', want: 'ebook' });
    enqueueRequest({ title: 'Second', author: 'B', want: 'audiobook' });
    enqueueRequest({ title: 'Third', author: 'C', want: 'pair' });
    const flushed = new Promise<unknown>((resolve) => {
      const stop = startQueueAutoFlush((outcome) => {
        stop();
        resolve(outcome);
      });
    });

    online = true;
    window.dispatchEvent(new Event('online'));

    await expect(flushed).resolves.toMatchObject({ sent: 3, remaining: 0, held: null });
    expect(posted.map((body) => body.title)).toEqual(['First', 'Second', 'Third']);
    expect(loadQueue()).toEqual([]);
  });

  test('a network error keeps the entry and everything behind it', async () => {
    enqueueRequest({ title: 'First', author: 'A', want: 'ebook' });
    enqueueRequest({ title: 'Second', author: 'B', want: 'ebook' });
    replies = { First: 'network' };

    const outcome = await flushQueue();

    expect(outcome).toMatchObject({ sent: 0, remaining: 2, held: 'offline' });
    expect(posted.map((body) => body.title)).toEqual(['First']);
    const [first, second] = loadQueue();
    expect(first).toMatchObject({ attempts: 1, lastError: 'offline' });
    expect(second).toMatchObject({ attempts: 0, lastError: null });
  });

  test('202 drops the entry; a validation 400 drops it and is remembered for display', async () => {
    enqueueRequest({ title: 'Accepted', author: 'A', want: 'ebook' });
    enqueueRequest({ title: 'Invalid', author: 'C', want: 'ebook' });
    replies = { Invalid: 400 };

    const outcome = await flushQueue();

    expect(outcome).toMatchObject({ sent: 1, dropped: 1, remaining: 0, held: null });
    expect(outcome.jobs.map((job) => job.id)).toEqual(['job-Accepted']);
    expect(loadQueue()).toEqual([]);
    expect(loadRejected()).toEqual([
      expect.objectContaining({
        title: 'Invalid',
        status: 400,
        want: 'ebook',
        reason: 'unreadable',
      }),
    ]);
    expect(JSON.stringify(loadRejected())).not.toContain('server text');
  });

  test('a dropped request keeps the specific reason Homebase gave, as a code', async () => {
    enqueueRequest({ title: 'Nameless', author: ' ', want: 'ebook' });
    enqueueRequest({ title: 'Stale', author: 'S', want: 'audiobook' });
    replies = { Nameless: 400, Stale: 400 };
    errorText = { Nameless: 'Invalid author', Stale: 'Offer is unknown or expired; search again' };

    const outcome = await flushQueue();

    expect(outcome).toMatchObject({ sent: 0, dropped: 2, remaining: 0 });
    const reasons = Object.fromEntries(loadRejected().map((item) => [item.title, item.reason]));
    expect(reasons).toEqual({ Nameless: 'author', Stale: 'offer_expired' });
    expect(JSON.stringify(loadRejected())).not.toMatch(/Invalid author|search again/);
  });

  test('a 409 id conflict resends the request under a fresh id instead of discarding it', async () => {
    const { requestId: clashing } = enqueueRequest({ title: 'Dune', author: 'F', want: 'ebook' });
    replies = { Dune: [409, 202] };

    const outcome = await flushQueue();

    expect(outcome).toMatchObject({ sent: 1, dropped: 0, remaining: 0, held: null });
    expect(outcome.jobs.map((job) => job.id)).toEqual(['job-Dune']);
    expect(posted.map((body) => body.requestId)).toEqual([clashing, expect.any(String)]);
    expect(posted[1]!.requestId).not.toBe(clashing);
    expect(loadRejected()).toEqual([]);
  });

  test('a request that still conflicts after a fresh id is shown as not sent', async () => {
    enqueueRequest({ title: 'Dune', author: 'F', want: 'ebook' });
    replies = { Dune: [409, 409] };

    const outcome = await flushQueue();

    expect(outcome).toMatchObject({ sent: 0, dropped: 1, remaining: 0 });
    expect(loadRejected()).toEqual([
      expect.objectContaining({ title: 'Dune', status: 409, reason: 'id_conflict' }),
    ]);
  });

  test('with the VPN lane down, queued requests stay put instead of failing on the server', async () => {
    enqueueRequest({ title: 'Dune', author: 'Frank Herbert', want: 'pair' });
    vpn = 'vpn_down';

    const outcome = await flushQueue();

    expect(outcome).toMatchObject({ sent: 0, remaining: 1, held: 'vpn' });
    expect(posted).toEqual([]);
  });
});
