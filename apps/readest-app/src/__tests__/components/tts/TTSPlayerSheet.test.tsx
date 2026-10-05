import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor as waitForWithOptions,
} from '@testing-library/react';

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (key: string, opts?: Record<string, unknown>) =>
    opts ? Object.entries(opts).reduce((s, [k, v]) => s.replace(`{{${k}}}`, String(v)), key) : key,
}));

vi.mock('@/hooks/useResponsiveSize', () => ({
  useResponsiveSize: (size: number) => size,
  useDefaultIconSize: () => 24,
}));

vi.mock('@/components/Dialog', () => ({
  default: ({
    isOpen,
    title,
    header,
    boxClassName,
    children,
  }: {
    isOpen: boolean;
    title: string;
    header?: React.ReactNode;
    boxClassName?: string;
    children: React.ReactNode;
  }) =>
    isOpen ? (
      <div role='dialog' aria-label={title} data-box-class={boxClassName}>
        {header}
        {children}
      </div>
    ) : null,
}));

const envConfig = {};
vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ envConfig, appService: { hasHaptics: false } }),
}));

const viewSettings: Record<string, unknown> = {};
const setViewSettings = vi.fn();
vi.mock('@/store/readerStore', () => ({
  useReaderStore: () => ({
    getViewSettings: () => viewSettings,
    setViewSettings,
  }),
}));

const settings = { globalViewSettings: { ttsRate: 1.0, ttsSentenceGap: 0.15 } };
const saveSettings = vi.fn();
const settingsState = { settings, setSettings: vi.fn(), saveSettings };
vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: Object.assign(() => settingsState, { getState: () => settingsState }),
}));

const getBookData = vi.fn();
vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: () => ({ getBookData }),
}));

vi.mock('@/store/readerProgressStore', () => ({
  useBookProgress: () => ({ sectionLabel: 'Chapter 5' }),
}));

// Premium gating for the offline-audio row. Defaults to a signed-in premium
// user so the existing tests (which don't render the row) are unaffected;
// the gating tests below flip these.
const { routerPush, mockAuth, mockQuota } = vi.hoisted(() => ({
  routerPush: vi.fn(),
  mockAuth: { user: { id: 'u' } as { id: string } | null },
  mockQuota: {
    userProfilePlan: 'pro' as 'free' | 'plus' | 'pro' | 'purchase' | undefined,
  },
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: routerPush }) }));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: mockAuth.user, token: 'tok' }),
}));
vi.mock('@/hooks/useQuotaStats', () => ({
  useQuotaStats: () => ({ userProfilePlan: mockQuota.userProfilePlan }),
}));
vi.mock('@/app/reader/components/tts/TTSChaptersView', () => ({
  default: () => <div>chapters-view</div>,
}));

const narrationAvailability = vi.hoisted(() => ({ state: 'unknown' }));
vi.mock('@/app/reader/hooks/useNarrationAvailability', () => ({
  useNarrationAvailability: () => narrationAvailability,
  NARRATION_STATUS_OPEN_EVENT: 'narration-status-open',
}));

import { eventDispatcher } from '@/utils/event';
import TTSPlayerSheet from '@/app/reader/components/tts/TTSPlayerSheet';

const waitFor = <T,>(callback: () => T | Promise<T>) =>
  waitForWithOptions(callback, { interval: 1 });

const voiceGroups = [
  {
    id: 'edge',
    name: 'Edge TTS',
    voices: [
      { id: 'ava', name: 'Ava', lang: 'en-US', disabled: false },
      { id: 'guy', name: 'Guy', lang: 'en-US', disabled: false },
    ],
  },
];

const makeProps = (overrides: Record<string, unknown> = {}) => ({
  bookKey: 'b1',
  isOpen: true,
  ttsLang: 'en',
  isPlaying: true,
  hasTimeline: true,
  timeoutOption: 0,
  timeoutTimestamp: 0,
  chapterRemainingSec: null as number | null,
  onClose: vi.fn(),
  onTogglePlay: vi.fn(),
  onBackward: vi.fn(),
  onForward: vi.fn(),
  onPreviousChapter: vi.fn(),
  onNextChapter: vi.fn(),
  onSetRate: vi.fn(),
  onGetVoices: vi.fn().mockResolvedValue(voiceGroups),
  onSetVoice: vi.fn(),
  onGetVoiceId: vi.fn().mockReturnValue('ava'),
  onSelectTimeout: vi.fn(),
  onSeek: vi.fn().mockResolvedValue(undefined),
  onSeekPreview: vi.fn(),
  onGetPlaybackInfo: vi
    .fn()
    .mockReturnValue({ position: 10, duration: 100, measuredFraction: 0.4 }),
  downloads: {
    supported: false,
    chapters: [],
    statuses: new Map(),
    cacheBytes: 0,
    clearing: false,
    items: [],
    itemFor: () => undefined,
    downloadChapter: vi.fn(),
    downloadAll: vi.fn(),
    cancelChapter: vi.fn(),
    cancelAll: vi.fn(),
    clearDownloads: vi.fn().mockResolvedValue(undefined),
    statusOf: vi.fn().mockReturnValue('none'),
    refresh: vi.fn().mockResolvedValue(undefined),
  },
  activeSectionIndex: null as number | null,
  ...overrides,
});

describe('TTSPlayerSheet', () => {
  beforeEach(() => {
    narrationAvailability.state = 'unknown';
    viewSettings['ttsRate'] = 1.0;
    viewSettings['ttsSentenceGap'] = 0.15;
    viewSettings['isEink'] = false;
    // Shared fixture object: clear what individual tests write, or a value set
    // by one test leaks into the next.
    delete viewSettings['ttsVoice'];
    delete viewSettings['ttsUseNarration'];
    getBookData.mockReturnValue({
      book: { title: 'Alice in Wonderland', coverImageUrl: null },
    });
    // Default: signed-in premium user (the row-less tests never hit the gate).
    mockAuth.user = { id: 'u' };
    mockQuota.userProfilePlan = 'pro';
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  test('shows title, chapter, scrubber, and transport on the main view', async () => {
    render(<TTSPlayerSheet {...makeProps()} />);
    expect(screen.getByText('Alice in Wonderland')).toBeTruthy();
    expect(screen.getByText('Chapter 5')).toBeTruthy();
    expect(screen.getByRole('slider')).toBeTruthy();
    expect(screen.getByLabelText('Previous Paragraph')).toBeTruthy();
    expect(screen.getByLabelText('Next Paragraph')).toBeTruthy();
    // Compact one-row controls: speed / voice / sleep timer buttons.
    expect(screen.getByLabelText('Speed')).toBeTruthy();
    expect(screen.getByLabelText('Sleep Timer')).toBeTruthy();
    expect(await waitFor(() => screen.getByText('Ava'))).toBeTruthy(); // voice button caption
    // The main view carries no header label (vertical space).
    expect(screen.queryByText('Read Aloud')).toBeNull();
  });

  test('synthetic speech keeps the Read Aloud title, not Listen', async () => {
    render(<TTSPlayerSheet {...makeProps()} />);
    expect(screen.getByRole('dialog', { name: 'Read Aloud' })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Listen' })).toBeNull();
    expect(await waitFor(() => screen.getByText('Ava'))).toBeTruthy();
  });

  test('degrades without a timeline: no scrubber, estimate text instead', () => {
    render(
      <TTSPlayerSheet
        {...makeProps({
          hasTimeline: false,
          chapterRemainingSec: 300,
          onGetPlaybackInfo: vi.fn().mockReturnValue(null),
        })}
      />,
    );
    expect(screen.queryByRole('slider')).toBeNull();
    expect(screen.getByText(/5:00 left in chapter/)).toBeTruthy();
  });

  test('transport buttons pass paragraph/sentence semantics', () => {
    const props = makeProps();
    render(<TTSPlayerSheet {...props} />);
    fireEvent.click(screen.getByLabelText('Previous Paragraph'));
    expect(props.onBackward).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByLabelText('Previous Sentence'));
    expect(props.onBackward).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByLabelText('Next Sentence'));
    expect(props.onForward).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByLabelText('Next Paragraph'));
    expect(props.onForward).toHaveBeenCalledWith(false);
  });

  test('main view offers a close button since desktop has no drag handle', () => {
    const props = makeProps();
    render(<TTSPlayerSheet {...props} />);
    fireEvent.click(screen.getByLabelText('Close'));
    expect(props.onClose).toHaveBeenCalled();
  });

  test('main view keeps the cover clear of the sheet top edge on desktop', () => {
    // The sheet content is pulled up (mt-[-4px]) to tuck under the mobile
    // drag handle; on sm+ the handle is hidden and the main view needs its
    // own top padding or the cover clips into the rounded top edge.
    getBookData.mockReturnValue({
      book: { title: 'Alice in Wonderland', coverImageUrl: 'blob:cover' },
    });
    const { container } = render(<TTSPlayerSheet {...makeProps()} />);
    const cover = container.querySelector('img');
    expect(cover).toBeTruthy();
    expect(cover?.parentElement?.className).toContain('sm:pt-4');
  });

  test('the speed caption pads and truncates like its sibling captions', () => {
    // 'Geschwindigkeit' (de) overflows the compact button edge-to-edge
    // without the max-w-full/truncate/px-1 combo the other captions use.
    render(<TTSPlayerSheet {...makeProps()} />);
    const caption = screen.getByText('Speed');
    expect(caption.className).toContain('max-w-full');
    expect(caption.className).toContain('truncate');
    expect(caption.className).toContain('px-1');
  });

  test('speed button drills into the ruler and releasing a drag persists the rate', () => {
    const props = makeProps();
    render(<TTSPlayerSheet {...props} />);
    fireEvent.click(screen.getByLabelText('Speed'));
    const slider = screen.getByRole('slider', { name: 'Speed' });
    fireEvent.change(slider, { target: { value: '1.5' } });
    expect(props.onSetRate).not.toHaveBeenCalled();
    fireEvent.pointerUp(slider);
    expect(props.onSetRate).toHaveBeenCalledWith(1.5);
    expect(viewSettings['ttsRate']).toBe(1.5);
    expect(settings.globalViewSettings.ttsRate).toBe(1.5);
    expect(saveSettings).toHaveBeenCalled();
  });

  test('voice button drills into the voice list and selects a voice', async () => {
    const props = makeProps();
    render(<TTSPlayerSheet {...props} />);
    fireEvent.click(screen.getByLabelText('Voice'));
    fireEvent.click(await waitFor(() => screen.getByText('Guy')));
    expect(props.onSetVoice).toHaveBeenCalledWith('guy', 'en-US');
    expect(viewSettings['ttsVoice']).toBe('guy');
  });

  test('timer button drills into the timer list and selects a timeout', async () => {
    const props = makeProps();
    render(<TTSPlayerSheet {...props} />);
    fireEvent.click(screen.getByLabelText('Sleep Timer'));
    // The translation mock interpolates, so options render as real labels.
    fireEvent.click(screen.getByText('30 minutes'));
    expect(props.onSelectTimeout).toHaveBeenCalledWith('b1', 1800);
  });

  const makeDownloads = (over: Record<string, unknown> = {}) => ({
    supported: true,
    chapters: [{ key: 'c1', label: 'One', depth: 0, startSection: 0, endSection: 1 }],
    statuses: new Map(),
    cacheBytes: 0,
    clearing: false,
    items: [],
    itemFor: () => undefined,
    downloadChapter: vi.fn(),
    downloadAll: vi.fn(),
    cancelChapter: vi.fn(),
    cancelAll: vi.fn(),
    clearDownloads: vi.fn().mockResolvedValue(undefined),
    statusOf: vi.fn().mockReturnValue('complete'),
    refresh: vi.fn().mockResolvedValue(undefined),
    ...over,
  });

  test('offline audio row: a premium user has no badge and opens the chapters view', () => {
    mockQuota.userProfilePlan = 'pro';
    const props = makeProps({ downloads: makeDownloads() });
    render(<TTSPlayerSheet {...props} />);
    const row = screen.getByLabelText('Offline Audio');
    expect(screen.queryByText('Premium')).toBeNull();
    expect(screen.getByText('1 of 1 downloaded')).toBeTruthy();
    fireEvent.click(row);
    expect(screen.getByText('chapters-view')).toBeTruthy();
    expect(routerPush).not.toHaveBeenCalled();
  });

  test('offline audio row: a free user sees a Premium badge and is routed to upgrade', () => {
    mockQuota.userProfilePlan = 'free';
    const props = makeProps({ downloads: makeDownloads() });
    render(<TTSPlayerSheet {...props} />);
    expect(screen.getByText('Premium')).toBeTruthy();
    expect(screen.getByText('Download chapters for offline playback')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Offline Audio'));
    expect(routerPush).toHaveBeenCalledWith('/user');
    expect(props.onClose).toHaveBeenCalled();
    // The premium chapters view must not open for a free user.
    expect(screen.queryByText('chapters-view')).toBeNull();
  });

  test('offline audio row: a signed-out user is routed to sign-in', () => {
    mockAuth.user = null;
    mockQuota.userProfilePlan = undefined;
    const props = makeProps({ downloads: makeDownloads() });
    render(<TTSPlayerSheet {...props} />);
    expect(screen.getByText('Premium')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Offline Audio'));
    expect(routerPush).toHaveBeenCalledWith(expect.stringContaining('/auth?redirect='));
    expect(screen.queryByText('chapters-view')).toBeNull();
  });

  // Books with recorded narration (EPUB 3 Media Overlays) surface the narrator
  // as a voice; there is nothing to pre-download while it is selected.
  const narrationGroups = [
    {
      id: 'media-overlay',
      name: 'Narration',
      voices: [{ id: 'media-overlay', name: 'Jane Reader', lang: 'en' }],
    },
    ...voiceGroups,
  ];

  test('offline audio row is hidden while the book own narration is playing', async () => {
    const props = makeProps({
      downloads: makeDownloads(),
      onGetVoices: vi.fn().mockResolvedValue(narrationGroups),
      onGetVoiceId: vi.fn().mockReturnValue('media-overlay'),
    });
    render(<TTSPlayerSheet {...props} />);
    await waitFor(() => expect(screen.queryByLabelText('Voice')).toBeNull());
    expect(screen.queryByText('Book narration')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Listen' })).toBeTruthy();
    expect(screen.queryByLabelText('Offline Audio')).toBeNull();
  });

  // User-visible sheet contracts: wrong mode routing, missing transport or
  // synthetic controls leaking into narration must fail at the rendered UI.
  test.each([
    'Jane Reader',
    '',
    undefined,
  ])('narrated player uses audiobook controls and narrator %s', (narrator) => {
    narrationAvailability.state = 'narrated';
    getBookData.mockReturnValue({
      book: { title: 'Alice in Wonderland' },
      bookDoc: { media: { narrator } },
    });
    const props = makeProps({ downloads: makeDownloads() });
    render(<TTSPlayerSheet {...props} />);
    expect(screen.getByRole('dialog', { name: 'Listen' })).toBeTruthy();
    for (const label of [
      'Previous Chapter',
      'Previous Sentence',
      'Pause',
      'Next Sentence',
      'Next Chapter',
    ]) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    }
    expect(screen.queryByLabelText('Voice')).toBeNull();
    expect(screen.queryByLabelText('Offline Audio')).toBeNull();
    expect(screen.queryByLabelText('Previous Paragraph')).toBeNull();
    expect(screen.queryByLabelText('Next Paragraph')).toBeNull();
    expect(screen.queryByText('Premium')).toBeNull();
    expect(screen.queryByText('Book narration')).toBeNull();
    if (narrator) expect(screen.getByText('Read by Jane Reader')).toBeTruthy();
    else expect(screen.queryByText(/Read by/)).toBeNull();
    fireEvent.click(screen.getByLabelText('Previous Sentence'));
    expect(props.onBackward).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByLabelText('Next Sentence'));
    expect(props.onForward).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByLabelText('Pause'));
    expect(props.onTogglePlay).toHaveBeenCalledOnce();
  });

  test('narration speed is a selectable preset list, not a ruler', () => {
    narrationAvailability.state = 'narrated';
    const props = makeProps();
    render(<TTSPlayerSheet {...props} />);
    fireEvent.click(screen.getByLabelText('Speed'));
    expect(screen.queryByRole('slider')).toBeNull();
    for (const label of ['0.8×', '1×', '1.2×', '1.5×', '1.75×', '2×']) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    }
    expect(screen.getByRole('button', { name: '1×' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '1.75×' }));
    expect(props.onSetRate).toHaveBeenCalledWith(1.75);
    expect(screen.getByRole('button', { name: '1.75×' }).getAttribute('aria-pressed')).toBe('true');
  });

  test('chapter buttons delegate without toggling playback or using paragraph fallbacks', () => {
    narrationAvailability.state = 'narrated';
    const props = makeProps({
      isPlaying: false,
      onPreviousChapter: vi.fn(),
      onNextChapter: vi.fn(),
    });
    render(<TTSPlayerSheet {...props} />);
    fireEvent.click(screen.getByLabelText('Previous Chapter'));
    fireEvent.click(screen.getByLabelText('Next Chapter'));
    expect(props.onPreviousChapter).toHaveBeenCalledOnce();
    expect(props.onNextChapter).toHaveBeenCalledOnce();
    expect(props.onSeek).not.toHaveBeenCalled();
    expect(props.onBackward).not.toHaveBeenCalled();
    expect(props.onForward).not.toHaveBeenCalled();
    expect(props.onTogglePlay).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Play')).toBeTruthy();
  });

  test.each([
    ['queued', 'Narration isn’t ready yet. Using a synthetic voice.'],
    ['aligning', 'Narration isn’t ready yet. Using a synthetic voice.'],
    ['needs-check', 'Narration isn’t ready yet. Using a synthetic voice.'],
    ['fetching-edition', 'Narration isn’t ready yet. Using a synthetic voice.'],
    ['swap-ready', 'Narration is ready. Tap to switch.'],
    ['failed', 'Alignment failed. Using a synthetic voice.'],
    ['can-align', 'Your audiobook isn’t aligned yet. Using a synthetic voice.'],
  ])('synthetic %s line opens narration status for this book', async (state, copy) => {
    narrationAvailability.state = state;
    const opened: unknown[] = [];
    const handler = (event: CustomEvent) => {
      opened.push(event.detail);
    };
    eventDispatcher.on('narration-status-open', handler);
    try {
      render(<TTSPlayerSheet {...makeProps()} />);
      fireEvent.click(screen.getByRole('button', { name: copy }));
      await waitFor(() => expect(opened).toEqual([{ bookKey: 'b1' }]));
    } finally {
      eventDispatcher.off('narration-status-open', handler);
    }
  });

  test('no audiobook is static text and unknown has no availability line', () => {
    narrationAvailability.state = 'none';
    const props = makeProps();
    const { rerender } = render(<TTSPlayerSheet {...props} />);
    const copy = 'No audiobook for this book. Using a synthetic voice.';
    expect(screen.getByText(copy).tagName).toBe('SPAN');
    expect(screen.queryByRole('button', { name: copy })).toBeNull();
    narrationAvailability.state = 'unknown';
    rerender(<TTSPlayerSheet {...props} />);
    expect(screen.queryByText(copy)).toBeNull();
    expect(screen.queryByText(/Using a synthetic voice/)).toBeNull();
  });

  test('e-ink chapter clock and sleep timer update on sentences, not one-second ticks', async () => {
    vi.useFakeTimers();
    try {
      narrationAvailability.state = 'narrated';
      viewSettings['isEink'] = true;
      let position = 10;
      const props = makeProps({
        timeoutOption: 60,
        timeoutTimestamp: Date.now() + 60000,
        onGetPlaybackInfo: () => ({ position, duration: 100, measuredFraction: 1 }),
      });
      render(<TTSPlayerSheet {...props} />);
      expect(screen.getByRole('slider').getAttribute('value')).toBe('10');
      const timer = screen.getByLabelText('Sleep Timer').textContent;
      position = 20;
      const { act } = await import('@testing-library/react');
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      expect(screen.getByRole('slider').getAttribute('value')).toBe('10');
      expect(screen.getByLabelText('Sleep Timer').textContent).toBe(timer);
      await act(async () => {
        await eventDispatcher.dispatch('tts-position', { bookKey: 'b1', kind: 'sentence' });
      });
      expect(screen.getByRole('slider').getAttribute('value')).toBe('20');
      expect(screen.getByLabelText('Sleep Timer').textContent).not.toBe(timer);
      expect(screen.getByText('0:20')).toBeTruthy();
      expect(screen.getByText('-1:20')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  test('choosing the narrator records the per-book narration preference', async () => {
    const props = makeProps({ onGetVoices: vi.fn().mockResolvedValue(narrationGroups) });
    render(<TTSPlayerSheet {...props} />);
    fireEvent.click(screen.getByLabelText('Voice'));
    fireEvent.click(await waitFor(() => screen.getByText('Jane Reader')));

    expect(props.onSetVoice).toHaveBeenCalledWith('media-overlay', 'en');
    expect(viewSettings['ttsVoice']).toBe('media-overlay');
    expect(viewSettings['ttsUseNarration']).toBe(true);
  });

  test('choosing a synthetic voice opts this book out of its narration', async () => {
    const props = makeProps({ onGetVoices: vi.fn().mockResolvedValue(narrationGroups) });
    render(<TTSPlayerSheet {...props} />);
    fireEvent.click(screen.getByLabelText('Voice'));
    fireEvent.click(await waitFor(() => screen.getByText('Guy')));

    expect(viewSettings['ttsVoice']).toBe('guy');
    expect(viewSettings['ttsUseNarration']).toBe(false);
  });

  test('a book without narration never writes the narration preference', async () => {
    const props = makeProps();
    render(<TTSPlayerSheet {...props} />);
    fireEvent.click(screen.getByLabelText('Voice'));
    fireEvent.click(await waitFor(() => screen.getByText('Guy')));

    expect(viewSettings['ttsVoice']).toBe('guy');
    expect(viewSettings['ttsUseNarration']).toBeUndefined();
  });

  test('reopening the sheet returns to the main view', async () => {
    const props = makeProps();
    const { rerender } = render(<TTSPlayerSheet {...props} />);
    fireEvent.click(screen.getByLabelText('Voice'));
    expect(await waitFor(() => screen.getByText('Guy'))).toBeTruthy();
    rerender(<TTSPlayerSheet {...props} isOpen={false} />);
    rerender(<TTSPlayerSheet {...props} isOpen={true} />);
    expect(screen.getByLabelText('Previous Paragraph')).toBeTruthy();
    expect(screen.queryByText('Guy')).toBeNull();
  });
});

// Household e-ink phone (the Palma): the sheet sizes to its content, closes
// from a visible Done, names each skip, and draws a paper scrubber track.
describe('TTSPlayerSheet on a household e-ink phone', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_HOUSEHOLD_BUILD', '1');
    vi.stubGlobal('innerWidth', 412);
    vi.stubGlobal('innerHeight', 824);
    narrationAvailability.state = 'unknown';
    viewSettings['isEink'] = true;
    getBookData.mockReturnValue({ book: { title: 'Titan', coverImageUrl: null } });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    viewSettings['isEink'] = false;
    vi.clearAllMocks();
  });

  test('Done closes the sheet, which sizes to its content', () => {
    const props = makeProps();
    render(<TTSPlayerSheet {...props} />);
    expect(screen.getByRole('dialog').dataset['boxClass']).toContain('!h-auto');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  test('each skip is named under its glyph; play is not', () => {
    render(<TTSPlayerSheet {...makeProps()} />);
    const caption = (label: string) => screen.getByLabelText(label).textContent;
    expect(caption('Previous Paragraph')).toBe('Paragraph');
    expect(caption('Previous Sentence')).toBe('Sentence');
    expect(caption('Next Sentence')).toBe('Sentence');
    expect(caption('Next Paragraph')).toBe('Paragraph');
    expect(caption('Pause')).toBe('');
  });

  test('with narration the outer skips are named Chapter', () => {
    narrationAvailability.state = 'narrated';
    render(<TTSPlayerSheet {...makeProps()} />);
    expect(screen.getByLabelText('Previous Chapter').textContent).toBe('Chapter');
    expect(screen.getByLabelText('Next Chapter').textContent).toBe('Chapter');
  });

  test('the scrubber track is solid ink then paper, with no buffered band', () => {
    render(<TTSPlayerSheet {...makeProps()} />);
    const slider = screen.getByRole('slider');
    expect(slider.classList.contains('tts-scrubber-flat')).toBe(true);
    expect(slider.style.backgroundImage).toContain('transparent 10%');
    expect(slider.style.backgroundImage).not.toContain('color-mix');
  });

  test('a desktop-width window keeps the stock sheet', () => {
    vi.stubGlobal('innerWidth', 1280);
    render(<TTSPlayerSheet {...makeProps()} />);
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
    expect(screen.getByLabelText('Previous Sentence').textContent).toBe('');
    expect(screen.getByRole('slider').classList.contains('tts-scrubber-flat')).toBe(false);
  });
});
