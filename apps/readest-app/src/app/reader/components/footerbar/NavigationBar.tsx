import clsx from 'clsx';
import { isHouseholdBuild } from '@/services/household';
import React from 'react';
import { IoIosList as TOCIcon } from 'react-icons/io';
import { RxSlider as SliderIcon } from 'react-icons/rx';
import { RiFontFamily as FontIcon } from 'react-icons/ri';
import { PiSun as ColorIcon } from 'react-icons/pi';
import { MdOutlineHeadphones as TTSIcon } from 'react-icons/md';
import { LiaHeadphonesSolid } from 'react-icons/lia';
import { useBookDataStore } from '@/store/bookDataStore';
import { useEnv } from '@/context/EnvContext';
import { useReaderStore } from '@/store/readerStore';
import { useTranslation } from '@/hooks/useTranslation';
import { useSidebarStore } from '@/store/sidebarStore';
import { useResponsiveSize } from '@/hooks/useResponsiveSize';
import Button from '@/components/Button';
import {
  useNarrationAvailability,
  shouldOpenNarrationStatus,
  NARRATION_STATUS_OPEN_EVENT,
} from '@/app/reader/hooks/useNarrationAvailability';
import { eventDispatcher } from '@/utils/event';
import { Insets } from '@/types/misc';
import { TTS_PLAYER_OPEN_EVENT } from '../tts/ttsPlayerEvents';
import { ThumbBarPosition } from './ThumbBarPosition';

interface NavigationBarProps {
  bookKey: string;
  actionTab: string;
  gridInsets: Insets;
  forceMobileLayout: boolean;
  onSetActionTab: (tab: string) => void;
}

export const NavigationBar: React.FC<NavigationBarProps> = ({
  bookKey,
  actionTab,
  gridInsets,
  forceMobileLayout,
  onSetActionTab,
}) => {
  const isMobile = forceMobileLayout || window.innerWidth < 640 || window.innerHeight < 640;
  const _ = useTranslation();
  const { appService } = useEnv();
  const { getViewState, getViewSettings } = useReaderStore();
  const { getBookData } = useBookDataStore();
  const { isSideBarVisible, isSideBarPinned } = useSidebarStore();

  const availability = useNarrationAvailability(bookKey);
  const viewState = getViewState(bookKey);
  const hasNarration = !!getBookData(bookKey)?.book?.hasNarration;
  const viewSettings = getViewSettings(bookKey);
  const isBwEink = viewSettings?.isEink && !viewSettings.isColorEink;
  const tocIconSize = useResponsiveSize(23);
  const fontIconSize = useResponsiveSize(18);
  const navPadding = isMobile ? `${gridInsets.bottom * 0.33 + 16}px` : '0px';

  if (isHouseholdBuild() && (forceMobileLayout || window.innerWidth < 640)) {
    const capture = (kind: 'page-note' | 'note' | 'voice') => {
      void eventDispatcher.dispatch('reader-capture-open', { bookKey, kind });
    };
    // E-ink only: there the sheet carries Stop (and the strip docks). A colour
    // household phone keeps Listen as the stop toggle it has always been.
    const listening = !!viewSettings?.isEink && !!viewState?.ttsEnabled;
    const listen = () => {
      // While narration runs, Listen is the way back to the player, not a stop.
      if (listening) {
        useReaderStore.getState().setHoveredBookKey('');
        void eventDispatcher.dispatch(TTS_PLAYER_OPEN_EVENT, { bookKey });
        return;
      }
      if (!viewState?.ttsEnabled && shouldOpenNarrationStatus(bookKey, availability)) {
        void eventDispatcher.dispatch(NARRATION_STATUS_OPEN_EVENT, { bookKey });
        return;
      }
      onSetActionTab('tts');
    };
    return (
      <nav
        aria-label={_('Reading actions')}
        className='bg-base-100 text-base-content w-full font-sans'
      >
        <ThumbBarPosition bookKey={bookKey} />
        <div className='grid grid-cols-4 gap-2 px-4 pb-2 pt-3'>
          <button
            type='button'
            className='border-base-content min-h-[50px] border text-xs font-medium'
            onClick={() => capture('page-note')}
          >
            {_('Page note')}
          </button>
          <button
            type='button'
            className='border-base-content min-h-[50px] border text-xs font-medium'
            onClick={() => capture('note')}
          >
            {_('Note')}
          </button>
          <button
            type='button'
            className='border-base-content min-h-[50px] border text-xs font-medium'
            onClick={() => capture('voice')}
          >
            {_('Voice')}
          </button>
          <button
            type='button'
            className={clsx(
              'border-base-content min-h-[50px] border text-xs',
              listening ? 'font-semibold' : 'font-medium',
            )}
            onClick={listen}
          >
            {listening ? _('Listening') : _('Listen')}
          </button>
        </div>
        <div
          className='border-base-content divide-base-content grid grid-cols-4 divide-x border-t text-xs font-medium rtl:divide-x-reverse'
          style={{
            paddingBottom: appService?.isAndroidApp
              ? 'env(safe-area-inset-bottom)'
              : `${gridInsets.bottom * 0.33}px`,
          }}
        >
          <button
            type='button'
            className='min-h-11'
            onClick={() => void eventDispatcher.dispatch('reader-library-open', { bookKey })}
          >
            {_('‹ Library')}
          </button>
          <button type='button' className='min-h-11' onClick={() => onSetActionTab('toc')}>
            {_('Contents')}
          </button>
          <button
            type='button'
            className='min-h-11'
            onClick={() => {
              useReaderStore.getState().setHoveredBookKey('');
              void eventDispatcher.dispatch('search-term', { bookKey });
            }}
          >
            {_('Search')}
          </button>
          <button type='button' className='min-h-11' onClick={() => onSetActionTab('font')}>
            {_('Aa')}
          </button>
        </div>
      </nav>
    );
  }

  return (
    <div
      className={clsx(
        'not-eink:bg-base-200 eink:bg-base-100 z-30 mt-auto flex w-full justify-between px-8 py-4',
        'eink:border-base-content eink:border-t',
        !forceMobileLayout && 'sm:hidden',
      )}
      style={{
        paddingBottom: appService?.isAndroidApp
          ? `calc(env(safe-area-inset-bottom) + 16px)`
          : navPadding,
      }}
    >
      {isSideBarVisible && isSideBarPinned ? null : (
        <Button
          label={_('Table of Contents')}
          icon={<TOCIcon size={tocIconSize} />}
          onClick={() => onSetActionTab('toc')}
        />
      )}
      <Button
        label={_('Color')}
        icon={<ColorIcon className={clsx(actionTab === 'color' && 'text-blue-500')} />}
        onClick={() => onSetActionTab('color')}
      />
      <Button
        label={_('Reading Progress')}
        icon={<SliderIcon className={clsx(actionTab === 'progress' && 'text-blue-500')} />}
        onClick={() => onSetActionTab('progress')}
      />
      <Button
        label={_('Font & Layout')}
        icon={
          <FontIcon size={fontIconSize} className={clsx(actionTab === 'font' && 'text-blue-500')} />
        }
        onClick={() => onSetActionTab('font')}
      />
      <Button
        label={hasNarration ? _('Listen') : _('Speak')}
        icon={
          hasNarration ? (
            <span
              className={clsx(
                isBwEink && viewState?.ttsEnabled && 'eink-inverted rounded-full p-1',
              )}
            >
              <LiaHeadphonesSolid />
            </span>
          ) : (
            <TTSIcon className={viewState?.ttsEnabled ? 'text-blue-500' : ''} />
          )
        }
        onClick={() => {
          if (!viewState?.ttsEnabled && shouldOpenNarrationStatus(bookKey, availability)) {
            void eventDispatcher.dispatch(NARRATION_STATUS_OPEN_EVENT, { bookKey });
            return;
          }
          onSetActionTab('tts');
        }}
      />
    </div>
  );
};
