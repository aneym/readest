import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MdKeyboardArrowLeft, MdKeyboardArrowRight } from 'react-icons/md';

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (key: string, opts?: Record<string, unknown>) =>
    opts ? Object.entries(opts).reduce((s, [k, v]) => s.replace(`{{${k}}}`, String(v)), key) : key,
}));

vi.mock('@/services/household', () => ({ isHouseholdBuild: () => true }));

vi.mock('@/hooks/useResponsiveSize', () => ({
  useResponsiveSize: (size: number) => size,
}));

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({
    appService: { isMobile: false, hasSafeAreaInset: false },
  }),
}));

let viewSettingsOverride: Record<string, unknown> = {};
const readerState = {
  hoveredBookKey: '',
  bottomBarTab: '',
  setHoveredBookKey: vi.fn(),
  getViewSettings: () => ({
    ...DEFAULT_VIEW_CONFIG,
    ...DEFAULT_BOOK_LAYOUT,
    ...DEFAULT_TTS_CONFIG,
    ...viewSettingsOverride,
  }),
};
vi.mock('@/store/readerStore', () => ({
  useReaderStore: () => readerState,
}));

const progressState: { sectionLabel: string | undefined } = { sectionLabel: 'Chapter 5' };
vi.mock('@/store/readerProgressStore', () => ({
  useBookProgress: () => progressState,
}));

const getBookData = vi.fn();
vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: () => ({ getBookData }),
}));

import TTSMiniPlayer from '@/app/reader/components/tts/TTSMiniPlayer';
import { DEFAULT_BOOK_LAYOUT, DEFAULT_TTS_CONFIG, DEFAULT_VIEW_CONFIG } from '@/services/constants';

const gridInsets = { top: 0, right: 0, bottom: 0, left: 0 };

const makeProps = (overrides: Record<string, unknown> = {}) => ({
  bookKey: 'b1',
  isPlaying: true,
  isEink: false,
  visible: true,
  hasTimeline: true,
  timeoutTimestamp: 0,
  chapterRemainingSec: null as number | null,
  gridInsets,
  onTogglePlay: vi.fn(),
  onBackward: vi.fn(),
  onForward: vi.fn(),
  onStop: vi.fn(),
  onExpand: vi.fn(),
  onGetPlaybackInfo: vi
    .fn()
    .mockReturnValue({ position: 10, duration: 100, measuredFraction: 0.4 }),
  ...overrides,
});

describe('TTSMiniPlayer', () => {
  beforeEach(() => {
    viewSettingsOverride = {};
    readerState.hoveredBookKey = '';
    readerState.bottomBarTab = '';
    progressState.sectionLabel = 'Chapter 5';
    getBookData.mockReturnValue({ book: { title: 'Alice in Wonderland', coverImageUrl: null } });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  // #5310: the minimal card is down to one time. Elapsed is the half nobody
  // listens by, and carrying both got the pair chopped off at any UI font size
  // above 13px.
  test('minimal style shows only the remaining time, dropping elapsed, chapter, title and cover', () => {
    viewSettingsOverride = { ttsPlayerStyle: 'minimal' };
    getBookData.mockReturnValue({
      book: { title: 'Alice in Wonderland', coverImageUrl: 'blob:cover' },
    });
    const { container } = render(<TTSMiniPlayer {...makeProps()} />);
    expect(screen.queryByText('Chapter 5')).toBeNull();
    expect(screen.queryByText('Alice in Wonderland')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(screen.queryByText(/0:10/)).toBeNull();
    expect(screen.getByText('-1:30')).toBeTruthy();
  });

  test('minimal style drops the seconds from the remaining time above an hour', () => {
    viewSettingsOverride = { ttsPlayerStyle: 'minimal' };
    // 2h01m30s left: the compact form keeps the row five columns wide.
    const info = { position: 100, duration: 7390, measuredFraction: 0.1 };
    render(<TTSMiniPlayer {...makeProps({ onGetPlaybackInfo: vi.fn().mockReturnValue(info) })} />);
    expect(screen.getByText('-2:01')).toBeTruthy();
  });

  test('full style keeps the elapsed and the long-form remaining time', () => {
    const info = { position: 100, duration: 7390, measuredFraction: 0.1 };
    render(<TTSMiniPlayer {...makeProps({ onGetPlaybackInfo: vi.fn().mockReturnValue(info) })} />);
    expect(screen.getByText('Chapter 5 · 0:01:40 · -2:01:30')).toBeTruthy();
  });

  test('minimal style stacks the sleep timer on a second line below the time', () => {
    vi.useFakeTimers();
    viewSettingsOverride = { ttsPlayerStyle: 'minimal' };
    render(<TTSMiniPlayer {...makeProps({ timeoutTimestamp: Date.now() + 90_000 })} />);
    const body = screen.getByLabelText('Open Read Aloud player');
    expect(body.className).toContain('flex-col');
    // Time row and timer chip are separate stacked children, so the timer
    // cannot squeeze the remaining time into truncation.
    const timer = screen.getByText(/^1:(2\d|30)$/);
    const remaining = screen.getByText('-1:30');
    expect(timer.parentElement).toBe(body);
    expect(remaining.parentElement).toBe(body);
    vi.useRealTimers();
  });

  test('minimal style centers the remaining time at full weight', () => {
    viewSettingsOverride = { ttsPlayerStyle: 'minimal' };
    render(<TTSMiniPlayer {...makeProps()} />);
    const body = screen.getByLabelText('Open Read Aloud player');
    expect(body.className).toContain('justify-center');
    const remaining = screen.getByText('-1:30');
    expect(remaining.className).toContain('font-medium');
    expect(remaining.className).not.toContain('text-base-content/60');
  });

  test('sentence and paragraph skips and play/pause drive the transport callbacks', () => {
    viewSettingsOverride = { ttsPlayerStyle: 'minimal' };
    const props = makeProps();
    render(<TTSMiniPlayer {...props} />);
    fireEvent.click(screen.getByLabelText('Previous Sentence'));
    expect(props.onBackward).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByLabelText('Next Sentence'));
    expect(props.onForward).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByLabelText('Previous Paragraph'));
    expect(props.onBackward).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByLabelText('Next Paragraph'));
    expect(props.onForward).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByLabelText('Pause'));
    expect(props.onTogglePlay).toHaveBeenCalled();
    expect(screen.getByLabelText('Next Sentence').closest('[dir="ltr"]')).toBeTruthy();
    expect(screen.getByLabelText('Next Paragraph').closest('[dir="ltr"]')).toBeTruthy();
  });

  test('play and pause glyphs share a size so toggling does not shift the row', () => {
    viewSettingsOverride = { ttsPlayerStyle: 'minimal' };
    const { rerender } = render(<TTSMiniPlayer {...makeProps({ isPlaying: true })} />);
    const pauseWidth = screen.getByLabelText('Pause').querySelector('svg')?.getAttribute('width');
    rerender(<TTSMiniPlayer {...makeProps({ isPlaying: false })} />);
    const playWidth = screen.getByLabelText('Play').querySelector('svg')?.getAttribute('width');
    expect(pauseWidth).toBeTruthy();
    expect(playWidth).toBe(pauseWidth);
  });

  test('stop button stops without expanding', () => {
    const props = makeProps();
    render(<TTSMiniPlayer {...props} />);
    fireEvent.click(screen.getByLabelText('Stop reading aloud'));
    expect(props.onStop).toHaveBeenCalled();
    expect(props.onExpand).not.toHaveBeenCalled();
  });

  // #5310: an accidental hit on a sixth crowded glyph ends the session, and
  // stopping already lives on the toolbar TTS button that started it.
  test('minimal style has no stop button, leaving five transport glyphs', () => {
    viewSettingsOverride = { ttsPlayerStyle: 'minimal' };
    render(<TTSMiniPlayer {...makeProps()} />);
    expect(screen.queryByLabelText('Stop reading aloud')).toBeNull();
    const row = screen.getByLabelText('Next Sentence').closest('[dir="ltr"]');
    // The settings glyph plus five transport glyphs; stop is not among them.
    expect(row?.querySelectorAll('button')).toHaveLength(6);
  });

  // The transport halves, not the time, take the row's slack -- otherwise the
  // glyphs stay crammed against the edges while the sides sit empty (#5310).
  test('minimal style spreads each transport half across its side', () => {
    viewSettingsOverride = { ttsPlayerStyle: 'minimal' };
    render(<TTSMiniPlayer {...makeProps()} />);
    const left = screen.getByLabelText('Previous Sentence').parentElement;
    const right = screen.getByLabelText('Next Sentence').parentElement;
    expect(left?.className).toContain('justify-between');
    expect(right?.className).toContain('justify-between');
  });

  // #5636: the card reads as a symmetric transport. The play glyph sits in the
  // exact middle of the card so it doubles as a halfway mark against the
  // progress line on the bottom edge, and the remaining time moves to the far
  // right where it hangs over the un-played part of that line.
  test('minimal style centers the play button and puts the time on the right', () => {
    viewSettingsOverride = { ttsPlayerStyle: 'minimal' };
    render(<TTSMiniPlayer {...makeProps()} />);
    const play = screen.getByLabelText('Pause');
    const row = play.parentElement;
    // All seven items sit in one between-spread row, mirrored widths about the
    // middle: the equal gaps are what land the play glyph on the midpoint.
    expect(row?.className).toContain('justify-between');
    expect(row?.children).toHaveLength(7);
    const items = Array.from(row?.children ?? []);
    expect(items[0]).toBe(screen.getByLabelText('Playback settings'));
    expect(items[1]).toBe(screen.getByLabelText('Previous Paragraph'));
    expect(items[2]).toBe(screen.getByLabelText('Previous Sentence'));
    expect(items[3]).toBe(play);
    expect(items[4]).toBe(screen.getByLabelText('Next Sentence'));
    expect(items[5]).toBe(screen.getByLabelText('Next Paragraph'));
    // The time box ends the row, mirroring the settings glyph that starts it.
    expect(items[6]).toBe(screen.getByLabelText('Open Read Aloud player'));
  });

  // The two end boxes share one fixed width -- with the skip glyphs paired off,
  // that is what makes the item widths mirror, so the even between-spread gaps
  // put the play glyph dead-center rather than merely near it.
  test('minimal style gives the settings glyph the same fixed box as the time', () => {
    viewSettingsOverride = { ttsPlayerStyle: 'minimal' };
    render(<TTSMiniPlayer {...makeProps()} />);
    expect(screen.getByLabelText('Playback settings').className).toContain('w-14');
    expect(screen.getByLabelText('Open Read Aloud player').className).toContain('w-14');
  });

  // A content-sized box would re-center every glyph as the label narrows on
  // "-10:00" -> "-9:59", so the time gets a fixed one.
  test('minimal style gives the time a fixed box so the glyphs never shift', () => {
    viewSettingsOverride = { ttsPlayerStyle: 'minimal' };
    const width = (seconds: number) => {
      const info = { position: 0, duration: seconds, measuredFraction: 0 };
      render(
        <TTSMiniPlayer {...makeProps({ onGetPlaybackInfo: vi.fn().mockReturnValue(info) })} />,
      );
      const time = screen.getByLabelText('Open Read Aloud player');
      expect(time.className).not.toContain('flex-1');
      const cls = time.className;
      cleanup();
      return cls;
    };
    // Same box class for a short and a long label; nothing is content-sized.
    expect(width(83)).toContain('w-14');
    expect(width(3599)).toContain('w-14');
  });

  test('minimal style shows a bare countdown when there is no playback timeline', () => {
    viewSettingsOverride = { ttsPlayerStyle: 'minimal' };
    render(
      <TTSMiniPlayer
        {...makeProps({
          hasTimeline: false,
          chapterRemainingSec: 300,
          onGetPlaybackInfo: vi.fn().mockReturnValue(null),
        })}
      />,
    );
    // The wordy full-style phrasing does not fit the one slot the minimal card
    // has, and the sign keeps it reading as the same quantity as the timeline
    // case rather than a different one.
    expect(screen.queryByText(/left in chapter/)).toBeNull();
    expect(screen.getByText('-5:00')).toBeTruthy();
  });

  test('tapping the body expands the player sheet', () => {
    viewSettingsOverride = { ttsPlayerStyle: 'minimal' };
    const props = makeProps();
    render(<TTSMiniPlayer {...props} />);
    fireEvent.click(screen.getByLabelText('Open Read Aloud player'));
    expect(props.onExpand).toHaveBeenCalled();
  });

  test('the settings affordance shows the speed and opens the full player', () => {
    viewSettingsOverride = { ttsPlayerStyle: 'minimal' };
    const props = makeProps();
    render(<TTSMiniPlayer {...props} />);
    const btn = screen.getByLabelText('Playback settings');
    expect(btn.textContent).toBe('1.3×'); // DEFAULT_VIEW_CONFIG ttsRate
    fireEvent.click(btn);
    expect(props.onExpand).toHaveBeenCalled();
  });

  test('rides above the bottom bar while it is up for this book', () => {
    readerState.hoveredBookKey = 'b1';
    render(<TTSMiniPlayer {...makeProps()} />);
    const card = screen.getByRole('status');
    // Desktop footer bar (52px) + 8px gap; the card stays interactive.
    expect(card.style.bottom).toBe('60px');
    expect(card.className).not.toContain('pointer-events-none');
  });

  test('household mobile player tracks the thumb bar height and rests normally when hidden', () => {
    vi.stubGlobal('innerWidth', 412);
    vi.stubGlobal('innerHeight', 824);
    let barHeight = 137;
    let resize: (() => void) | undefined;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    const cell = document.createElement('div');
    cell.id = 'gridcell-b1';
    const bar = document.createElement('div');
    bar.className = 'footer-bar';
    bar.getBoundingClientRect = () => ({ height: barHeight }) as DOMRect;
    cell.appendChild(bar);
    document.body.appendChild(cell);
    try {
      readerState.hoveredBookKey = 'b1';
      const { rerender } = render(<TTSMiniPlayer {...makeProps()} />);
      expect(screen.getByRole('status').style.bottom).toBe('137px');
      barHeight = 161;
      act(() => resize?.());
      expect(screen.getByRole('status').style.bottom).toBe('161px');
      readerState.hoveredBookKey = '';
      rerender(<TTSMiniPlayer {...makeProps()} />);
      expect(screen.getByRole('status').style.bottom).toBe(
        `${DEFAULT_BOOK_LAYOUT.marginBottomPx}px`,
      );
    } finally {
      cell.remove();
      vi.unstubAllGlobals();
    }
  });

  test('rides above an expanded action panel while one is open', () => {
    readerState.hoveredBookKey = 'b1';
    readerState.bottomBarTab = 'font';
    const cell = document.createElement('div');
    cell.id = 'gridcell-b1';
    const panel = document.createElement('div');
    panel.className = 'footerbar-font-mobile';
    cell.appendChild(panel);
    document.body.appendChild(cell);
    cell.getBoundingClientRect = () => ({ bottom: 800, top: 0, height: 800 }) as DOMRect;
    // Panel settled at 600..736 above the nav bar; no transform in jsdom.
    panel.getBoundingClientRect = () => ({ top: 600, bottom: 736, height: 136 }) as DOMRect;
    try {
      render(<TTSMiniPlayer {...makeProps()} />);
      // 800 - 600 + 8px gap; beats the plain above-the-bar offset.
      expect(screen.getByRole('status').style.bottom).toBe('208px');
    } finally {
      cell.remove();
    }
  });

  test('rests above the footer info band once the bar is dismissed', () => {
    render(<TTSMiniPlayer {...makeProps()} />);
    expect(screen.getByRole('status').style.bottom).toBe(`${DEFAULT_BOOK_LAYOUT.marginBottomPx}px`);
  });

  // The full card fades out with the reader chrome (#5310); it stays mounted so
  // the opacity transition can run, hence the pointer-events lockout.
  test('fades out and stops taking taps once hidden', () => {
    render(<TTSMiniPlayer {...makeProps({ visible: false })} />);
    const card = screen.getByRole('status');
    expect(card.className).toContain('opacity-0');
    expect(card.className).toContain('pointer-events-none');
    expect(card.className).not.toContain('opacity-100');
  });

  test('without a timeline shows the estimated chapter remaining instead', () => {
    render(
      <TTSMiniPlayer
        {...makeProps({
          hasTimeline: false,
          chapterRemainingSec: 300,
          onGetPlaybackInfo: vi.fn().mockReturnValue(null),
        })}
      />,
    );
    expect(screen.getByText(/5:00 left in chapter/)).toBeTruthy();
    expect(screen.queryByText(/-1:30/)).toBeNull();
  });

  test('shows a countdown chip while a sleep timer is armed', () => {
    vi.useFakeTimers();
    render(<TTSMiniPlayer {...makeProps({ timeoutTimestamp: Date.now() + 90_000 })} />);
    expect(screen.getByText(/^1:(2\d|30)$/)).toBeTruthy();
    vi.useRealTimers();
  });

  // Player Style 'full': the pre-#5162 card (0.11.18) with book cover, book
  // title, chapter + timestamps line, and the sentence-only transport.
  test('full style is the default and shows cover, book title, chapter and timestamps', () => {
    getBookData.mockReturnValue({
      book: { title: 'Alice in Wonderland', coverImageUrl: 'blob:cover' },
    });
    const { container } = render(<TTSMiniPlayer {...makeProps()} />);
    expect(screen.getByText('Alice in Wonderland')).toBeTruthy();
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:cover');
    expect(screen.getByText('Chapter 5 · 0:10 · -1:30')).toBeTruthy();
  });

  test('full style keeps the sentence-only transport without minimal chrome', () => {
    const props = makeProps();
    render(<TTSMiniPlayer {...props} />);
    fireEvent.click(screen.getByLabelText('Previous Sentence'));
    expect(props.onBackward).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByLabelText('Next Sentence'));
    expect(props.onForward).toHaveBeenCalledWith(true);
    expect(screen.queryByLabelText('Previous Paragraph')).toBeNull();
    expect(screen.queryByLabelText('Next Paragraph')).toBeNull();
    expect(screen.queryByLabelText('Playback settings')).toBeNull();
  });

  test('full style expands the sheet from the book info area', () => {
    getBookData.mockReturnValue({
      book: { title: 'Alice in Wonderland', coverImageUrl: 'blob:cover' },
    });
    const props = makeProps();
    render(<TTSMiniPlayer {...props} />);
    fireEvent.click(screen.getByLabelText('Open Read Aloud player'));
    expect(props.onExpand).toHaveBeenCalled();
  });

  // Household e-ink phone: a full-width strip docked on the thumb bar, drawn
  // like the bar itself, never a floating card.
  describe('docked e-ink strip', () => {
    beforeEach(() => {
      vi.stubGlobal('innerWidth', 412);
      vi.stubGlobal('innerHeight', 824);
      getBookData.mockReturnValue({ book: { title: 'Titan', coverImageUrl: 'blob:cover' } });
    });
    afterEach(() => vi.unstubAllGlobals());

    const strip = () => screen.getByRole('status');
    const surface = () => strip().firstElementChild as HTMLElement;

    test('spans the width with one 2px top rule, no card chrome, no cover', () => {
      const { container } = render(<TTSMiniPlayer {...makeProps({ isEink: true })} />);
      expect(strip().className).toContain('inset-x-0');
      expect(strip().className).not.toContain('inset-x-4');
      expect(surface().className).toContain('border-t-2');
      for (const chrome of ['rounded-2xl', 'shadow-lg', 'eink-bordered'])
        expect(surface().className).not.toContain(chrome);
      expect(container.querySelector('img')).toBeNull();
      // No animated move or fade for the panel to ghost.
      expect(strip().className).not.toContain('transition-[bottom,opacity]');
      expect(strip().className).toContain('eink:transition-none');
    });

    test('names the book in semibold, then the section and only the time left', () => {
      render(<TTSMiniPlayer {...makeProps({ isEink: true })} />);
      expect(screen.getByText('Titan').className).toContain('font-semibold');
      const line = screen.getByText('Chapter 5').parentElement!;
      expect(line.textContent).toBe('Chapter 5 · -1:30');
      // The section may truncate; the time left may not.
      expect(screen.getByText('Chapter 5').className).toContain('truncate');
      expect(screen.getByText('· -1:30').className).toContain('shrink-0');
    });

    test('skips sentences with the same chevrons as the player sheet', () => {
      render(<TTSMiniPlayer {...makeProps({ isEink: true })} />);
      const { container: left } = render(<MdKeyboardArrowLeft />);
      const { container: right } = render(<MdKeyboardArrowRight />);
      const path = (el: Element | null) => el?.querySelector('path')?.getAttribute('d');
      expect(path(screen.getByLabelText('Previous Sentence'))).toBe(path(left));
      expect(path(screen.getByLabelText('Next Sentence'))).toBe(path(right));
    });

    // The bar overlays the page and the text never reflows for it; the strip
    // reserves only its bottom band, so it must not ride above the open bar
    // over text nothing reserved. It yields and returns when the bar closes.
    test('yields while the thumb bar is open and returns when it closes', () => {
      readerState.hoveredBookKey = 'b1';
      const { rerender } = render(<TTSMiniPlayer {...makeProps({ isEink: true })} />);
      expect(screen.queryByRole('status')).toBeNull();
      readerState.hoveredBookKey = '';
      rerender(<TTSMiniPlayer {...makeProps({ isEink: true })} />);
      expect(strip().style.bottom).toBe(`${DEFAULT_BOOK_LAYOUT.marginBottomPx}px`);
    });

    test('docks flush on the screen edge when the bar is hidden and no footer renders', () => {
      viewSettingsOverride = { showFooter: false };
      render(<TTSMiniPlayer {...makeProps({ isEink: true })} />);
      expect(strip().style.bottom).toBe('0px');
    });

    test('docks on the footer band when the bar is hidden', () => {
      render(<TTSMiniPlayer {...makeProps({ isEink: true })} />);
      expect(strip().style.bottom).toBe(`${DEFAULT_BOOK_LAYOUT.marginBottomPx}px`);
    });

    test('a colour or desktop window keeps the floating card', () => {
      render(<TTSMiniPlayer {...makeProps({ isEink: false })} />);
      expect(surface().className).toContain('rounded-2xl');
      expect(strip().className).toContain('inset-x-4');
    });
  });
});
