import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ImmersionClient } from '@/services/homebase/immersion/client';
import type { RequestRecord, SearchResult } from '@/services/homebase/immersion/types';

const api = vi.hoisted(() => ({
  search: vi.fn(),
  createRequest: vi.fn(),
  listRequests: vi.fn(),
  status: vi.fn(),
  confirmPair: vi.fn(),
  realignPair: vi.fn(),
}));
vi.mock('@/services/homebase/immersion/client', () => ({
  createImmersionClient: () => api as unknown as ImmersionClient,
}));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (key: string) => key }));

import RequestBookSheet from '@/app/library/components/RequestBookSheet';
import { useImmersionStore } from '@/store/immersionStore';

const book: SearchResult = {
  key: 'one|a',
  title: 'One',
  author: 'A',
  ebook: { state: 'missing' },
  audiobook: { state: 'missing' },
  pair: { state: 'none' },
};
const request: RequestRecord = {
  id: 'r',
  profileId: 'p',
  deviceId: 'd',
  title: 'One',
  author: 'A',
  want: 'pair',
  ebook: { state: 'have' },
  audiobook: { state: 'have' },
  pair: { state: 'ready-to-swap', pairId: 'pair-1' },
  createdAt: 1,
  updatedAt: 1,
};
beforeEach(() => {
  vi.clearAllMocks();
  api.search.mockResolvedValue([book]);
  api.listRequests.mockResolvedValue([]);
  api.createRequest.mockResolvedValue(request);
  api.confirmPair.mockResolvedValue({ state: 'aligned', pairId: 'pair-1' });
  useImmersionStore.setState({ sheet: { open: false, tab: 'find', query: '' } });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const open = (tab: 'find' | 'requests' = 'find', query = 'One') => {
  act(() => useImmersionStore.getState().openSheet(tab, query));
  render(<RequestBookSheet />);
};

describe('Get a book sheet', () => {
  test('prefill appears and search waits 400 ms before returning results', async () => {
    open();
    expect((screen.getByRole('textbox', { name: 'Find a book' }) as HTMLInputElement).value).toBe(
      'One',
    );
    expect(screen.getByText('Searching…')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Get both' })).toBeTruthy());
  });
  test('empty, failed and short searches each explain their state', async () => {
    api.search.mockResolvedValueOnce([]);
    open();
    await waitFor(() =>
      expect(screen.getByText('No books found. Try another title or author.')).toBeTruthy(),
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'x' } });
    expect(screen.getByText('Enter at least 2 characters to search.')).toBeTruthy();
    api.search.mockRejectedValueOnce(new Error('offline'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Other' } });
    await waitFor(() => expect(screen.getByText('Couldn’t search. Try again.')).toBeTruthy());
  });
  test('Get both sends pair and acknowledges request, failure stays inline', async () => {
    open();
    const action = await screen.findByRole('button', { name: 'Get both' });
    fireEvent.click(action);
    await waitFor(() =>
      expect(api.createRequest).toHaveBeenCalledWith({
        title: 'One',
        author: 'A',
        isbn: undefined,
        want: 'pair',
      }),
    );
    expect(await screen.findByText('Requested')).toBeTruthy();
  });
  test('send failure restores the action and shows inline retry copy', async () => {
    api.createRequest.mockRejectedValueOnce(new Error('network'));
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Get both' }));
    expect(await screen.findByText("Couldn't send. Try again.")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Get both' })).toBeTruthy();
  });
  test('Requests tab displays count and confirms ready-to-swap narrated edition', async () => {
    api.listRequests.mockResolvedValue([request]);
    open('requests');
    expect(await screen.findByRole('button', { name: 'Use narrated edition' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Requests (1)' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Use narrated edition' }));
    await waitFor(() => expect(api.confirmPair).toHaveBeenCalledWith('pair-1'));
  });
});
