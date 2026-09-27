import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import DiscoverPage from '@/app/discover/page';
import ShelfFilterBar from '@/app/library/components/ShelfFilterBar';
import { saveBrowse } from '@/services/discover/cache';
import { enqueueRequest, loadQueue } from '@/services/discover/requestQueue';
import type { DiscoverBrowseResponse, DiscoverWork } from '@/services/discover/types';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (key: string, options?: Record<string, string | number>) =>
    key.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options?.[name] ?? '')),
}));
vi.mock('@/hooks/useTheme', () => ({ useTheme: () => {} }));
vi.mock('@/store/themeStore', () => ({ useThemeStore: () => ({ safeAreaInsets: null }) }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));
vi.mock('@/services/sync/homebase/config', () => ({
  getHomebaseBaseUrl: () => 'https://studio.tailf266ac.ts.net:3148/api/readest',
}));

const work = (key: string, title: string, author: string, extra: Partial<DiscoverWork> = {}) =>
  ({
    key,
    title,
    authors: [author],
    series: null,
    year: null,
    coverUrl: null,
    description: null,
    identifiers: {},
    owned: { ebook: null, audiobook: null },
    offersChecked: false,
    ebooks: [],
    audiobooks: [],
    activeJobIds: [],
    ...extra,
  }) satisfies DiscoverWork;

const browse: DiscoverBrowseResponse = {
  generatedAt: 1,
  shelves: [
    {
      key: 'trending',
      id: 'trending',
      title: 'Trending this week',
      reason: null,
      works: [
        work('dune|herbert', 'Dune', 'Frank Herbert', {
          owned: { ebook: { calibreId: 7, formats: ['epub'], shelfKey: null }, audiobook: null },
        }),
        work('piranesi|clarke', 'Piranesi', 'Susanna Clarke'),
      ],
    },
  ],
};

let online = true;
/** The device has network, but every call to Homebase fails at the transport. */
let homebaseDown = false;
/** When set, POST /requests is refused with this 400 message. */
let refuseWith: string | null = null;
const requests: { url: string; method: string; body: unknown }[] = [];
const server = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? 'GET';
  requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
  if (homebaseDown) throw new TypeError('Failed to fetch');
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const acquisition = { state: 'ok', detail: null, checkedAt: 1 };
  if (url.includes('/browse')) return reply(200, browse);
  if (url.includes('/providers')) return reply(200, { providers: [], acquisition });
  if (url.includes('/jobs')) return reply(200, { jobs: [], serverTime: 1 });
  if (url.includes('/work')) {
    const offer = {
      provider: 'libgen',
      protocol: 'http',
      releaseTitle: 'Piranesi',
      language: 'en',
      seeders: null,
      quality: null,
      narrator: null,
      score: 90,
    } as const;
    const piranesi = work('piranesi|clarke', 'Piranesi', 'Susanna Clarke', {
      offersChecked: true,
      ebooks: [
        {
          ...offer,
          id: 'e1',
          kind: 'ebook',
          format: 'epub',
          sizeBytes: 2_200_000,
          durationSeconds: null,
        },
      ],
      audiobooks: [
        {
          ...offer,
          id: 'a1',
          provider: 'abb',
          protocol: 'torrent',
          kind: 'audiobook',
          format: 'm4b',
          sizeBytes: null,
          durationSeconds: 30_600,
        },
      ],
    });
    return reply(200, { work: piranesi, providers: [], acquisition });
  }
  if (url.includes('/requests')) {
    return refuseWith ? reply(400, { error: refuseWith }) : reply(202, { jobs: [] });
  }
  return reply(404, { error: 'not found' });
});

beforeEach(() => {
  localStorage.clear();
  online = true;
  homebaseDown = false;
  refuseWith = null;
  requests.length = 0;
  push.mockReset();
  vi.stubEnv('NEXT_PUBLIC_APP_PLATFORM', 'web');
  vi.stubGlobal('fetch', server);
  vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  server.mockClear();
});

describe('Discover page', () => {
  test('online, it shows the browse shelves with an On shelf mark on owned works', async () => {
    render(<DiscoverPage />);

    expect(await screen.findByRole('heading', { name: 'Trending this week' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Dune, Frank Herbert, On shelf' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Piranesi, Susanna Clarke' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Discover' })).toBeTruthy();
    expect(screen.queryByTestId('discover-offline')).toBeNull();
  });

  test('a paired request from the work sheet reaches Homebase', async () => {
    render(<DiscoverPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Piranesi, Susanna Clarke' }));
    const sheet = await screen.findByRole('dialog');
    expect(await within(sheet).findByText('EPUB · 2.1 MB · LibGen')).toBeTruthy();
    expect(within(sheet).getByText('M4B · 8 h 30 min · AudioBook Bay')).toBeTruthy();

    fireEvent.click(within(sheet).getByRole('button', { name: 'Get both (paired)' }));

    await waitFor(() =>
      expect(requests.find((r) => r.method === 'POST')?.body).toMatchObject({
        title: 'Piranesi',
        author: 'Susanna Clarke',
        want: 'pair',
      }),
    );
    expect(await within(sheet).findByText('Requested. Follow it under Getting.')).toBeTruthy();
  });

  test('offline, it shows the calm panel, the saved shelves and what is waiting to send', async () => {
    online = false;
    saveBrowse(browse, Date.now() - 2 * 60 * 60 * 1000);
    enqueueRequest({ title: 'The Dispossessed', author: 'Ursula K. Le Guin', want: 'pair' });

    render(<DiscoverPage />);

    const panel = await screen.findByTestId('discover-offline');
    expect(within(panel).getByText('You are offline.')).toBeTruthy();
    expect(
      within(panel).getByText('Discover needs Homebase; your downloaded books are all still here.'),
    ).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: 'Back to library' }));
    expect(push).toHaveBeenCalledWith('/library');
    expect(screen.getByRole('heading', { name: 'Trending this week' })).toBeTruthy();
    expect(screen.getByText('Saved 2 hours ago')).toBeTruthy();
    const waiting = screen.getByRole('region', { name: 'Waiting to send' });
    expect(within(waiting).getByText('The Dispossessed')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(server).not.toHaveBeenCalled();
  });

  test('with the network up but Homebase unreachable, it recovers and sends the queue without an online event', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    homebaseDown = true;
    enqueueRequest({ title: 'The Dispossessed', author: 'Ursula K. Le Guin', want: 'pair' });

    render(<DiscoverPage />);
    expect(await screen.findByTestId('discover-offline')).toBeTruthy();

    homebaseDown = false;
    await vi.advanceTimersByTimeAsync(15_000);

    expect(await screen.findByRole('heading', { name: 'Trending this week' })).toBeTruthy();
    expect(screen.queryByTestId('discover-offline')).toBeNull();
    await waitFor(() => expect(loadQueue()).toEqual([]));
    expect(requests.find((r) => r.method === 'POST')?.body).toMatchObject({
      title: 'The Dispossessed',
      want: 'pair',
    });
  });

  test('a queued request Homebase refuses is listed as not sent, with its reason', async () => {
    refuseWith = 'Invalid author';
    enqueueRequest({ title: 'The Dispossessed', author: 'Ursula K. Le Guin', want: 'pair' });

    render(<DiscoverPage />);

    const notSent = await screen.findByRole('region', { name: 'Not sent' });
    expect(within(notSent).getByText('The Dispossessed')).toBeTruthy();
    expect(
      within(notSent).getByText(/Homebase could not read the author name\./, { exact: false }),
    ).toBeTruthy();
    expect(notSent.textContent).not.toContain('Invalid author');
    expect(loadQueue()).toEqual([]);
  });

  test('offline, Get from a saved shelf queues the request', async () => {
    online = false;
    saveBrowse(browse);

    render(<DiscoverPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Piranesi, Susanna Clarke' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Get ebook' }));

    expect(await screen.findByText('Saved. It sends when Homebase is back.')).toBeTruthy();
    expect(loadQueue().map((entry) => entry.body)).toEqual([
      expect.objectContaining({ title: 'Piranesi', want: 'ebook' }),
    ]);
    expect(server).not.toHaveBeenCalled();
  });
});

describe('ShelfFilterBar Discover entry', () => {
  const counts = { reading: 1, fiction: 2, nonfiction: 3, volumes: 0, all: 6, finished: 0 };

  test('household builds get a Discover button that is not a filter option', () => {
    vi.stubEnv('NEXT_PUBLIC_HOUSEHOLD_BUILD', '1');
    render(<ShelfFilterBar value='reading' counts={counts} onChange={vi.fn()} />);

    const discover = screen.getByRole('button', { name: 'Discover' });
    expect(screen.getAllByRole('radio')).toHaveLength(6);
    expect(within(screen.getByRole('radiogroup')).queryByText('Discover')).toBeNull();
    fireEvent.click(discover);
    expect(push).toHaveBeenCalledWith('/discover');
  });

  test('other builds do not show it', () => {
    vi.stubEnv('NEXT_PUBLIC_HOUSEHOLD_BUILD', '');
    render(<ShelfFilterBar value='reading' counts={counts} onChange={vi.fn()} />);

    expect(screen.queryByRole('button', { name: 'Discover' })).toBeNull();
    expect(screen.getAllByRole('radio')).toHaveLength(6);
  });
});
