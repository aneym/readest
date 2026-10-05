/** Integration: real reader stores, translation, page-note hook and event dispatcher.
 * Only network and the Next router boundary are substituted; reader collaborators are real.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRef } from 'react';
import { CaptureSheets } from '@/app/reader/components/capture/CaptureSheets';
import BookmarkToggler from '@/app/reader/components/BookmarkToggler';
import BooknoteView from '@/app/reader/components/sidebar/BooknoteView';
import { transformBookNoteToDB, transformBookNoteFromDB } from '@/utils/transform';
import { AuthProvider } from '@/context/AuthContext';
import { EnvProvider } from '@/context/EnvContext';
import { useReaderStore } from '@/store/readerStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { setBookProgress } from '@/store/readerProgressStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useImmersionStore } from '@/store/immersionStore';
import { DEFAULT_READSETTINGS } from '@/services/constants';
import { WebAppService } from '@/services/webAppService';
import { getDefaultViewSettings } from '@/services/settingsService';
import { eventDispatcher } from '@/utils/event';
import HeaderBar from '@/app/reader/components/HeaderBar';
import { NavigationBar } from '@/app/reader/components/footerbar/NavigationBar';
import type { BookDoc } from '@/libs/document';
import FooterBar from '@/app/reader/components/footerbar/FooterBar';
import ProgressBar from '@/app/reader/components/ProgressBar';
import { usePagination } from '@/app/reader/hooks/usePagination';
import type { FoliateView } from '@/types/view';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push() {}, replace() {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const bookKey = 'thumb-1';
const cfi = 'epubcfi(/6/2!/4/2/1:0)';
const insets = { top: 0, bottom: 0, left: 0, right: 0 };
const listeners: Array<[string, (event: CustomEvent) => void]> = [];
const received: Array<{ event: string; detail: unknown }> = [];
function observe(name: string) {
  const listener = (event: CustomEvent) => {
    received.push({ event: name, detail: event.detail });
  };
  eventDispatcher.on(name, listener);
  listeners.push([name, listener]);
}
function ReaderSurface() {
  const viewRef = useRef<FoliateView | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { handlePageFlip } = usePagination(bookKey, viewRef, containerRef);
  return (
    <div
      ref={containerRef}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        void handlePageFlip(
          new MessageEvent('message', {
            data: {
              type: 'iframe-single-click',
              bookKey,
              screenX: 180,
              clientX: 180,
              clientY: 300,
              sectionIndex: 0,
            },
          }),
        );
      }}
      data-testid='page'
    >
      <HeaderBar
        bookKey={bookKey}
        bookTitle='Titan'
        isTopLeft={false}
        isHoveredAnim={false}
        gridInsets={insets}
        screenInsets={insets}
        onCloseBook={() => {}}
        onGoToLibrary={() => {
          received.push({ event: 'library', detail: bookKey });
        }}
      />
      <FooterBar
        bookKey={bookKey}
        bookFormat='EPUB'
        pageinfo={{ current: 111, total: 774 }}
        isHoveredAnim={false}
        gridInsets={insets}
      />
      <ProgressBar bookKey={bookKey} horizontalGap={0} contentInsets={insets} gridInsets={insets} />
    </div>
  );
}
async function tapMiddle() {
  await act(async () => {
    fireEvent.click(screen.getByTestId('page'));
  });
}
beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_HOUSEHOLD_BUILD', '1');
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ pairs: [] }), { status: 200 }));
  Object.defineProperty(window, 'innerWidth', { value: 360, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 360,
    bottom: 800,
    width: 360,
    height: 800,
    toJSON() {},
  });
  const viewSettings = {
    ...getDefaultViewSettings({
      fs: new WebAppService().fs,
      isMobile: true,
      isEink: true,
      isAppDataSandbox: false,
    }),
    isEink: true,
    isColorEink: false,
    showProgressInfo: true,
    showCurrentTime: false,
    showCurrentBatteryStatus: false,
    showStickyProgressBar: false,
    showRemainingTime: false,
    showRemainingPages: false,
  };
  useSettingsStore.setState((state) => ({
    settings: { ...state.settings, globalReadSettings: DEFAULT_READSETTINGS },
  }));
  useReaderStore.setState({
    hoveredBookKey: null,
    bottomBarTab: '',
    bookKeys: [bookKey],
    viewStates: {
      [bookKey]: {
        key: bookKey,
        view: null,
        viewerKey: bookKey,
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
  useBookDataStore.setState({
    booksData: {
      thumb: {
        id: 'thumb',
        book: {
          hash: 'thumb',
          format: 'EPUB',
          title: 'Titan',
          author: 'Ron Chernow',
          createdAt: 1,
          updatedAt: 1,
        },
        file: null,
        bookDoc: null,
        isFixedLayout: false,
        config: { updatedAt: 1, viewSettings, booknotes: [] },
      },
    },
  });
  setBookProgress(bookKey, {
    location: cfi,
    sectionHref: '',
    sectionLabel: 'Chapter 7',
    section: { current: 0, total: 10 },
    pageinfo: { current: 111, total: 774 },
    timeinfo: { section: 14, total: 100 },
    fraction: 0.14,
    index: 0,
    range: document.createRange(),
    page: 111,
  });
  useImmersionStore.getState().setPairs({});
  received.length = 0;
});
afterEach(() => {
  cleanup();
  for (const [name, listener] of listeners.splice(0)) eventDispatcher.off(name, listener);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
const mount = () =>
  render(
    <EnvProvider>
      <AuthProvider>
        <ReaderSurface />
        <CaptureSheets />
      </AuthProvider>
    </EnvProvider>,
  );

describe('household reading thumb bar', () => {
  it('middle taps toggle one bottom bar, never a header, with eight word-labelled actions', async () => {
    const { container } = mount();
    await tapMiddle();
    expect(useReaderStore.getState().hoveredBookKey).toBe(bookKey);
    expect(container.querySelector('.header-bar')).toBeNull();
    expect(container.querySelector('.footer-bar')?.classList.contains('opacity-100')).toBe(true);
    for (const name of [
      'Page note',
      'Note',
      'Voice',
      'Listen',
      '‹ Library',
      'Contents',
      'Search',
      'Aa',
    ])
      expect(screen.getByRole('button', { name })).toBeTruthy();
    await tapMiddle();
    expect(container.querySelector('.footer-bar')?.classList.contains('opacity-0')).toBe(true);
  });
  it('dispatches captures and reuses library, contents, search and font actions', async () => {
    observe('reader-capture-open');
    observe('search-term');
    mount();
    await tapMiddle();
    for (const [name, kind] of [
      ['Page note', 'page-note'],
      ['Note', 'note'],
      ['Voice', 'voice'],
    ]) {
      fireEvent.click(screen.getByRole('button', { name }));
      expect(received).toContainEqual({ event: 'reader-capture-open', detail: { bookKey, kind } });
    }
    fireEvent.click(screen.getByRole('button', { name: '‹ Library' }));
    expect(received).toContainEqual({ event: 'library', detail: bookKey });
    fireEvent.click(screen.getByRole('button', { name: 'Contents' }));
    expect(useBookDataStore.getState().getConfig(bookKey)?.viewSettings?.sideBarTab).toBe('toc');
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(received).toContainEqual({ event: 'search-term', detail: { bookKey } });
    await tapMiddle();
    fireEvent.click(screen.getByRole('button', { name: 'Aa' }));
    expect(useReaderStore.getState().bottomBarTab).toBe('font');
  });
  it('routes pending Listen to the narration status event', async () => {
    useImmersionStore.getState().setPairs({ thumb: { state: 'queued' } });
    observe('narration-status-open');
    observe('tts-speak');
    mount();
    await tapMiddle();
    fireEvent.click(screen.getByRole('button', { name: 'Listen' }));
    expect(received).toContainEqual({ event: 'narration-status-open', detail: { bookKey } });
    expect(received.some((entry) => entry.event === 'tts-speak')).toBe(false);
  });
  it.each([false, true])('Listen uses the existing TTS action for narrated=%s', (narrated) => {
    if (narrated) {
      const bookDoc: BookDoc = {
        metadata: { title: 'Titan', author: 'Ron Chernow', language: 'en' },
        rendition: {},
        dir: 'ltr',
        sections: [
          {
            id: 'chapter',
            cfi,
            size: 100,
            linear: 'yes',
            mediaOverlay: { id: 'audio', href: 'chapter.smil' },
            createDocument: async () => document,
          },
        ],
        splitTOCHref: (href) => [href],
        getCover: async () => null,
        loadText: async () => '<smil />',
        loadBlob: async () => new Blob(),
      };
      useBookDataStore.setState((state) => ({
        booksData: { ...state.booksData, thumb: { ...state.booksData['thumb']!, bookDoc } },
      }));
    }
    const actions: string[] = [];
    observe('narration-status-open');
    render(
      <EnvProvider>
        <NavigationBar
          bookKey={bookKey}
          actionTab=''
          gridInsets={insets}
          forceMobileLayout={false}
          onSetActionTab={(tab) => actions.push(tab)}
        />
      </EnvProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Listen' }));
    expect(actions).toEqual(['tts']);
    expect(received.some((entry) => entry.event === 'narration-status-open')).toBe(false);
  });
  it('keeps the existing household desktop navigation and header', () => {
    Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true });
    const { container } = mount();
    expect(container.querySelector('.header-bar')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Page note' })).toBeNull();
  });
  it.each([
    1, 2,
  ])('shows %i page notes from the current CFI and opens the note without dismissing progress', async (count) => {
    useBookDataStore.getState().setConfig(bookKey, {
      booknotes: Array.from({ length: count }, (_, index) => ({
        id: `note-${index}`,
        type: 'bookmark',
        cfi,
        note: `Thought ${index}`,
        hbKind: 'page-note',
        createdAt: index + 1,
        updatedAt: 1,
      })),
    });
    const { container } = mount();
    const button = screen.getByRole('button', {
      name: count === 1 ? '1 page note' : '2 page notes',
    });
    fireEvent.click(button);
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Note text' }).value).toBe(
      `Thought ${count - 1}`,
    );
    expect(screen.getByRole('dialog').classList.contains('border-t')).toBe(true);
    expect(screen.getByRole('dialog').classList.contains('border-base-content/20')).toBe(true);
    if (count > 1) {
      expect(screen.getByText('1 of 2')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Next' }));
      expect(screen.getByText('2 of 2')).toBeTruthy();
      expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Note text' }).value).toBe(
        'Thought 0',
      );
    }
    expect(container.querySelector('.progress-strip')?.classList.contains('opacity-0')).toBe(false);
    act(() => setBookProgress(bookKey, null));
    expect(screen.queryByRole('button', { name: /page notes?/ })).toBeNull();
  });
  it('opens a capture sheet with the reader hairline', async () => {
    mount();
    await act(async () => {
      await eventDispatcher.dispatch('reader-capture-open', { bookKey, kind: 'page-note' });
    });
    expect(screen.getByRole('dialog').classList.contains('border-t')).toBe(true);
    expect(screen.getByRole('dialog').classList.contains('border-base-content/20')).toBe(true);
  });
  it('excludes page notes from the bookmark sidebar', () => {
    useBookDataStore.getState().setConfig(bookKey, {
      booknotes: [
        {
          id: 'page-note',
          type: 'bookmark',
          hbKind: 'page-note',
          cfi,
          note: 'Keep this page thought',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });
    render(
      <EnvProvider>
        <BooknoteView type='bookmark' bookKey={bookKey} toc={[]} />
      </EnvProvider>,
    );
    expect(screen.getByText('No Bookmarks')).toBeTruthy();
  });
  it('keeps synced page notes out of desktop bookmarks and preserves them when removing a real bookmark', () => {
    const pageNote = transformBookNoteFromDB(
      transformBookNoteToDB(
        {
          id: 'page-note',
          type: 'bookmark',
          hbKind: 'page-note',
          cfi,
          note: 'Keep this page thought',
          createdAt: 1,
          updatedAt: 1,
        },
        'household',
      ),
    );
    useBookDataStore.getState().setConfig(bookKey, { booknotes: [pageNote] });
    // Persistence is the filesystem boundary; reader stores, transforms and UI are real.
    useBookDataStore.setState({ saveConfig: async () => {} });
    render(
      <EnvProvider>
        <BookmarkToggler bookKey={bookKey} />
        <BooknoteView type='bookmark' bookKey={bookKey} toc={[]} />
      </EnvProvider>,
    );
    expect(screen.getByRole('button', { name: 'Add Bookmark' })).toBeTruthy();
    expect(screen.getByText('No Bookmarks')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add Bookmark' }));
    expect(useBookDataStore.getState().getConfig(bookKey)!.booknotes).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Bookmark' }));
    const notes = useBookDataStore.getState().getConfig(bookKey)!.booknotes!;
    expect(notes.find((note) => note.id === 'page-note')?.deletedAt).toBeFalsy();
    expect(notes.find((note) => note.id !== 'page-note')?.deletedAt).toBeTruthy();
    expect(screen.getByText('No Bookmarks')).toBeTruthy();
  });
  it('preserves upstream controls on non-household mobile', async () => {
    vi.stubEnv('NEXT_PUBLIC_HOUSEHOLD_BUILD', '0');
    const { container } = mount();
    await tapMiddle();
    expect(container.querySelector('.header-bar')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Page note' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Speak' }).length).toBeGreaterThan(0);
  });
});
