import clsx from 'clsx';
import React, { useEffect, useRef, useState } from 'react';
import { useThemeStore } from '@/store/themeStore';
import { useReaderStore } from '@/store/readerStore';
import { useTranslation } from '@/hooks/useTranslation';
import { useTTSControl } from '@/app/reader/hooks/useTTSControl';
import { useTTSDownloads } from '@/app/reader/hooks/useTTSDownloads';
import { useBookProgress } from '@/store/readerProgressStore';
import { Insets } from '@/types/misc';
import { eventDispatcher } from '@/utils/event';
import { useEnv } from '@/context/EnvContext';
import { isDockedMiniPlayer } from '../../utils/ttsMiniPlayerPosition';
import TTSMiniPlayer from './TTSMiniPlayer';
import TTSPlayerSheet from './TTSPlayerSheet';
import NarrationStatusSheet from './NarrationStatusSheet';
import { useMiniPlayerAutoHide } from './useMiniPlayerAutoHide';
import { TTS_PLAYER_OPEN_EVENT } from './ttsPlayerEvents';

interface TTSControlProps {
  bookKey: string;
  gridInsets: Insets;
}

const TTSControl: React.FC<TTSControlProps> = ({ bookKey, gridInsets }) => {
  const _ = useTranslation();
  const { appService } = useEnv();
  const { safeAreaInsets } = useThemeStore();
  const { getViewSettings } = useReaderStore();

  const [showPlayerSheet, setShowPlayerSheet] = useState(false);
  const backButtonTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [shouldMountBackButton, setShouldMountBackButton] = useState(false);
  const [isBackButtonVisible, setIsBackButtonVisible] = useState(false);

  const tts = useTTSControl({
    bookKey,
    onRequestHidePanel: () => setShowPlayerSheet(false),
  });

  const downloads = useTTSDownloads(bookKey, tts.getController, showPlayerSheet);
  const activeSectionIndex = useBookProgress(bookKey)?.index ?? null;

  const viewSettings = getViewSettings(bookKey);
  const isEink = viewSettings?.isEink ?? false;
  const playerStyle = viewSettings?.ttsPlayerStyle ?? 'full';
  const hasTimeline = tts.ttsClientsInited && tts.handleSupportsPlaybackInfo();
  const miniPlayerMounted = tts.showIndicator && !showPlayerSheet;
  const docked = isDockedMiniPlayer(isEink, appService?.isMobile);
  const miniPlayerVisible = useMiniPlayerAutoHide(bookKey, playerStyle, miniPlayerMounted, docked);

  useEffect(() => {
    if (tts.showBackToCurrentTTSLocation) {
      setShouldMountBackButton(true);
      const fadeInTimeout = setTimeout(() => {
        setIsBackButtonVisible(true);
      }, 10);
      return () => clearTimeout(fadeInTimeout);
    } else {
      setIsBackButtonVisible(false);
      if (backButtonTimeoutRef.current) {
        clearTimeout(backButtonTimeoutRef.current);
      }
      backButtonTimeoutRef.current = setTimeout(() => {
        setShouldMountBackButton(false);
      }, 300);
      return;
    }
  }, [tts.showBackToCurrentTTSLocation]);

  const handleExpand = () => {
    // The mini player mounts as soon as the session starts; the full sheet
    // needs initialized clients (voices, timeline), so ignore taps until then.
    if (!tts.ttsClientsInited) return;
    tts.refreshTtsLang();
    setShowPlayerSheet(true);
  };

  const expandRef = useRef(handleExpand);
  expandRef.current = handleExpand;
  useEffect(() => {
    const open = (event: CustomEvent) => {
      if (event.detail?.bookKey === bookKey) expandRef.current();
    };
    eventDispatcher.on(TTS_PLAYER_OPEN_EVENT, open);
    return () => eventDispatcher.off(TTS_PLAYER_OPEN_EVENT, open);
  }, [bookKey]);

  const handleStop = () => {
    eventDispatcher.dispatch('tts-stop', { bookKey });
  };

  return (
    <>
      <NarrationStatusSheet bookKey={bookKey} onSyntheticStart={() => setShowPlayerSheet(true)} />
      {shouldMountBackButton && (
        <div
          className={clsx(
            'absolute left-1/2 top-0 z-50 -translate-x-1/2',
            'transition-opacity duration-300',
            isBackButtonVisible ? 'opacity-100' : 'opacity-0',
            safeAreaInsets?.top ? '' : 'py-1',
          )}
          style={{
            top: `${safeAreaInsets?.top || 0}px`,
          }}
        >
          <button
            onClick={tts.handleBackToCurrentTTSLocation}
            className={clsx(
              'not-eink:bg-base-300 eink-bordered whitespace-nowrap rounded-full px-4 py-2 font-sans text-sm shadow-lg',
              safeAreaInsets?.top ? 'h-11' : 'h-9',
            )}
          >
            {_('Back to Read Aloud')}
          </button>
        </div>
      )}
      {/* One surface at a time: the sheet replaces the mini player while open.
          Mounts on showIndicator alone so the card appears the moment the
          session starts, before the TTS clients finish initializing. */}
      {miniPlayerMounted && (
        <TTSMiniPlayer
          bookKey={bookKey}
          isPlaying={tts.isPlaying}
          isEink={isEink}
          visible={miniPlayerVisible}
          hasTimeline={hasTimeline}
          timeoutTimestamp={tts.timeoutTimestamp}
          chapterRemainingSec={tts.chapterRemainingSec}
          gridInsets={gridInsets}
          onTogglePlay={tts.handleTogglePlay}
          onBackward={tts.handleBackward}
          onForward={tts.handleForward}
          onStop={handleStop}
          onExpand={handleExpand}
          onGetPlaybackInfo={tts.handleGetPlaybackInfo}
        />
      )}
      {tts.ttsClientsInited && showPlayerSheet && (
        <TTSPlayerSheet
          bookKey={bookKey}
          isOpen={showPlayerSheet}
          ttsLang={tts.ttsLang}
          isPlaying={tts.isPlaying}
          hasTimeline={hasTimeline}
          timeoutOption={tts.timeoutOption}
          timeoutTimestamp={tts.timeoutTimestamp}
          chapterRemainingSec={tts.chapterRemainingSec}
          onClose={() => setShowPlayerSheet(false)}
          onStop={handleStop}
          onTogglePlay={tts.handleTogglePlay}
          onBackward={tts.handleBackward}
          onForward={tts.handleForward}
          onSetRate={tts.handleSetRate}
          onGetVoices={tts.handleGetVoices}
          onSetVoice={tts.handleSetVoice}
          onGetVoiceId={tts.handleGetVoiceId}
          onSelectTimeout={tts.handleSelectTimeout}
          onPreviousChapter={tts.handlePreviousChapter}
          onNextChapter={tts.handleNextChapter}
          onSeek={tts.handleSeekTo}
          onSeekPreview={tts.handleSeekPreview}
          onGetPlaybackInfo={tts.handleGetPlaybackInfo}
          downloads={downloads}
          activeSectionIndex={activeSectionIndex}
        />
      )}
    </>
  );
};

export default TTSControl;
