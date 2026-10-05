import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Dialog from '@/components/Dialog';
import { useTranslation } from '@/hooks/useTranslation';
import { useBookDataStore } from '@/store/bookDataStore';
import { useReaderStore } from '@/store/readerStore';
import { useImmersionStore } from '@/store/immersionStore';
import { createImmersionClient } from '@/services/homebase/immersion/client';
import { submitRequest } from '@/services/discover/requestQueue';
import { eventDispatcher } from '@/utils/event';
import {
  useNarrationAvailability,
  narrationStageLine,
  markSyntheticChosen,
  markNarrationQueued,
  NARRATION_STATUS_OPEN_EVENT,
  type NarrationAvailability,
} from '@/app/reader/hooks/useNarrationAvailability';

const copy: Record<string, [string, string, string?]> = {
  queued: [
    'Waiting to align',
    'Your audiobook is queued on Homebase. Narration appears here when it’s ready.',
  ],
  aligning: ['Aligning the audiobook', ''],
  'needs-check': [
    'Check the match',
    'Homebase found an audiobook that may fit. Confirm it in Requests.',
    'Open Requests',
  ],
  'swap-ready': [
    'Narration is ready',
    'Switch this book to the narrated edition to listen.',
    'Use narrated edition',
  ],
  'fetching-edition': [
    'Getting the narrated edition',
    'Reopen the book when the download finishes.',
  ],
  failed: ['Alignment failed', 'Homebase couldn’t match the audiobook to this text.', 'Try again'],
  'can-align': [
    'You have the audiobook',
    'Align it with this book to hear the narrator as you read.',
    'Align audiobook',
  ],
};

const NarrationStatusSheet: React.FC<{ bookKey: string; onSyntheticStart?: () => void }> = ({
  bookKey,
  onSyntheticStart,
}) => {
  const _ = useTranslation();
  const router = useRouter();
  const availability = useNarrationAvailability(bookKey);
  const data = useBookDataStore((s) => s.booksData[bookKey.split('-')[0]!]);
  const settings = useReaderStore((s) => s.getViewSettings(bookKey));
  const [isOpen, setOpen] = useState(false);
  const [local, setLocal] = useState<NarrationAvailability | null>(null);
  const [detailOverride, setDetailOverride] = useState('');
  const [sending, setSending] = useState(false);
  const bwEink = !!settings?.isEink && !settings.isColorEink;
  const close = () => {
    setOpen(false);
    void eventDispatcher.dispatch('narration-status-visibility', { bookKey, open: false });
  };
  useEffect(() => {
    const open = (event: CustomEvent<{ bookKey: string }>) => {
      if (event.detail?.bookKey === bookKey) setOpen(true);
    };
    eventDispatcher.on(NARRATION_STATUS_OPEN_EVENT, open);
    return () => {
      eventDispatcher.off(NARRATION_STATUS_OPEN_EVENT, open);
      void eventDispatcher.dispatch('narration-status-visibility', { bookKey, open: false });
    };
  }, [bookKey]);
  useEffect(() => {
    if (
      availability.state !== 'can-align' &&
      availability.state !== 'none' &&
      availability.state !== 'unknown' &&
      availability.state !== 'queued'
    ) {
      setLocal(null);
      setDetailOverride('');
    }
  }, [availability.state]);
  const state = availability.state === 'narrated' ? availability : (local ?? availability);
  const row = copy[state.state];
  const detail =
    detailOverride ||
    (state.state === 'aligning'
      ? narrationStageLine(_, state, bwEink)
      : state.state === 'failed' && state.error
        ? state.error
        : _(row?.[1] ?? ''));
  const primary = async () => {
    if (state.state === 'needs-check') {
      close();
      useImmersionStore.getState().openSheet('requests');
      router.push('/library');
      return;
    }
    setSending(true);
    setDetailOverride('');
    try {
      if (state.state === 'can-align' && data?.book) {
        const result = await submitRequest({
          title: data.book.title,
          author: data.book.author,
          want: 'pair',
        });
        if (result.outcome === 'failed')
          setDetailOverride(_('That did not go through. Try again.'));
        else {
          markNarrationQueued(data.book.hash);
          setLocal({ state: 'queued' });
          if (result.outcome === 'queued')
            setDetailOverride(_('Offline. Requests wait and send when you’re back.'));
        }
      } else {
        const api = createImmersionClient();
        if (!api || !state.pairId || !data?.book) throw new Error('Unavailable');
        const pair =
          state.state === 'swap-ready'
            ? await api.confirmPair(state.pairId)
            : await api.realignPair(state.pairId);
        useImmersionStore
          .getState()
          .setPairs({ ...useImmersionStore.getState().pairByHash, [data.book.hash]: pair });
        setLocal({
          state: state.state === 'swap-ready' ? 'fetching-edition' : 'queued',
          pairId: state.pairId,
        });
      }
    } catch {
      setDetailOverride(_('That did not go through. Try again.'));
    } finally {
      setSending(false);
    }
  };
  return (
    <Dialog isOpen={isOpen} onClose={close} title={_('Listen')} snapHeight={0.45}>
      <div className='flex flex-col gap-4 px-6 pb-6 text-start'>
        <div>
          <p className='font-semibold'>{data?.book?.title}</p>
          <p className='text-sm opacity-70'>{data?.book?.author}</p>
        </div>
        {row && (
          <div>
            <p className='font-semibold'>{_(row[0])}</p>
            <p className='line-clamp-2 text-sm opacity-70'>{detail}</p>
          </div>
        )}
        {row?.[2] &&
          (!(state.state === 'swap-ready' || state.state === 'failed') || state.pairId) && (
            <button
              className='eink-bordered border-base-content/30 h-12 w-full rounded-xl border font-semibold'
              disabled={sending}
              onClick={primary}
            >
              {_(row[2])}
            </button>
          )}
        <button
          className='text-sm opacity-70'
          onClick={() => {
            markSyntheticChosen(bookKey);
            close();
            void eventDispatcher.dispatch('tts-speak', { bookKey });
            onSyntheticStart?.();
          }}
        >
          {_('Listen with a synthetic voice for now')}
        </button>
      </div>
    </Dialog>
  );
};
export default NarrationStatusSheet;
