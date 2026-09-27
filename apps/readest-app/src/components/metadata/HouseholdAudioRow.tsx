import React, { useEffect, useState } from 'react';
import { IoHeadsetOutline, IoCheckmarkCircleOutline } from 'react-icons/io5';
import { useTranslation } from '@/hooks/useTranslation';
import { discoverClient, isDeviceOnline } from '@/services/discover/client';
import {
  flushQueue,
  loadQueue,
  requestDedupeKey,
  submitRequest,
  subscribeQueue,
} from '@/services/discover/requestQueue';
import {
  DISCOVER_TERMINAL_STAGES,
  type DiscoverJob,
  type DiscoverWant,
  type DiscoverWork,
} from '@/services/discover/types';
import type { Book } from '@/types/book';

/** A small discovery affordance; listening itself belongs to the reader's audio controls. */
const HouseholdAudioRow: React.FC<{ book: Book }> = ({ book }) => {
  const _ = useTranslation();
  const title = book.title.trim();
  const author = book.author.trim() || 'Unknown';
  const [online, setOnline] = useState(isDeviceOnline);
  const [work, setWork] = useState<DiscoverWork | null>(null);
  const [jobs, setJobs] = useState<DiscoverJob[]>([]);
  const [queue, setQueue] = useState(loadQueue);
  const [sending, setSending] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setWork(null);
    setJobs([]);
    setMessage(null);
    setSubmitted(false);
    const refresh = async () => {
      if (!isDeviceOnline()) {
        setOnline(false);
        return;
      }
      const [detail, active] = await Promise.all([
        discoverClient.work({ title, author }),
        discoverClient.jobs(),
      ]);
      if (!current) return;
      setOnline(detail.ok || detail.failure !== 'offline');
      if (detail.ok) setWork(detail.data.work);
      if (active.ok) setJobs(active.data.jobs);
    };
    const flushAndRefresh = async () => {
      await flushQueue();
      if (current) await refresh();
    };
    const hasQueuedAudio = loadQueue().some(
      (entry) =>
        (entry.body.want === 'audiobook' || entry.body.want === 'pair') &&
        requestDedupeKey(entry.body) === requestDedupeKey({ title, author, want: entry.body.want }),
    );
    if (isDeviceOnline() && hasQueuedAudio) void flushAndRefresh();
    else void refresh();
    const onOnline = () => {
      setOnline(true);
      void flushAndRefresh();
    };
    const onOffline = () => setOnline(false);
    const unsubscribe = subscribeQueue(() => setQueue(loadQueue()));
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      current = false;
      unsubscribe();
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [title, author]);

  const queued = queue.some((entry) => {
    const sameBook =
      requestDedupeKey(entry.body) === requestDedupeKey({ title, author, want: entry.body.want });
    return sameBook && (entry.body.want === 'audiobook' || entry.body.want === 'pair');
  });
  const job = jobs.find(
    (item) =>
      item.kind === 'audiobook' &&
      !DISCOVER_TERMINAL_STAGES.includes(item.stage) &&
      (work
        ? item.workKey === work.key
        : requestDedupeKey({ title: item.title, author: item.author, want: 'audiobook' }) ===
          requestDedupeKey({ title, author, want: 'audiobook' })),
  );
  const owned = !!work?.owned.audiobook;
  const hasOffers = !!work?.audiobooks.length;
  const requested = !owned && (queued || !!job || submitted);

  const request = async (want: DiscoverWant) => {
    if (sending) return;
    setSending(true);
    setMessage(null);
    // The client bounds its network request to 10s and queues transport failures.
    try {
      const result = await submitRequest({ title, author, want });
      if (result.outcome === 'sent') {
        setJobs((previous) => [...result.jobs, ...previous]);
        setSubmitted(true);
      } else if (result.outcome === 'queued') {
        setQueue(loadQueue());
      } else {
        setMessage(_('That did not go through. Try again.'));
      }
    } finally {
      setSending(false);
    }
  };

  const status = owned
    ? _('Audiobook on your shelf')
    : requested
      ? `${_('Requested')} · ${job ? _(job.stage) : submitted ? _('Queued') : _('Waiting to send')}`
      : !online
        ? _('Offline. Requests wait and send when you’re back.')
        : hasOffers
          ? _('Audiobook available')
          : _('No audiobook found yet');

  return (
    <section
      aria-label={_('Audio')}
      className='border-base-content/10 eink:border-base-content mx-4 my-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3'
    >
      <div className='flex min-w-0 flex-1 items-center gap-3'>
        {owned ? (
          <IoCheckmarkCircleOutline aria-hidden className='h-5 w-5 shrink-0' />
        ) : (
          <IoHeadsetOutline aria-hidden className='h-5 w-5 shrink-0' />
        )}
        <span className='min-w-0 text-sm font-medium leading-snug'>{status}</span>
      </div>
      {!owned && !requested && (
        <div className='flex flex-wrap gap-2'>
          <button
            type='button'
            disabled={sending}
            onClick={() => void request('audiobook')}
            className={`h-11 min-h-11 rounded-full px-4 text-sm font-semibold disabled:opacity-50 ${online && hasOffers ? 'bg-primary text-primary-content eink:bg-base-content eink:text-base-100' : 'border border-base-content/25 eink:border-base-content'}`}
          >
            {online && hasOffers ? _('Request audiobook') : _('Request anyway')}
          </button>
          {online && hasOffers && !work?.owned.ebook && (
            <button
              type='button'
              disabled={sending}
              onClick={() => void request('pair')}
              className='border-base-content/25 eink:border-base-content h-11 min-h-11 rounded-full border px-4 text-sm font-semibold disabled:opacity-50'
            >
              {_('Request both')}
            </button>
          )}
        </div>
      )}
      {message && !requested && (
        <p role='status' className='w-full text-sm'>
          {message}
        </p>
      )}
    </section>
  );
};

export default HouseholdAudioRow;
