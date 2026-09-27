import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { discoverClient, DISCOVER_TIMEOUT_MS } from '@/services/discover/client';

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));
vi.mock('@/services/sync/homebase/config', () => ({
  getHomebaseBaseUrl: () => 'https://studio.tailf266ac.ts.net:3148/api/readest',
}));

const tauriFetchMock = vi.mocked(tauriFetch);
const webFetch = vi.fn<typeof fetch>();

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

beforeEach(() => {
  vi.stubGlobal('fetch', webFetch);
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  tauriFetchMock.mockReset();
  webFetch.mockReset();
});

describe('discoverClient transport', () => {
  test('a Tauri POST goes through the plugin with the mutation headers and tailnet Origin', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_PLATFORM', 'tauri');
    tauriFetchMock.mockResolvedValue(json(202, { jobs: [] }));

    const result = await discoverClient.request({
      title: 'Dune',
      author: 'Frank Herbert',
      want: 'pair',
    });

    expect(result).toEqual({ ok: true, status: 202, data: { jobs: [] } });
    expect(webFetch).not.toHaveBeenCalled();
    const [url, init] = tauriFetchMock.mock.calls[0]!;
    expect(url).toBe('https://studio.tailf266ac.ts.net:3148/api/books/discover/requests');
    expect(init?.method).toBe('POST');
    const headers = new Headers(init?.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('x-homebase-media-action')).toBe('1');
    expect(headers.get('origin')).toBe('https://studio.tailf266ac.ts.net');
    expect(JSON.parse(String(init?.body))).toEqual({
      title: 'Dune',
      author: 'Frank Herbert',
      want: 'pair',
    });
  });

  test('the web build uses the page fetch and sends no mutation headers on reads', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_PLATFORM', 'web');
    webFetch.mockResolvedValue(json(200, { jobs: [], serverTime: 1 }));

    const result = await discoverClient.jobs();

    expect(result.ok).toBe(true);
    expect(tauriFetchMock).not.toHaveBeenCalled();
    const [url, init] = webFetch.mock.calls[0]!;
    expect(url).toBe('https://studio.tailf266ac.ts.net:3148/api/books/discover/jobs?active=1');
    expect(new Headers(init?.headers).get('x-homebase-media-action')).toBeNull();
  });
});

describe('discoverClient failure classification', () => {
  test.each([
    [
      'a network error',
      () => webFetch.mockRejectedValue(new TypeError('Failed to fetch')),
      'offline',
      null,
    ],
    [
      '403 off the tailnet',
      () => webFetch.mockResolvedValue(json(403, { error: 'Discover is household-only' })),
      'forbidden',
      403,
    ],
    [
      '503',
      () =>
        webFetch.mockResolvedValue(json(503, { error: 'Discover is not available right now.' })),
      'unavailable',
      503,
    ],
    [
      '500',
      () => webFetch.mockResolvedValue(json(500, { error: 'Discover failed on the server.' })),
      'error',
      500,
    ],
    [
      'a body that is not JSON',
      () => webFetch.mockResolvedValue(new Response('<html>', { status: 200 })),
      'error',
      200,
    ],
  ])('%s is reported as %s with no server text or URL', async (_name, arrange, failure, status) => {
    vi.stubEnv('NEXT_PUBLIC_APP_PLATFORM', 'web');
    arrange();
    await expect(discoverClient.browse()).resolves.toEqual({ ok: false, failure, status });
  });

  test.each([
    ['Invalid title', 400, 'title'],
    ['Invalid want', 400, 'format'],
    ['Offer is unknown or expired; search again', 400, 'offer_expired'],
    ['requestId was already used for a different request', 409, 'id_conflict'],
    ['something the client has never seen', 400, 'unreadable'],
  ])('a refused request (%s) carries a reason code, not the server text', async (message, status, reason) => {
    vi.stubEnv('NEXT_PUBLIC_APP_PLATFORM', 'web');
    webFetch.mockResolvedValue(json(status, { error: message }));

    const result = await discoverClient.request({ title: 'Dune', author: 'F', want: 'ebook' });

    expect(result).toEqual({ ok: false, failure: 'error', status, reason });
    expect(JSON.stringify(result)).not.toContain(message);
  });

  test('a device that reports offline does not try the network', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_PLATFORM', 'web');
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);

    await expect(discoverClient.browse()).resolves.toEqual({
      ok: false,
      failure: 'offline',
      status: null,
    });
    expect(webFetch).not.toHaveBeenCalled();
  });

  test('a request that hangs is aborted after the timeout and reads as offline', async () => {
    vi.useFakeTimers();
    vi.stubEnv('NEXT_PUBLIC_APP_PLATFORM', 'web');
    let aborted = false;
    webFetch.mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    );

    const pending = discoverClient.browse();
    await vi.advanceTimersByTimeAsync(DISCOVER_TIMEOUT_MS - 1);
    expect(aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual({ ok: false, failure: 'offline', status: null });
    expect(aborted).toBe(true);
    expect(DISCOVER_TIMEOUT_MS).toBe(10_000);
  });
});
