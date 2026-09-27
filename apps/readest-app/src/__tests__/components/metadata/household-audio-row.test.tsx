import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import HouseholdAudioRow from '@/components/metadata/HouseholdAudioRow';
import BookDetailView from '@/components/metadata/BookDetailView';
import { enqueueRequest, loadQueue } from '@/services/discover/requestQueue';
import type { DiscoverWork } from '@/services/discover/types';
import type { Book } from '@/types/book';

const mocks = vi.hoisted(() => ({
  work: vi.fn(),
  jobs: vi.fn(),
  request: vi.fn(),
  providers: vi.fn(),
  household: { value: true },
}));
vi.mock('@/services/discover/client', () => ({
  discoverClient: {
    work: mocks.work,
    jobs: mocks.jobs,
    request: mocks.request,
    providers: mocks.providers,
  },
  isDeviceOnline: () => navigator.onLine,
}));
vi.mock('@/services/household', () => ({ isHouseholdBuild: () => mocks.household.value }));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (s: string) => s }));
vi.mock('@/context/EnvContext', () => ({ useEnv: () => ({ envConfig: {} }) }));
vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: () => ({
    settings: {
      metadataOthersCollapsed: true,
      metadataSeriesCollapsed: true,
      metadataDescriptionCollapsed: true,
    },
  }),
}));
vi.mock('@/components/BookCover', () => ({ default: () => null }));
vi.mock('@/components/BookCoverViewer', () => ({
  default: () => null,
  useBookCoverViewer: () => ({
    coverSrc: null,
    openCoverViewer: vi.fn(),
    closeCoverViewer: vi.fn(),
  }),
}));

const book = { title: 'Piranesi', author: 'Susanna Clarke', hash: 'piranesi' } as Book;
const work = (extra: Partial<DiscoverWork> = {}): DiscoverWork => ({
  key: 'piranesi|clarke',
  title: book.title,
  authors: [book.author],
  series: null,
  year: null,
  coverUrl: null,
  description: null,
  identifiers: {},
  owned: { ebook: null, audiobook: null },
  offersChecked: true,
  ebooks: [],
  audiobooks: [],
  activeJobIds: [],
  ...extra,
});
const offer = {
  id: 'a1',
  provider: 'abb',
  kind: 'audiobook',
  protocol: 'torrent',
  releaseTitle: 'Piranesi',
  format: 'm4b',
  sizeBytes: null,
  language: 'en',
  seeders: null,
  quality: null,
  narrator: null,
  durationSeconds: null,
  score: 90,
} as const;
const response = (data: unknown) => ({ ok: true, status: 200, data });

beforeEach(() => {
  mocks.household.value = true;
  localStorage.clear();
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  mocks.work.mockReset().mockResolvedValue(response({ work: work() }));
  mocks.jobs.mockReset().mockResolvedValue(response({ jobs: [] }));
  mocks.request.mockReset().mockResolvedValue(response({ jobs: [] }));
  mocks.providers.mockReset().mockResolvedValue(response({ acquisition: { state: 'ready' } }));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const row = () => render(<HouseholdAudioRow book={book} />);

describe('household book audio', () => {
  it('shows ownership without a request action', async () => {
    mocks.work.mockResolvedValue(
      response({
        work: work({ owned: { ebook: null, audiobook: { absItemId: 'abs1', shelfKey: null } } }),
      }),
    );
    row();
    expect(await screen.findByText('Audiobook on your shelf')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Request/ })).toBeNull();
    expect(mocks.work).toHaveBeenCalledWith({ title: 'Piranesi', author: 'Susanna Clarke' });
  });

  it('offers audio and a pair when neither is owned, and submits an audio request', async () => {
    mocks.work.mockResolvedValue(response({ work: work({ audiobooks: [offer] }) }));
    row();
    fireEvent.click(await screen.findByRole('button', { name: 'Request audiobook' }));
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith(
        expect.objectContaining({ title: book.title, author: book.author, want: 'audiobook' }),
      ),
    );
    expect(screen.getByText('Requested · Queued')).toBeTruthy();
  });

  it('requests both as a pair only when the ebook is missing', async () => {
    mocks.work.mockResolvedValue(response({ work: work({ audiobooks: [offer] }) }));
    const view = row();
    fireEvent.click(await screen.findByRole('button', { name: 'Request both' }));
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith(expect.objectContaining({ want: 'pair' })),
    );
    view.unmount();
    mocks.work.mockResolvedValue(
      response({
        work: work({
          audiobooks: [offer],
          owned: { ebook: { calibreId: 7, formats: ['epub'], shelfKey: null }, audiobook: null },
        }),
      }),
    );
    row();
    expect(await screen.findByRole('button', { name: 'Request audiobook' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Request both' })).toBeNull();
  });

  it('keeps a quiet request action when no audiobook was found', async () => {
    row();
    expect(await screen.findByText('No audiobook found yet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Request anyway' }));
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith(expect.objectContaining({ want: 'audiobook' })),
    );
  });

  it('queues offline without calling the client and recognizes a pending request', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    row();
    expect(screen.getByText('Offline. Requests wait and send when you’re back.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Request anyway' }));
    await waitFor(() => expect(loadQueue()).toHaveLength(1));
    expect(loadQueue()[0]?.body.want).toBe('audiobook');
    expect(mocks.request).not.toHaveBeenCalled();
    expect(await screen.findByText('Requested · Waiting to send')).toBeTruthy();
  });

  it('sends an offline request when the book details reconnect without opening Discover', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    row();
    fireEvent.click(screen.getByRole('button', { name: 'Request anyway' }));
    await waitFor(() => expect(loadQueue()).toHaveLength(1));
    expect(mocks.request).not.toHaveBeenCalled();

    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    fireEvent(window, new Event('online'));
    await waitFor(() => expect(loadQueue()).toHaveLength(0));
    expect(mocks.request).toHaveBeenCalledWith(
      expect.objectContaining({ title: book.title, author: book.author, want: 'audiobook' }),
    );
  });

  it('sends an existing queued request when book details mount online', async () => {
    enqueueRequest({ title: book.title, author: book.author, want: 'audiobook' });
    row();
    await waitFor(() => expect(loadQueue()).toHaveLength(0));
    expect(mocks.request).toHaveBeenCalledWith(
      expect.objectContaining({ title: book.title, author: book.author, want: 'audiobook' }),
    );
  });

  it('recognizes an active audiobook job', async () => {
    mocks.jobs.mockResolvedValue(
      response({
        jobs: [{ id: 'j1', workKey: 'piranesi|clarke', kind: 'audiobook', stage: 'downloading' }],
      }),
    );
    row();
    expect(await screen.findByText('Requested · downloading')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Request/ })).toBeNull();
  });

  it('does not mount on non-household book details', () => {
    mocks.household.value = false;
    render(<BookDetailView book={book} metadata={null} fileSize={null} />);
    expect(screen.queryByRole('region', { name: 'Audio' })).toBeNull();
    expect(mocks.work).not.toHaveBeenCalled();
  });
});
