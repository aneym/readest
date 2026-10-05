import clsx from 'clsx';
import { ReactNode, useEffect, useState } from 'react';
import {
  MdAlarm,
  MdSkipPrevious,
  MdSkipNext,
  MdArrowBackIosNew,
  MdCheck,
  MdKeyboardArrowLeft,
  MdKeyboardArrowRight,
  MdKeyboardDoubleArrowLeft,
  MdKeyboardDoubleArrowRight,
  MdOutlinePause,
  MdPlayArrow,
  MdOutlineFileDownload,
  MdChevronRight,
} from 'react-icons/md';
import { RiVoiceAiFill } from 'react-icons/ri';
import { useRouter } from 'next/navigation';
import { TTSVoicesGroup } from '@/services/tts';
import { MEDIA_OVERLAY_VOICE_ID } from '@/services/tts/mediaOverlay';
import { useEnv } from '@/context/EnvContext';
import { useAuth } from '@/context/AuthContext';
import { useReaderStore } from '@/store/readerStore';
import { useBookProgress } from '@/store/readerProgressStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { useSettingsStore } from '@/store/settingsStore';
import { TranslationFunc, useTranslation } from '@/hooks/useTranslation';
import { useResponsiveSize } from '@/hooks/useResponsiveSize';
import { useQuotaStats } from '@/hooks/useQuotaStats';
import { isTTSCacheAllowed } from '@/utils/access';
import { isHouseholdBuild } from '@/services/household';
import { eventDispatcher } from '@/utils/event';
import { navigateToLogin, navigateToProfile } from '@/utils/nav';
import { getLanguageName } from '@/utils/lang';
import { formatCountdown, formatPlaybackTime } from '@/utils/time';
import {
  NARRATION_STATUS_OPEN_EVENT,
  useNarrationAvailability,
} from '@/app/reader/hooks/useNarrationAvailability';
import Dialog from '@/components/Dialog';
import { TTSPlaybackInfo } from './usePlaybackInfo';
import TTSScrubber from './TTSScrubber';
import SpeedRuler, { formatRate } from './SpeedRuler';
import TTSChaptersView from './TTSChaptersView';
import { TTS_STOP_AT_CHAPTER_END } from '@/services/tts/TTSSessionManager';
import type { UseTTSDownloadsResult } from '@/app/reader/hooks/useTTSDownloads';
import { isDockedMiniPlayer } from '../../utils/ttsMiniPlayerPosition';

type SheetView = 'main' | 'speed' | 'voice' | 'timer' | 'chapters';

// A transport glyph, optionally named underneath (household e-ink, where the
// chevron pairs alone don't say what they skip). The caption hangs below the
// glyph so every glyph stays centred on the play button.
const TransportGlyph = ({ caption, children }: { caption?: string; children: ReactNode }) =>
  caption ? (
    <span className='relative flex'>
      {children}
      <span
        aria-hidden='true'
        className='absolute left-1/2 top-full -translate-x-1/2 whitespace-nowrap text-[11px] leading-none'
      >
        {caption}
      </span>
    </span>
  ) : (
    <>{children}</>
  );

// Exported so the audiobook player route (src/app/player/components/PlayerView.tsx)
// can reuse the same sleep-timer preset list instead of duplicating it.
export const getTTSTimeoutOptions = (_: TranslationFunc) => {
  return [
    { label: _('No Timeout'), value: 0 },
    { label: _('End of Chapter'), value: TTS_STOP_AT_CHAPTER_END },
    { label: _('{{value}} minute', { value: 1 }), value: 60 },
    { label: _('{{value}} minutes', { value: 3 }), value: 180 },
    { label: _('{{value}} minutes', { value: 5 }), value: 300 },
    { label: _('{{value}} minutes', { value: 10 }), value: 600 },
    { label: _('{{value}} minutes', { value: 20 }), value: 1200 },
    { label: _('{{value}} minutes', { value: 30 }), value: 1800 },
    { label: _('{{value}} minutes', { value: 45 }), value: 2700 },
    { label: _('{{value}} hour', { value: 1 }), value: 3600 },
    { label: _('{{value}} hours', { value: 2 }), value: 7200 },
    { label: _('{{value}} hours', { value: 3 }), value: 10800 },
    { label: _('{{value}} hours', { value: 4 }), value: 14400 },
    { label: _('{{value}} hours', { value: 6 }), value: 21600 },
    { label: _('{{value}} hours', { value: 8 }), value: 28800 },
  ];
};

type TTSPlayerSheetProps = {
  bookKey: string;
  isOpen: boolean;
  ttsLang: string;
  isPlaying: boolean;
  hasTimeline: boolean;
  timeoutOption: number;
  timeoutTimestamp: number;
  chapterRemainingSec: number | null;
  onClose: () => void;
  onTogglePlay: () => void;
  onBackward: (byMark: boolean) => void;
  onForward: (byMark: boolean) => void;
  onPreviousChapter?: () => void;
  onNextChapter?: () => void;
  onSetRate: (rate: number) => void;
  onGetVoices: (lang: string) => Promise<TTSVoicesGroup[]>;
  onSetVoice: (voice: string, lang: string) => void;
  onGetVoiceId: () => string;
  onSelectTimeout: (bookKey: string, value: number) => void;
  onSeek: (seconds: number) => Promise<void>;
  onSeekPreview: (seconds: number) => void;
  onGetPlaybackInfo: () => TTSPlaybackInfo | null;
  downloads: UseTTSDownloadsResult;
  activeSectionIndex: number | null;
};

// Full player sheet: cover, chapter, scrubber, transport, and one compact
// row of speed / voice / sleep-timer buttons that drill into in-sheet
// sub-views (dropdowns clip inside the dialog's scroll container).
const TTSPlayerSheet = ({
  bookKey,
  isOpen,
  ttsLang,
  isPlaying,
  hasTimeline,
  timeoutOption,
  timeoutTimestamp,
  chapterRemainingSec,
  onClose,
  onTogglePlay,
  onBackward,
  onForward,
  onPreviousChapter,
  onNextChapter,
  onSetRate,
  onGetVoices,
  onSetVoice,
  onGetVoiceId,
  onSelectTimeout,
  onSeek,
  onSeekPreview,
  onGetPlaybackInfo,
  downloads,
  activeSectionIndex,
}: TTSPlayerSheetProps) => {
  const _ = useTranslation();
  const router = useRouter();
  const { envConfig, appService } = useEnv();
  const { user } = useAuth();
  const { getViewSettings, setViewSettings } = useReaderStore();
  const { getBookData } = useBookDataStore();
  const progress = useBookProgress(bookKey);
  const viewSettings = getViewSettings(bookKey);

  // Offline audio (pre-downloading Read Aloud audio per chapter) is a premium
  // feature: any paid plan can use it; free / signed-out users see the row with
  // a Premium badge that routes to the upgrade page instead of the per-chapter
  // download controls. Mirrors the cloud-sync paywall in IntegrationsPanel.
  const { userProfilePlan } = useQuotaStats();
  const isDownloadPremium = isHouseholdBuild()
    ? !!user
    : isTTSCacheAllowed(userProfilePlan ?? 'free');
  // Only badge users who can't use it yet: signed out (known at once), or a
  // resolved plan without the feature. Suppress it while a signed-in user's
  // plan is still loading so it never flashes at an entitled user.
  const premiumBadge = isHouseholdBuild()
    ? undefined
    : !user || (userProfilePlan !== undefined && !isDownloadPremium)
      ? _('Premium')
      : undefined;

  // A book can carry a coverImageUrl that no longer resolves (cover never
  // extracted, file pruned). A broken <img> still occupies its h-32 box, so
  // drop it from the layout entirely rather than leaving a blank band above
  // the title.
  const [coverFailed, setCoverFailed] = useState(false);
  const [view, setView] = useState<SheetView>('main');
  const [voiceGroups, setVoiceGroups] = useState<TTSVoicesGroup[]>([]);
  const [rate, setRate] = useState(viewSettings?.ttsRate ?? 1.0);
  const [selectedVoice, setSelectedVoice] = useState('');
  const [timerLabel, setTimerLabel] = useState('');
  const availability = useNarrationAvailability(bookKey);
  const iconSize18 = useResponsiveSize(18);
  const iconSize24 = useResponsiveSize(24);
  const iconSize28 = useResponsiveSize(28);
  const iconSize32 = useResponsiveSize(32);

  const bookData = getBookData(bookKey);
  const book = bookData?.book;
  const narrator = bookData?.bookDoc?.media?.narrator?.trim();
  const sectionLabel = progress?.sectionLabel;
  const isEink = viewSettings?.isEink ?? false;
  // Household e-ink phone: the sheet sizes to its content, closes from a
  // visible Done, and names each skip in words.
  const einkPhone = isDockedMiniPlayer(isEink, appService?.isMobile);

  // Books with recorded narration expose it as a voice; while it is playing
  // there is nothing to pre-download, since the audio ships with the book.
  const hasNarrationVoice = voiceGroups.some((group) =>
    group.voices.some((voice) => voice.id === MEDIA_OVERLAY_VOICE_ID),
  );
  const isNarrating = availability.state === 'narrated' || selectedVoice === MEDIA_OVERLAY_VOICE_ID;
  const quietLine = (() => {
    switch (availability.state) {
      case 'none':
        return _('No audiobook for this book. Using a synthetic voice.');
      case 'queued':
      case 'aligning':
      case 'needs-check':
      case 'fetching-edition':
        return _('Narration isn’t ready yet. Using a synthetic voice.');
      case 'swap-ready':
        return _('Narration is ready. Tap to switch.');
      case 'failed':
        return _('Alignment failed. Using a synthetic voice.');
      case 'can-align':
        return _('Your audiobook isn’t aligned yet. Using a synthetic voice.');
      default:
        return null;
    }
  })();

  // E-ink countdowns follow sentence events too; a timer must not cause the
  // whole sheet (including the scrubber) to repaint every second.
  useEffect(() => {
    const refresh = () =>
      setTimerLabel(
        timeoutTimestamp > Date.now() ? formatCountdown(timeoutTimestamp - Date.now()) : '',
      );
    refresh();
    if (!isOpen || !timeoutTimestamp) return;
    if (isEink) {
      const handler = (event: CustomEvent<{ bookKey?: string; kind?: string }>) => {
        if (event.detail.bookKey === bookKey && event.detail.kind === 'sentence') refresh();
      };
      eventDispatcher.on('tts-position', handler);
      return () => eventDispatcher.off('tts-position', handler);
    }
    const interval = setInterval(refresh, 1000);
    return () => clearInterval(interval);
  }, [bookKey, isEink, isOpen, timeoutTimestamp]);

  // Fresh open: land on the main view with current rate/voice.
  useEffect(() => {
    if (!isOpen) return;
    setView('main');
    setRate(getViewSettings(bookKey)?.ttsRate ?? 1.0);
    setSelectedVoice(onGetVoiceId());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const fetchVoices = async () => {
      const groups = await onGetVoices(ttsLang);
      const voicesCount = groups.reduce((acc, group) => acc + group.voices.length, 0);
      if (!groups || voicesCount === 0) {
        setVoiceGroups([
          {
            id: 'no-voices',
            name: _('Voices for {{lang}}', { lang: getLanguageName(ttsLang) }),
            voices: [],
          },
        ]);
      } else {
        setVoiceGroups(groups);
      }
    };
    fetchVoices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, ttsLang]);

  const handleSelectRate = (value: number) => {
    setRate(value);
    // The pauses are derived from the rate and persisted by onSetRate's handler
    // — every entry point that changes the rate has to re-derive them, so only
    // one of them may own it (#5750).
    onSetRate(value);

    const vs = getViewSettings(bookKey)!;
    vs.ttsRate = value;
    setViewSettings(bookKey, vs);
    // Read the store fresh at call time: a `settings` captured at render goes
    // stale if anything else persisted settings since this sheet mounted.
    const { settings, setSettings, saveSettings } = useSettingsStore.getState();
    settings.globalViewSettings.ttsRate = value;
    setSettings(settings);
    saveSettings(envConfig, settings);
  };

  const handleSelectVoice = (voice: string, lang: string) => {
    onSetVoice(voice, lang);
    setSelectedVoice(voice);
    const vs = getViewSettings(bookKey)!;
    vs.ttsVoice = voice;
    // Remember per book whether the reader wants its own narrator or a
    // synthetic voice; ttsVoice alone can't say, since it inherits the global
    // default. Only written for books that offer narration at all.
    if (hasNarrationVoice) {
      vs.ttsUseNarration = voice === MEDIA_OVERLAY_VOICE_ID;
    }
    setViewSettings(bookKey, vs);
    setView('main');
  };

  const handleSelectTimeout = (value: number) => {
    onSelectTimeout(bookKey, value);
    setView('main');
  };

  // Entitled users drill into the per-chapter download view; everyone else is
  // routed to the upgrade page (or sign-in), the sheet closing first so the
  // navigation isn't hidden behind it.
  const handleOpenDownloads = () => {
    if (isHouseholdBuild() && !user) {
      eventDispatcher.dispatch('toast', {
        type: 'info',
        message: _('Pair this device with Homebase first'),
      });
    } else if (isDownloadPremium) {
      setView('chapters');
    } else if (user) {
      onClose();
      navigateToProfile(router);
    } else {
      onClose();
      navigateToLogin(router);
    }
  };

  const timeoutOptions = getTTSTimeoutOptions(_);
  // The outer skips move a chapter with narration, a paragraph otherwise.
  const skipCaption = isNarrating ? _('Chapter') : _('Paragraph');
  const currentVoiceName = voiceGroups
    .flatMap((group) => group.voices)
    .find((voice) => voice.id === selectedVoice)?.name;
  // Armed timer shows its live countdown on the button; the chapter-end mode
  // has no countdown so it just names itself; otherwise the button falls
  // back to naming the feature (the alarm icon already carries the
  // affordance).
  const timerCaption =
    timeoutOption === TTS_STOP_AT_CHAPTER_END
      ? _('End of Chapter')
      : timeoutOption > 0 && timerLabel
        ? timerLabel
        : _('Sleep Timer');

  // The main view carries no header label (the content speaks for itself and
  // vertical space is tight); sub-views keep the back button and their title.
  // Desktop hides the drag handle and has no swipe-to-dismiss, so the main
  // view floats the standard dialog close pill over its top-right corner.
  const header =
    view === 'main' && einkPhone ? (
      <div className='flex h-11 w-full items-center justify-end'>
        <button type='button' onClick={onClose} className='min-h-11 px-2 text-sm font-semibold'>
          {_('Done')}
        </button>
      </div>
    ) : view === 'main' ? (
      <button
        type='button'
        aria-label={_('Close')}
        onClick={onClose}
        className='bg-base-300/65 btn btn-ghost btn-circle absolute end-3 top-1 z-10 hidden h-6 min-h-6 w-6 focus:outline-none sm:flex'
      >
        <svg xmlns='http://www.w3.org/2000/svg' width='1em' height='1em' viewBox='0 0 24 24'>
          <path
            fill='currentColor'
            d='M19 6.41L17.59 5L12 10.59L6.41 5L5 6.41L10.59 12L5 17.59L6.41 19L12 13.41L17.59 19L19 17.59L13.41 12z'
          />
        </svg>
      </button>
    ) : (
      <div className='relative flex h-11 w-full items-center px-1'>
        <button
          type='button'
          aria-label={_('Go Back')}
          onClick={() => setView('main')}
          className='btn btn-ghost btn-circle z-10 flex h-8 min-h-8 w-8 hover:bg-transparent focus:outline-none'
        >
          <MdArrowBackIosNew size={iconSize24 * 0.8} className='rtl:rotate-180' />
        </button>
        <div className='pointer-events-none absolute inset-0 flex items-center justify-center'>
          <span className='line-clamp-1 text-center font-bold'>
            {view === 'speed'
              ? _('Speed')
              : view === 'voice'
                ? _('Select Voice')
                : view === 'chapters'
                  ? _('Offline Audio')
                  : _('Set Timeout')}
          </span>
        </div>
      </div>
    );

  return (
    <Dialog
      id='tts_player_sheet'
      isOpen={isOpen}
      snapHeight={0.65}
      title={isNarrating ? _('Listen') : _('Read Aloud')}
      header={header}
      boxClassName={clsx(
        'sm:!h-auto sm:!max-h-[85%] sm:!w-[420px] sm:!min-w-0',
        // Beats the inline snap height: no blank band under the controls.
        einkPhone && '!h-auto !max-h-[85%]',
      )}
      contentClassName='!px-4 sm:!px-4 mt-[-4px]'
      onClose={onClose}
    >
      {view === 'main' && (
        // sm:pt-4 keeps the cover clear of the box's rounded top edge on
        // desktop, where the mobile drag handle (and its clearance) is
        // hidden; on mobile the handle already provides the gap.
        <div className='flex w-full flex-col items-center gap-4 pb-4 sm:pt-4'>
          {book?.coverImageUrl && !coverFailed ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={book.coverImageUrl}
              alt=''
              className='not-eink:shadow-lg eink-bordered h-32 w-auto rounded-xl object-cover'
              onError={() => setCoverFailed(true)}
            />
          ) : null}
          <div className='flex w-full flex-col items-center gap-0.5 text-center'>
            <span className='line-clamp-1 font-semibold'>{book?.title ?? ''}</span>
            {sectionLabel && (
              <span className='text-base-content/70 line-clamp-1 text-sm'>{sectionLabel}</span>
            )}
            {isNarrating && narrator && (
              <span className='text-base-content/60 line-clamp-1 text-xs'>
                {_('Read by {{narrator}}', { narrator })}
              </span>
            )}
            {!isNarrating &&
              quietLine &&
              (availability.state === 'none' ? (
                <span className='text-base-content/60 text-xs'>{quietLine}</span>
              ) : (
                <button
                  type='button'
                  className='text-base-content/60 text-xs'
                  onClick={() => eventDispatcher.dispatch(NARRATION_STATUS_OPEN_EVENT, { bookKey })}
                >
                  {quietLine}
                </button>
              ))}
          </div>
          {hasTimeline ? (
            <TTSScrubber
              bookKey={bookKey}
              isEink={isEink}
              flatTrack={einkPhone}
              onSeek={onSeek}
              onSeekPreview={onSeekPreview}
              onGetPlaybackInfo={onGetPlaybackInfo}
            />
          ) : (
            chapterRemainingSec !== null && (
              <span className='text-base-content/70 text-xs'>
                {_('{{time}} left in chapter', { time: formatPlaybackTime(chapterRemainingSec) })}
              </span>
            )
          )}
          <div
            dir='ltr'
            className={clsx('flex items-center justify-center gap-1', einkPhone && 'pb-3')}
          >
            <button
              type='button'
              className='min-h-11 min-w-11 rounded-full p-2'
              title={isNarrating ? _('Previous Chapter') : _('Previous Paragraph')}
              aria-label={isNarrating ? _('Previous Chapter') : _('Previous Paragraph')}
              onClick={isNarrating ? onPreviousChapter : () => onBackward(false)}
            >
              <TransportGlyph caption={einkPhone ? skipCaption : undefined}>
                {isNarrating ? (
                  <MdSkipPrevious size={iconSize24} />
                ) : (
                  <MdKeyboardDoubleArrowLeft size={iconSize24} />
                )}
              </TransportGlyph>
            </button>
            <button
              type='button'
              className='min-h-11 min-w-11 rounded-full p-2'
              title={_('Previous Sentence')}
              aria-label={_('Previous Sentence')}
              onClick={() => onBackward(true)}
            >
              <TransportGlyph caption={einkPhone ? _('Sentence') : undefined}>
                <MdKeyboardArrowLeft size={iconSize28} />
              </TransportGlyph>
            </button>
            <button
              type='button'
              className='btn not-eink:btn-primary eink-bordered btn-circle mx-2 h-14 min-h-14 w-14'
              aria-label={isPlaying ? _('Pause') : _('Play')}
              onClick={onTogglePlay}
            >
              {isPlaying ? <MdOutlinePause size={iconSize32} /> : <MdPlayArrow size={iconSize32} />}
            </button>
            <button
              type='button'
              className='min-h-11 min-w-11 rounded-full p-2'
              title={_('Next Sentence')}
              aria-label={_('Next Sentence')}
              onClick={() => onForward(true)}
            >
              <TransportGlyph caption={einkPhone ? _('Sentence') : undefined}>
                <MdKeyboardArrowRight size={iconSize28} />
              </TransportGlyph>
            </button>
            <button
              type='button'
              className='min-h-11 min-w-11 rounded-full p-2'
              title={isNarrating ? _('Next Chapter') : _('Next Paragraph')}
              aria-label={isNarrating ? _('Next Chapter') : _('Next Paragraph')}
              onClick={isNarrating ? onNextChapter : () => onForward(false)}
            >
              <TransportGlyph caption={einkPhone ? skipCaption : undefined}>
                {isNarrating ? (
                  <MdSkipNext size={iconSize24} />
                ) : (
                  <MdKeyboardDoubleArrowRight size={iconSize24} />
                )}
              </TransportGlyph>
            </button>
          </div>
          <div className='flex w-full gap-2'>
            <button
              type='button'
              aria-label={_('Speed')}
              onClick={() => setView('speed')}
              className='not-eink:bg-base-200 eink-bordered flex h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-xl'
            >
              <span className='text-sm font-semibold tabular-nums'>{formatRate(rate)}</span>
              <span className='text-base-content/60 max-w-full truncate px-1 text-xs'>
                {_('Speed')}
              </span>
            </button>
            {!isNarrating && (
              <button
                type='button'
                aria-label={_('Voice')}
                onClick={() => setView('voice')}
                className='not-eink:bg-base-200 eink-bordered flex h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-xl'
              >
                <RiVoiceAiFill size={iconSize18} />
                <span className='text-base-content/60 max-w-full truncate px-1 text-xs'>
                  {currentVoiceName ? _(currentVoiceName) : _('Voice')}
                </span>
              </button>
            )}
            <button
              type='button'
              aria-label={_('Sleep Timer')}
              onClick={() => setView('timer')}
              className='not-eink:bg-base-200 eink-bordered flex h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-xl'
            >
              <MdAlarm size={iconSize18} />
              <span className='text-base-content/60 max-w-full truncate px-1 text-xs tabular-nums'>
                {timerCaption}
              </span>
            </button>
          </div>
          {!isNarrating && downloads.supported && downloads.chapters.length > 0 && (
            <button
              type='button'
              aria-label={_('Offline Audio')}
              onClick={handleOpenDownloads}
              className='not-eink:bg-base-200 eink-bordered flex w-full items-center gap-3 rounded-xl px-3 py-2.5'
            >
              <MdOutlineFileDownload size={iconSize24} className='shrink-0' />
              <div className='flex min-w-0 flex-1 flex-col items-start'>
                <span className='text-sm font-semibold'>{_('Offline Audio')}</span>
                <span className='text-base-content/60 line-clamp-1 text-start text-xs'>
                  {premiumBadge
                    ? _('Download chapters for offline playback')
                    : _('{{done}} of {{total}} downloaded', {
                        done: downloads.chapters.filter((c) => downloads.statusOf(c) === 'complete')
                          .length,
                        total: downloads.chapters.length,
                      })}
                </span>
              </div>
              {premiumBadge && (
                <span className='badge badge-sm badge-ghost shrink-0'>{premiumBadge}</span>
              )}
              <MdChevronRight size={iconSize24} className='shrink-0 rtl:rotate-180' />
            </button>
          )}
        </div>
      )}
      {view === 'chapters' && !isNarrating && (
        <TTSChaptersView
          downloads={downloads}
          activeSectionIndex={activeSectionIndex}
          isEink={isEink}
        />
      )}
      {view === 'speed' && (
        <div className='flex w-full flex-col items-center pb-4 pt-2'>
          {isNarrating ? (
            <div className='flex w-full flex-col'>
              {[0.8, 1, 1.2, 1.5, 1.75, 2].map((value) => (
                <button
                  key={value}
                  type='button'
                  aria-pressed={rate === value}
                  onClick={() => handleSelectRate(value)}
                  className='flex min-h-11 w-full items-center gap-2 rounded-lg px-2 py-2 text-start'
                >
                  <span className='flex h-6 w-6 items-center justify-center'>
                    {rate === value && <MdCheck className='text-base-content' />}
                  </span>
                  <span className='text-base sm:text-sm'>{_('{{value}}×', { value })}</span>
                </button>
              ))}
            </div>
          ) : (
            <SpeedRuler rate={rate} onSelect={handleSelectRate} />
          )}
        </div>
      )}
      {view === 'voice' && !isNarrating && (
        <div className='flex w-full flex-col pb-4'>
          {voiceGroups.map((voiceGroup) => (
            <div key={voiceGroup.id}>
              <div className='text-base-content/60 px-2 py-1 text-sm sm:text-xs'>
                {/* A single-voice group (a book's own narrator) would otherwise
                    read "Narration: 1 voices". */}
                {voiceGroup.voices.length === 1
                  ? _(voiceGroup.name)
                  : _('{{engine}}: {{count}} voices', {
                      engine: _(voiceGroup.name),
                      count: voiceGroup.voices.length,
                    })}
              </div>
              {voiceGroup.voices.map((voice) => (
                <button
                  key={`${voiceGroup.id}-${voice.id}`}
                  type='button'
                  disabled={voice.disabled}
                  onClick={() => handleSelectVoice(voice.id, voice.lang)}
                  className='flex w-full items-center gap-2 rounded-lg px-2 py-2 text-start'
                >
                  <span className='flex h-6 w-6 items-center justify-center'>
                    {selectedVoice === voice.id && <MdCheck className='text-base-content' />}
                  </span>
                  <span
                    className={clsx(
                      'overflow-hidden text-ellipsis text-base sm:text-sm',
                      voice.disabled && 'text-base-content/40',
                    )}
                  >
                    {_(voice.name)}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
      {view === 'timer' && (
        <div className='flex w-full flex-col pb-4'>
          {timeoutOptions.map((option) => (
            <button
              key={option.value}
              type='button'
              onClick={() => handleSelectTimeout(option.value)}
              className='flex w-full items-center gap-2 rounded-lg px-2 py-2 text-start'
            >
              <span className='flex h-6 w-6 items-center justify-center'>
                {timeoutOption === option.value && <MdCheck className='text-base-content' />}
              </span>
              <span className='text-base sm:text-sm'>{option.label}</span>
            </button>
          ))}
        </div>
      )}
    </Dialog>
  );
};

export default TTSPlayerSheet;
