import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Optional platform WASM is not built in this worktree; no Chinese conversion is exercised.
vi.mock('@/utils/simplecc', () => ({
  initSimpleCC: async () => {},
  runSimpleCC: (text: string) => text,
}));
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Book } from '@/types/book';
import type { PairState } from '@/services/homebase/immersion/types';

// The component, availability hook, stores, Dialog and request queue are real.
// Only the host environment and Next router are supplied; HTTP is the fake boundary.
vi.mock('@/context/EnvContext', () => ({ useEnv: () => ({ appService: null }) }));
const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

import NarrationStatusSheet from '@/app/reader/components/tts/NarrationStatusSheet';
import { useBookDataStore } from '@/store/bookDataStore';
import { useImmersionStore } from '@/store/immersionStore';
import { eventDispatcher } from '@/utils/event';
import {
  hasChosenSynthetic,
  NARRATION_STATUS_OPEN_EVENT,
} from '@/app/reader/hooks/useNarrationAvailability';
import { loadQueue } from '@/services/discover/requestQueue';

const book: Book = {
  hash: 'book1',
  title: 'Test Book',
  author: 'Test Author',
  format: 'EPUB',
  updatedAt: 1,
  createdAt: 1,
} as Book;
let pairs: Record<string, PairState>;
let mode: 'sent' | 'failed';
let posted: Record<string, unknown>[];
let statusCalls: number;
let workCalls: number;

async function open() {
  render(<NarrationStatusSheet bookKey='book1-view' />);
  await act(() => eventDispatcher.dispatch(NARRATION_STATUS_OPEN_EVENT, { bookKey: 'book1-view' }));
}

beforeEach(() => {
  window.__READEST_RUNTIME_CONFIG = {
    homebaseApiBaseUrl: 'https://homebase.test/api/readest',
    homebaseSyncEnabled: true,
  };
  localStorage.clear();
  localStorage.setItem('token', 'test-only-pairing');
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  pairs = {};
  posted = [];
  statusCalls = 0;
  workCalls = 0;
  mode = 'sent';
  useBookDataStore.setState({
    booksData: {
      book1: { id: 'book1', book, bookDoc: null, config: null, file: null, isFixedLayout: false },
    },
  });
  useImmersionStore.getState().setPairs({});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/immersion/status')) {
        statusCalls++;
        return new Response(JSON.stringify({ ok: true, books: pairs }));
      }
      if (url.includes('/discover/work')) {
        workCalls++;
        return new Response(
          JSON.stringify({ work: { owned: { audiobook: { absItemId: 'audio1' } } } }),
        );
      }
      if (url.includes('/discover/requests')) {
        posted.push(JSON.parse(String(init?.body)));
        return mode === 'sent'
          ? new Response(JSON.stringify({ jobs: [] }))
          : new Response('{}', { status: 500 });
      }
      return new Response(
        JSON.stringify({
          ok: true,
          pair: { state: url.endsWith('/confirm') ? 'aligned' : 'queued', pairId: 'p1' },
        }),
      );
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete window.__READEST_RUNTIME_CONFIG;
  localStorage.clear();
});

describe('NarrationStatusSheet', () => {
  it.each([
    [
      'queued',
      'Waiting to align',
      'Your audiobook is queued on Homebase. Narration appears here when it’s ready.',
      null,
    ],
    ['aligning', 'Aligning the audiobook', 'Step 3 of 5: matching audio to text, 47%', null],
    [
      'candidate',
      'Check the match',
      'Homebase found an audiobook that may fit. Confirm it in Requests.',
      'Open Requests',
    ],
    [
      'ready-to-swap',
      'Narration is ready',
      'Switch this book to the narrated edition to listen.',
      'Use narrated edition',
    ],
    [
      'aligned',
      'Getting the narrated edition',
      'Reopen the book when the download finishes.',
      null,
    ],
    [
      'failed',
      'Alignment failed',
      'Homebase couldn’t match the audiobook to this text.',
      'Try again',
    ],
  ])('shows %s status, detail and action', async (state, status, detail, primary) => {
    pairs = { book1: { state, stage: 'syncing', progress: 0.479, pairId: 'p1' } as PairState };
    useImmersionStore.getState().setPairs(pairs);
    await open();
    expect(await screen.findByText(status!)).toBeTruthy();
    expect(screen.getByText(detail!)).toBeTruthy();
    if (primary) expect(screen.getByRole('button', { name: primary })).toBeTruthy();
    else
      expect(
        screen
          .getAllByRole('button')
          .some((button) =>
            ['Open Requests', 'Use narrated edition', 'Try again', 'Align audiobook'].includes(
              button.textContent ?? '',
            ),
          ),
      ).toBe(false);
    expect(screen.getByText('Test Book')).toBeTruthy();
    expect(screen.getByText('Test Author')).toBeTruthy();
  });
  it('displays server failure detail', async () => {
    pairs = { book1: { state: 'failed', error: 'The chapters do not match.' } };
    useImmersionStore.getState().setPairs(pairs);
    await open();
    expect(screen.getByText('The chapters do not match.')).toBeTruthy();
  });
  it('aligns the owned audiobook through the real request queue and shows queued', async () => {
    await open();
    fireEvent.click(await screen.findByRole('button', { name: 'Align audiobook' }));
    expect(await screen.findByText('Waiting to align')).toBeTruthy();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ title: 'Test Book', author: 'Test Author', want: 'pair' });
    expect(workCalls).toBe(1);
  });
  it('queues offline and explains that it will send later', async () => {
    await open();
    const align = await screen.findByRole('button', { name: 'Align audiobook' });
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    fireEvent.click(align);
    expect(
      await screen.findByText('Offline. Requests wait and send when you’re back.'),
    ).toBeTruthy();
    expect(screen.getByText('Waiting to align')).toBeTruthy();
    expect(loadQueue()[0]?.body.want).toBe('pair');
    expect(posted).toHaveLength(0);
  });
  it('retains the align action when the server refuses it', async () => {
    mode = 'failed';
    await open();
    fireEvent.click(await screen.findByRole('button', { name: 'Align audiobook' }));
    expect(await screen.findByText('That did not go through. Try again.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Align audiobook' }).hasAttribute('disabled')).toBe(
      false,
    );
  });
  it('opens Requests in the library', async () => {
    pairs = { book1: { state: 'candidate' } };
    useImmersionStore.getState().setPairs(pairs);
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Open Requests' }));
    expect(useImmersionStore.getState().sheet).toMatchObject({ open: true, tab: 'requests' });
    expect(push).toHaveBeenCalledWith('/library');
  });
  it.each([
    ['failed', 'Try again', 'Waiting to align'],
    ['ready-to-swap', 'Use narrated edition', 'Getting the narrated edition'],
  ])('submits the real pair action for %s', async (state, action, status) => {
    pairs = { book1: { state, pairId: 'p1' } as PairState };
    useImmersionStore.getState().setPairs(pairs);
    await open();
    fireEvent.click(screen.getByRole('button', { name: action! }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toContain(
      `https://homebase.test/api/readest/immersion/pairs/p1/${state === 'failed' ? 'realign' : 'confirm'}`,
    );
    expect(await screen.findByText(status!)).toBeTruthy();
    const urls = vi.mocked(fetch).mock.calls.map(([url]) => String(url));
    expect(
      urls.some((url) => url.endsWith(`/pairs/p1/${state === 'failed' ? 'realign' : 'confirm'}`)),
    ).toBe(true);
  });
  it('marks the synthetic choice, closes and sends the normal Speak event', async () => {
    pairs = { book1: { state: 'queued' } };
    useImmersionStore.getState().setPairs(pairs);
    const speak = vi.fn();
    eventDispatcher.on('tts-speak', speak);
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Listen with a synthetic voice for now' }));
    await waitFor(() => expect(speak).toHaveBeenCalledOnce());
    expect(hasChosenSynthetic('book1-view')).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
    eventDispatcher.off('tts-speak', speak);
  });
  it('polls every minute only while the sheet is open', async () => {
    pairs = { book1: { state: 'queued' } };
    useImmersionStore.getState().setPairs(pairs);
    vi.useFakeTimers();
    await open();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(statusCalls).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(statusCalls).toBe(2);
    fireEvent.click(screen.getByRole('button', { name: 'Listen with a synthetic voice for now' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(statusCalls).toBe(2);
  });
});

it.each([
  'ready-to-swap',
  'failed',
] as const)('hides an unavailable %s action without a pair ID', async (state) => {
  pairs = { book1: { state } };
  useImmersionStore.getState().setPairs(pairs);
  await open();
  expect(
    screen.queryByRole('button', {
      name: state === 'failed' ? 'Try again' : 'Use narrated edition',
    }),
  ).toBeNull();
  expect(
    screen.getByRole('button', { name: 'Listen with a synthetic voice for now' }),
  ).toBeTruthy();
});
