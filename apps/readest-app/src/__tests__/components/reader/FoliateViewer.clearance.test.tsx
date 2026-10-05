/** Reader integration with real stores, TTS controls and lifecycle. The external
 * foliate custom element supplies the renderer boundary; network init is held
 * pending to reproduce text being covered before narration is ready. */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import FoliateViewer from '@/app/reader/components/FoliateViewer';
import TTSControl from '@/app/reader/components/tts/TTSControl';
import { AuthProvider } from '@/context/AuthContext';
import { EnvProvider } from '@/context/EnvContext';
import { useReaderStore } from '@/store/readerStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { useSettingsStore } from '@/store/settingsStore';
import { setBookProgress } from '@/store/readerProgressStore';
import { getDefaultViewSettings } from '@/services/settingsService';
import { DEFAULT_SYSTEM_SETTINGS } from '@/services/constants';
import { WebAppService } from '@/services/webAppService';
import { eventDispatcher } from '@/utils/event';
import type { BookDoc } from '@/libs/document';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/reader/clearance',
}));
vi.mock('isomorphic-ws', () => ({
  default: class {
    addEventListener() {}
    close() {}
  },
}));
vi.mock('foliate-js/view.js', () => ({}));
class TestFoliateView extends HTMLElement {
  renderer = Object.assign(document.createElement('div'), {
    getContents: () => [],
    setStyles: () => {},
  });
  book!: BookDoc;
  language = { canonical: 'en' };
  history = { canGoBack: false, canGoForward: false };
  async open(book: BookDoc) {
    this.book = book;
  }
  addAnnotation() {
    return { index: 0, label: '' };
  }
  goTo() {}
  goToFraction() {}
  close() {}
}
customElements.define('foliate-view', TestFoliateView);
const key = 'clearance-1';
const insets = { top: 0, right: 0, bottom: 0, left: 0 };
let bookDoc: BookDoc;
beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_HOUSEHOLD_BUILD', '1');
  vi.stubGlobal('innerWidth', 412);
  vi.stubGlobal('innerHeight', 824);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('fetch', () => new Promise<Response>(() => {}));
  const viewSettings = {
    ...getDefaultViewSettings({
      fs: new WebAppService().fs,
      isMobile: true,
      isEink: true,
      isAppDataSandbox: false,
    }),
    showHeader: false,
    showFooter: false,
    marginTopPx: 0,
    marginBottomPx: 0,
    compactMarginBottomPx: 0,
  };
  bookDoc = {
    metadata: { title: 'Clearance', language: 'en' },
    sections: [{ id: 'chapter.xhtml' }],
  } as unknown as BookDoc;
  useReaderStore.setState({
    bookKeys: [key],
    hoveredBookKey: '',
    viewStates: {
      [key]: {
        key,
        view: null,
        viewerKey: key,
        isPrimary: true,
        loading: false,
        inited: false,
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
  useSettingsStore.setState((state) => ({
    settings: { ...DEFAULT_SYSTEM_SETTINGS, ...state.settings, customFonts: [] },
  }));
  useBookDataStore.setState({
    booksData: {
      clearance: {
        id: 'clearance',
        book: {
          hash: 'clearance',
          title: 'Clearance',
          author: 'Author',
          format: 'EPUB',
          createdAt: 1,
          updatedAt: 1,
        },
        file: null,
        bookDoc,
        isFixedLayout: false,
        config: { updatedAt: 1, booknotes: [], viewSettings },
      },
    },
  });
  setBookProgress(key, { index: 0, location: '', range: null } as never);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
async function mount(fixed = false) {
  if (fixed) {
    bookDoc.rendition = { layout: 'pre-paginated' } as BookDoc['rendition'];
    useBookDataStore.getState().booksData['clearance']!.isFixedLayout = true;
  }
  render(
    <EnvProvider>
      <AuthProvider>
        <FoliateViewer
          bookKey={key}
          bookDoc={bookDoc}
          config={useBookDataStore.getState().getConfig(key)!}
          gridInsets={insets}
          contentInsets={insets}
        />
        <TTSControl bookKey={key} gridInsets={insets} />
      </AuthProvider>
    </EnvProvider>,
  );
  await waitFor(() => expect(useReaderStore.getState().getViewState(key)?.inited).toBe(true));
  await act(async () => {
    void eventDispatcher.dispatch('tts-speak', { bookKey: key });
  });
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Stop reading aloud' })).toBeTruthy(),
  );
}
test('mounted strip clears reflowable text while TTS init is pending', async () => {
  await mount();
  expect(useReaderStore.getState().getViewState(key)?.ttsEnabled).toBe(false);
  expect(useReaderStore.getState().getView(key)!.renderer.getAttribute('margin-bottom')).toBe(
    '58px',
  );
});
test('fixed-layout container reserves the mounted strip height', async () => {
  await mount(true);
  expect(screen.getByRole('main', { name: 'Book Content' }).style.paddingBottom).toBe('58px');
});
