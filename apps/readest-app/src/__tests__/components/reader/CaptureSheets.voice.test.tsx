import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CaptureSheets } from '@/app/reader/components/capture/CaptureSheets';
import { eventDispatcher } from '@/utils/event';
import { useBookDataStore } from '@/store/bookDataStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useReaderStore } from '@/store/readerStore';
import { setBookProgress } from '@/store/readerProgressStore';
import type { Book, BookConfig, BookProgress } from '@/types/book';

vi.mock('@/services/household', () => ({ isHouseholdBuild: () => true }));
vi.mock('@/services/environment', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/environment')>()),
  isTauriAppPlatform: () => false,
}));
vi.mock('@/services/sync/homebase/config', () => ({
  getHomebaseBaseUrl: () => 'https://studio.tailf266ac.ts.net:3148/api/readest',
}));
vi.mock('@/context/EnvContext', () => ({ useEnv: () => ({ envConfig: {} }) }));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (text: string) => text }));

// Integration: real sheets, PCM recorder and thoughts client; fake only browser audio/network edges.
const stopTrack = vi.fn();
const microphone = vi.fn();
const network = vi.fn();
let audioCallback:
  | ((event: {
      inputBuffer: { length: number; numberOfChannels: number; getChannelData(): Float32Array };
    }) => void)
  | null;
class BrowserAudioContext {
  sampleRate = 48000;
  destination = {};
  createMediaStreamSource() {
    return { channelCount: 1, connect() {}, disconnect() {} };
  }
  createScriptProcessor() {
    return {
      set onaudioprocess(callback: typeof audioCallback) {
        audioCallback = callback;
      },
      connect() {},
      disconnect() {},
    };
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
}
beforeEach(() => {
  useSettingsStore.setState((state) => ({
    settings: {
      ...state.settings,
      globalViewSettings: { ...state.settings.globalViewSettings, isEink: true },
    },
  }));
  localStorage.clear();
  localStorage.setItem('token', 'test-device-token');
  audioCallback = null;
  stopTrack.mockReset();
  microphone.mockReset().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] });
  network
    .mockReset()
    .mockImplementation((url: string) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            url.includes('/api/thoughts')
              ? { thought: { captureId: 'voice-id', body: 'Remember this idea' } }
              : {},
          ),
        ),
      ),
    );
  useBookDataStore.setState({
    booksData: {
      voice: {
        id: 'voice',
        book: { hash: 'voice', title: 'Book', author: 'Author', calibreId: 42 } as Book,
        file: null,
        config: { booknotes: [] } as unknown as BookConfig,
        bookDoc: null,
        isFixedLayout: false,
      },
    },
    saveConfig: async () => {},
  });
  setBookProgress('voice-book', { location: 'epubcfi(/6/2!/4/2/1:0)', page: 12 } as BookProgress);
  vi.stubGlobal('AudioContext', BrowserAudioContext);
  vi.stubGlobal('fetch', (url: string, request?: RequestInit) =>
    url.includes('/api/thoughts') ? network(url, request) : Promise.resolve(new Response('{}')),
  );
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: microphone },
  });
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function open(kind: string) {
  render(<CaptureSheets />);
  await act(async () => {
    await eventDispatcher.dispatch('reader-capture-open', { bookKey: 'voice-book', kind });
  });
}
async function hold() {
  fireEvent.keyDown(screen.getByRole('button', { name: 'Hold to talk' }), { key: ' ' });
  await screen.findByText('Recording…');
  audioCallback?.({
    inputBuffer: {
      length: 4800,
      numberOfChannels: 1,
      getChannelData: () => new Float32Array(4800).fill(0.25),
    },
  });
}
test('hold records static status; release posts WAV with device auth and closes Voice', async () => {
  useReaderStore.setState({ hoveredBookKey: 'voice-book' });
  await open('voice');
  expect(screen.getByText('Sends when you let go.')).toBeTruthy();
  await hold();
  expect(network).not.toHaveBeenCalled();
  // While held, the button says what letting go does.
  expect(screen.queryByRole('button', { name: 'Hold to talk' })).toBeNull();
  fireEvent.keyUp(screen.getByRole('button', { name: 'Release to send' }), { key: ' ' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  // Back to the page: thumb bar closed, a footer line says where it went.
  expect(screen.getByRole('status').textContent).toBe('Saved to Thoughts');
  expect(useReaderStore.getState().hoveredBookKey).toBe('');
  expect(stopTrack).toHaveBeenCalledOnce();
  const [url, request] = network.mock.calls[0]!;
  expect(url).toBe('https://studio.tailf266ac.ts.net:3148/api/thoughts/voice');
  expect(request.method).toBe('POST');
  expect(request.headers).toMatchObject({
    'Content-Type': 'audio/wav',
    Authorization: 'Bearer test-device-token',
    'X-Intent-Id': expect.any(String),
    'X-Thought-Source': 'readest',
    'X-Recorded-At': expect.any(String),
  });
  expect(request.headers['X-Thought-Attachment']).toBeUndefined();
  expect(request.body.type).toBe('audio/wav');
  expect(request.body.size).toBe(3244);
});
test.each([
  'note',
  'page-note',
])('release in new %s sends only the voice Thought and closes', async (kind) => {
  await open(kind);
  // The voice hint belongs to the Voice sheet; here Save is the main action.
  expect(screen.queryByText('Sends when you let go.')).toBeNull();
  await hold();
  fireEvent.keyUp(screen.getByRole('button', { name: 'Release to send' }), { key: ' ' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(screen.getByRole('status').textContent).toBe(
    kind === 'page-note' ? 'Page note saved' : 'Saved to Thoughts',
  );
  const posts = network.mock.calls.filter(([, request]) => request?.method === 'POST');
  expect(posts).toHaveLength(1);
  expect(posts[0]![0]).toBe('https://studio.tailf266ac.ts.net:3148/api/thoughts/voice');
  const encoded = posts[0]![1].headers['X-Thought-Attachment'];
  if (kind === 'page-note') {
    expect(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))).toEqual({
      kind: 'book',
      key: 'calibre:42',
      title: 'Book',
      location: 'epubcfi(/6/2!/4/2/1:0)',
      page: 12,
    });
  } else expect(encoded).toBeUndefined();
  expect(useBookDataStore.getState().getConfig('voice-book')!.booknotes).toEqual(
    kind === 'page-note'
      ? [expect.objectContaining({ type: 'bookmark', note: 'Remember this idea', page: 12 })]
      : [],
  );
});
test('permission denied displays settings guidance and does not post', async () => {
  microphone.mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
  await open('voice');
  fireEvent.keyDown(screen.getByRole('button', { name: 'Hold to talk' }), { key: ' ' });
  await screen.findByText('Microphone access is off. Allow it in Settings to record.');
  expect(screen.queryByText('Recording…')).toBeNull();
  expect(network).not.toHaveBeenCalled();
});
test('offline keeps take for explicit retry and never claims it was queued', async () => {
  await open('voice');
  await hold();
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  fireEvent.keyUp(screen.getByRole('button', { name: 'Release to send' }), { key: ' ' });
  await screen.findByText("Couldn't send. Try again when you're back online.");
  expect(network).not.toHaveBeenCalled();
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(network).toHaveBeenCalledOnce();
});

test('pointer hold/release sends; cancelled gesture discards audio', async () => {
  await open('voice');
  const button = screen.getByRole('button', { name: 'Hold to talk' });
  fireEvent(button, new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
  await screen.findByText('Recording…');
  audioCallback?.({
    inputBuffer: {
      length: 4800,
      numberOfChannels: 1,
      getChannelData: () => new Float32Array(4800),
    },
  });
  fireEvent(button, new MouseEvent('pointercancel', { bubbles: true }));
  await waitFor(() => expect(screen.queryByText('Recording…')).toBeNull());
  expect(network).not.toHaveBeenCalled();
  expect(stopTrack).toHaveBeenCalledOnce();
  fireEvent(button, new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
  await screen.findByText('Recording…');
  await waitFor(() => expect(microphone).toHaveBeenCalledTimes(2));
  await act(async () => {});
  audioCallback?.({
    inputBuffer: {
      length: 4800,
      numberOfChannels: 1,
      getChannelData: () => new Float32Array(4800),
    },
  });
  fireEvent(button, new MouseEvent('pointerup', { bubbles: true, button: 0 }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(network).toHaveBeenCalledOnce();
});

// Real sheet -> client -> HTTP: protects the page-context contract without mocking our client.
test.each([
  {
    kind: 'note',
    shelfKey: null,
    calibreId: 42,
    location: 'epubcfi(/6/2!/4/2/1:0)',
    page: 12,
    attachment: undefined,
  },
  {
    kind: 'page-note',
    shelfKey: 'shelf:book',
    calibreId: 42,
    location: 'epubcfi(/6/2!/4/2/1:0)',
    page: 12,
    attachment: {
      kind: 'book',
      key: 'shelf:book',
      title: 'Book',
      location: 'epubcfi(/6/2!/4/2/1:0)',
      page: 12,
    },
  },
  {
    kind: 'page-note',
    shelfKey: null,
    calibreId: 42,
    location: 'x'.repeat(501),
    page: 0,
    attachment: { kind: 'book', key: 'calibre:42', title: 'Book' },
  },
  {
    kind: 'page-note',
    shelfKey: null,
    calibreId: undefined,
    location: 'epubcfi(/6/2!/4/2/1:0)',
    page: 12,
    attachment: undefined,
  },
])('text $kind sends structured context ($shelfKey, $calibreId)', async ({
  kind,
  shelfKey,
  calibreId,
  location,
  page,
  attachment,
}) => {
  const data = useBookDataStore.getState().booksData['voice']!;
  if (!data.book) throw new Error('Missing fixture book');
  data.book.calibreId = calibreId;
  setBookProgress('voice-book', { location, page } as BookProgress);
  const discovery = vi.fn(
    async () =>
      new Response(JSON.stringify({ work: { owned: { ebook: { shelfKey, calibreId: 42 } } } })),
  );
  vi.stubGlobal('fetch', (url: string, request?: RequestInit) =>
    url.includes('/api/thoughts') ? network(url, request) : discovery(),
  );
  await open(kind);
  if (kind === 'page-note') {
    await waitFor(() => expect(discovery).toHaveBeenCalledOnce());
    await act(async () => {});
  }
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'My exact note\n' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  const [url, request] = network.mock.calls[0]!;
  expect(url).toBe('https://studio.tailf266ac.ts.net:3148/api/thoughts');
  expect(JSON.parse(request.body)).toEqual({
    body: 'My exact note\n',
    captureId: expect.any(String),
    capturedAt: expect.any(Number),
    source: 'readest',
    ...(attachment ? { attachment } : {}),
  });
});
