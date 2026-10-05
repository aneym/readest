import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Book, ViewSettings, BookProgress } from '@/types/book';
import type { FoliateView } from '@/types/view';

// Real footer, availability, playback hook, controller, session and bridge.
// Only the host/router, browser audio and remote HTTP/WebSocket are supplied.
// Guards both Listen entry points and post-init media metadata: a bridge-only
// test cannot detect the reader forgetting to re-adopt its selected engine.
vi.mock('@/context/EnvContext', () => ({ useEnv: () => ({ appService: null, envConfig: {} }) }));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/utils/simplecc', () => ({
  initSimpleCC: async () => {},
  runSimpleCC: (s: string) => s,
}));
vi.mock('isomorphic-ws', () => ({
  default: class {
    addEventListener(type: string, listener: () => void) {
      if (type === 'error') queueMicrotask(listener);
    }
    close() {}
  },
}));

import { DEFAULT_VIEW_CONFIG, DEFAULT_VIEW_SETTINGS_CONFIG } from '@/services/constants';
import FooterBar from '@/app/reader/components/footerbar/FooterBar';
import { useBookDataStore } from '@/store/bookDataStore';
import { useReaderStore } from '@/store/readerStore';
import { setBookProgress, clearBookProgress } from '@/store/readerProgressStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useImmersionStore } from '@/store/immersionStore';
import { ttsSessionManager } from '@/services/tts/TTSSessionManager';
import { eventDispatcher } from '@/utils/event';
import { TTSController } from '@/services/tts/TTSController';
import {
  handleClick,
  handleMousedown,
  handleMouseup,
} from '@/app/reader/utils/iframeEventHandlers';
import { MEDIA_OVERLAY_VOICE_ID } from '@/services/tts/mediaOverlay';
import { markSyntheticChosen } from '@/app/reader/hooks/useNarrationAvailability';

class BrowserAudio extends EventTarget {
  currentTime = 0;
  paused = true;
  playbackRate = 1;
  src = '';
  async play() {
    this.paused = false;
  }
  pause() {
    this.paused = true;
  }
  load() {}
}
class BrowserMetadata {
  title: string;
  artist: string;
  album: string;
  artwork: MediaImage[];
  constructor(data: MediaMetadataInit) {
    this.title = data.title ?? '';
    this.artist = data.artist ?? '';
    this.album = data.album ?? '';
    this.artwork = data.artwork ?? [];
  }
}
const key = 'listen-view';
const media = {
  metadata: null as BrowserMetadata | null,
  playbackState: 'none',
  setActionHandler: vi.fn(),
  setPositionState: vi.fn(),
};
let narrated: boolean;
let speakEvents: number;
const onSpeak = () => {
  speakEvents++;
};

function seed(hasNarration: boolean) {
  const doc = new DOMParser().parseFromString(
    '<html lang="en"><body><p id="one">Recorded sentence.</p><p id="two">Another sentence.</p></body></html>',
    'text/html',
  );
  const section = {
    id: 'ch.xhtml',
    createDocument: async () => doc,
    mediaOverlay: hasNarration ? { id: 'smil', href: 'ch.smil' } : null,
  };
  const view = {
    book: {
      sections: [section],
      primaryLanguage: 'en',
      loadText: async () =>
        '<smil><body><par><text src="ch.xhtml#one"/><audio src="ch.mp3" clipBegin="0s" clipEnd="10s"/></par><par><text src="ch.xhtml#two"/><audio src="ch.mp3" clipBegin="10s" clipEnd="15s"/></par></body></smil>',
      loadBlob: async () => new Blob(['audio']),
    },
    renderer: {
      primaryIndex: 0,
      getContents: () => [{ doc, index: 0 }],
      goTo: async () => {},
      scrollToAnchor: () => {},
    },
    language: { isCJK: false, canonical: 'en' },
    getCFI: () => 'epubcfi(/6/2!/4/2)',
    resolveCFI: () => ({
      index: 0,
      anchor: () => {
        const r = doc.createRange();
        r.selectNodeContents(doc.getElementById('one')!);
        return r;
      },
    }),
    resolveNavigation: () => ({ index: 0 }),
    history: { canGoBack: false, canGoForward: false },
  } as unknown as FoliateView;
  const book = {
    hash: 'listen',
    title: 'Book Title',
    author: 'Book Author',
    primaryLanguage: 'en',
    format: 'EPUB',
    createdAt: 1,
    updatedAt: 1,
    hasNarration,
  } as Book;
  useBookDataStore.setState({
    booksData: {
      listen: {
        id: 'listen',
        book,
        bookDoc: view.book,
        config: null,
        file: null,
        isFixedLayout: false,
      },
    },
  });
  const viewSettings = {
    ...DEFAULT_VIEW_CONFIG,
    ttsHighlightOptions: { style: 'highlight', color: '#ffff00' },
    defaultFont: 'serif',
    defaultCJKFont: 'serif',
    serifFont: 'serif',
    sansSerifFont: 'sans-serif',
    monospaceFont: 'monospace',
    isEink: false,
    ttsRate: 1,
    ttsMediaMetadata: 'sentence',
    ttsUseNarration: false,
    ttsReadAloudText: 'source',
    showPaginationButtons: true,
  } as ViewSettings;
  useReaderStore.setState({
    bookKeys: [key],
    hoveredBookKey: key,
    viewStates: {
      [key]: {
        key,
        view,
        viewerKey: '',
        isPrimary: true,
        loading: false,
        inited: true,
        error: null,
        ribbonVisible: false,
        ttsEnabled: false,
        autoScrollEnabled: false,
        syncing: false,
        gridInsets: null,
        previewMode: false,
        viewSettings,
      },
    },
  });
  setBookProgress(key, {
    index: 0,
    sectionLabel: 'Chapter One',
    range: null,
    location: { start: { cfi: '' }, end: { cfi: '' } },
  } as unknown as BookProgress);
}
const mount = () =>
  render(
    <FooterBar
      bookKey={key}
      bookFormat='EPUB'
      isHoveredAnim={false}
      gridInsets={{ top: 0, bottom: 0, left: 0, right: 0 }}
    />,
  );

beforeEach(() => {
  useSettingsStore.setState({
    settings: {
      ...useSettingsStore.getState().settings,
      globalViewSettings: { ...DEFAULT_VIEW_SETTINGS_CONFIG } as ViewSettings,
    },
  });
  narrated = false;
  speakEvents = 0;
  window.__READEST_RUNTIME_CONFIG = {
    homebaseApiBaseUrl: 'https://homebase.test/api/readest',
    homebaseSyncEnabled: true,
  };
  localStorage.clear();
  localStorage.setItem('token', 'test-only-pairing');
  vi.stubGlobal('Audio', BrowserAudio);
  vi.stubGlobal(
    'SpeechSynthesisUtterance',
    class {
      text = '';
    },
  );
  Object.defineProperty(window, 'speechSynthesis', {
    configurable: true,
    value: {
      getVoices: () => [{ name: 'Test voice', voiceURI: 'test', lang: 'en', default: true }],
      speak: () => {},
      cancel: () => {},
      pause: () => {},
      resume: () => {},
    },
  });
  vi.stubGlobal('MediaMetadata', BrowserMetadata);
  vi.stubGlobal(
    'Image',
    class {
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onerror?.());
      }
    },
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.includes('/immersion/status')
              ? {
                  ok: true,
                  books: narrated ? {} : { listen: { state: 'aligning', stage: 'syncing' } },
                }
              : { work: { owned: { audiobook: null } } },
          ),
        ),
    ),
  );
  Object.defineProperty(navigator, 'mediaSession', { configurable: true, value: media });
  URL.createObjectURL = vi.fn(() => 'blob:audio');
  URL.revokeObjectURL = vi.fn();
  media.metadata = null;
  useImmersionStore.getState().setPairs({ listen: { state: 'aligning', stage: 'syncing' } });
  eventDispatcher.on('tts-speak', onSpeak);
});
afterEach(async () => {
  await act(() => ttsSessionManager.stopActive());
  cleanup();
  clearBookProgress(key);
  useReaderStore.setState({ bookKeys: [], viewStates: {}, hoveredBookKey: '' });
  useBookDataStore.setState({ booksData: {} });
  eventDispatcher.off('tts-speak', onSpeak);
  delete window.__READEST_RUNTIME_CONFIG;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test.each([
  0, 1,
])('Listen entry %s opens pending status, not synthesis, until explicitly chosen', async (entry) => {
  seed(false);
  mount();
  fireEvent.click(screen.getAllByRole('button', { name: 'Speak' })[entry]!);
  await screen.findByText('Aligning the audiobook');
  expect(speakEvents).toBe(0);
  expect(ttsSessionManager.getActiveSession()).toBeNull();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Listen with a synthetic voice for now' }),
  );
  await waitFor(() => expect(speakEvents).toBe(1));
});

test('reader re-adopts narration after init so now-playing keeps the book and chapter, not sentence text', async () => {
  narrated = true;
  seed(true);
  mount();
  // Desktop book-level entry (mobile is labeled Listen for this fixture).
  fireEvent.click(screen.getByRole('button', { name: 'Speak' }));
  await waitFor(() =>
    expect(ttsSessionManager.getActiveSession()?.controller.state).toBe('playing'),
  );
  await waitFor(() => expect(media.metadata?.title).toBe('Book Title'));
  expect(media.metadata?.artist).toBe('Chapter One');
  expect(media.metadata?.album).toBe('Book Author');
});

test('synthetic choice starts speech with sentence metadata, not narration metadata', async () => {
  seed(false);
  mount();
  markSyntheticChosen(key);
  fireEvent.click(screen.getAllByRole('button', { name: 'Speak' })[1]!);
  await waitFor(() => expect(speakEvents).toBe(1));
  await waitFor(() => expect(media.metadata?.title).toBe('Recorded sentence.'));
  expect(media.metadata?.artist).toBe('Chapter One');
});

// These exercise the real reader listener, session controller and browser media
// boundary. Layout, speech/audio and media-session APIs are the browser fakes.
test('a section B tap cannot seek the still-loaded narrated section A', async () => {
  narrated = true;
  seed(true);
  const view = useReaderStore.getState().viewStates[key]!.view!;
  const docA = view.renderer.getContents()[0]!.doc!;
  const docB = new DOMParser().parseFromString('<p id="other">No narration here.</p>', 'text/html');
  view.book.sections.push({
    id: 'other.xhtml',
    cfi: '',
    size: 1,
    linear: 'yes',
    createDocument: async () => docB,
  });
  view.renderer.getContents = () => [
    { doc: docA, index: 0 },
    { doc: docB, index: 1 },
  ];
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value: () => [{ left: 0, right: 100, top: 0, bottom: 30 }],
  });
  docA.caretRangeFromPoint = () => {
    const range = docA.createRange();
    range.setStart(docA.getElementById('two')!.firstChild!, 1);
    range.collapse(true);
    return range;
  };
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Speak' }));
  await waitFor(() =>
    expect(ttsSessionManager.getActiveSession()?.controller.state).toBe('playing'),
  );
  const controller = ttsSessionManager.getActiveSession()!.controller;
  await act(() => controller.pause());
  view.tts?.setMark('0');
  const before = view.tts?.getLastRange();
  const post = vi.spyOn(window, 'postMessage');
  const tapped = docB.getElementById('other')!;
  tapped.addEventListener('click', (event) =>
    handleClick(key, { current: true }, false, event as MouseEvent),
  );
  handleMousedown(key, new MouseEvent('mousedown'));
  handleMouseup(key, new MouseEvent('mouseup'));
  tapped.dispatchEvent(new MouseEvent('click', { clientX: 20, clientY: 15 }));
  const payload = post.mock.calls.find(([message]) => message.type === 'iframe-single-click')![0];
  expect.soft(payload.sectionIndex).toBe(1);
  let consumed = false;
  await act(async () => {
    const request: {
      bookKey: string;
      sectionIndex: number;
      clientX: number;
      clientY: number;
      result?: Promise<boolean>;
    } = {
      bookKey: key,
      sectionIndex: 1,
      clientX: payload.clientX,
      clientY: payload.clientY,
    };
    const routed = eventDispatcher.dispatchSync('tts-narration-tap', request);
    consumed = await (request.result ?? routed);
  });
  expect(consumed).toBe(false);
  expect(view.tts?.getLastRange()?.toString()).toBe(before?.toString());
});

test('voice changes refresh live media metadata and headset track mapping in both directions', async () => {
  narrated = true;
  seed(true);
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Speak' }));
  await waitFor(() => expect(media.metadata?.title).toBe('Book Title'));
  const controller = ttsSessionManager.getActiveSession()!.controller;
  await act(() => controller.pause());
  if (!(controller instanceof TTSController)) throw new Error('Expected reader TTS controller');
  await act(() => controller.setVoice('test', 'en'));
  expect(controller.narrationActive).toBe(false);
  controller.dispatchEvent(
    new CustomEvent('tts-speak-mark', {
      detail: { text: 'Synthetic sentence.', name: '0' },
    }),
  );
  await waitFor(() => expect(media.metadata?.title).toBe('Synthetic sentence.'));
  // Spy through the real controller: arguments distinguish paragraph/sentence
  // transport while its actual text navigation still executes.
  const forward = vi.spyOn(controller, 'forward');
  const next = () =>
    media.setActionHandler.mock.calls.findLast(([action]) => action === 'nexttrack')![1]!;
  await act(async () => {
    next()({ action: 'nexttrack' });
  });
  expect(forward.mock.calls.at(-1)).toEqual([]);
  await act(() => controller.setVoice(MEDIA_OVERLAY_VOICE_ID, 'en'));
  expect(controller.narrationActive).toBe(true);
  await waitFor(() => expect(media.metadata?.title).toBe('Book Title'));
  expect(media.metadata?.artist).toBe('Chapter One');
  await act(async () => {
    next()({ action: 'nexttrack' });
  });
  expect(forward.mock.calls.at(-1)).toEqual([true]);
});
