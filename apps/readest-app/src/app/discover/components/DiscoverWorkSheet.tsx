import clsx from 'clsx';
import React, { useEffect, useId, useRef, useState } from 'react';
import { IoCheckmarkCircle, IoClose, IoPauseCircleOutline } from 'react-icons/io5';
import { useTranslation, type TranslationFunc } from '@/hooks/useTranslation';
import { discoverClient, type DiscoverFailure } from '@/services/discover/client';
import { loadWork, saveWork } from '@/services/discover/cache';
import { requestDedupeKey, submitRequest } from '@/services/discover/requestQueue';
import {
  DISCOVER_TERMINAL_STAGES,
  type DiscoverAcquisitionStatus,
  type DiscoverJob,
  type DiscoverKind,
  type DiscoverOffer,
  type DiscoverProviderId,
  type DiscoverQueuedRequest,
  type DiscoverWant,
  type DiscoverWork,
} from '@/services/discover/types';
import { DiscoverCover } from './DiscoverWorkCard';
import { kindLabel, stageLabel } from './DiscoverJobsStrip';

const PROVIDER_LABELS: Record<DiscoverProviderId, string> = {
  prowlarr: 'Prowlarr',
  libgen: 'LibGen',
  abb: 'AudioBook Bay',
  librivox: 'LibriVox',
  mam: 'MyAnonamouse',
  annas: "Anna's Archive",
};

const formatSize = (bytes: number | null): string | null => {
  if (!bytes || bytes <= 0) return null;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
};

const formatDuration = (seconds: number | null): string | null => {
  if (!seconds || seconds <= 0) return null;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return hours > 0 ? `${hours} h ${minutes} min` : `${minutes} min`;
};

const offerSummary = (offer: DiscoverOffer): string =>
  [
    offer.format?.toUpperCase(),
    formatDuration(offer.durationSeconds),
    formatSize(offer.sizeBytes),
    PROVIDER_LABELS[offer.provider],
  ]
    .filter(Boolean)
    .join(' · ');

const failureMessage = (_: TranslationFunc, failure: DiscoverFailure): string => {
  switch (failure) {
    case 'forbidden':
      return _('Discover works on the home tailnet. Connect to Tailscale and try again.');
    case 'unavailable':
      return _('Homebase is busy right now. Try again in a moment.');
    case 'offline':
      return _('Homebase is out of reach. Try again when you are back online.');
    default:
      return _('That did not go through. Try again.');
  }
};

type Lookup = 'idle' | 'loading' | 'done' | 'failed';

interface KindState {
  kind: DiscoverKind;
  owned: boolean;
  job: DiscoverJob | null;
  queued: boolean;
  /** null until offers have been looked up. */
  offers: DiscoverOffer[] | null;
}

interface DiscoverWorkSheetProps {
  work: DiscoverWork;
  online: boolean;
  acquisition: DiscoverAcquisitionStatus | null;
  jobs: DiscoverJob[];
  queued: DiscoverQueuedRequest[];
  onClose: () => void;
  onJobs: (jobs: DiscoverJob[]) => void;
  onAcquisition: (acquisition: DiscoverAcquisitionStatus) => void;
}

const DiscoverWorkSheet: React.FC<DiscoverWorkSheetProps> = ({
  work,
  online,
  acquisition,
  jobs,
  queued,
  onClose,
  onJobs,
  onAcquisition,
}) => {
  const _ = useTranslation();
  const titleId = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [detail, setDetail] = useState<DiscoverWork>(() => {
    if (work.offersChecked) return work;
    const cached = loadWork(work.key)?.data.work;
    // Offers from the cache, ownership from the fresher shelf.
    return cached ? { ...cached, owned: work.owned } : work;
  });
  const [lookup, setLookup] = useState<Lookup>(work.offersChecked ? 'done' : 'idle');
  const [sending, setSending] = useState<DiscoverWant | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    titleRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (work.offersChecked || !online) return;
    let cancelled = false;
    setLookup('loading');
    void discoverClient.work({ title: work.title, author: work.authors[0] }).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setLookup('failed');
        return;
      }
      saveWork(work.key, result.data);
      setDetail(result.data.work);
      onAcquisition(result.data.acquisition);
      setLookup('done');
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [work.key, online]);

  const author = detail.authors[0] ?? work.authors[0] ?? '';
  const queuedKeys = new Set(queued.map((entry) => requestDedupeKey(entry.body)));
  const isQueued = (want: DiscoverWant) =>
    queuedKeys.has(requestDedupeKey({ title: detail.title, author, want }));

  const kindState = (kind: DiscoverKind): KindState => ({
    kind,
    owned: !!(kind === 'ebook' ? detail.owned?.ebook : detail.owned?.audiobook),
    job:
      jobs.find(
        (job) =>
          job.workKey === detail.key &&
          job.kind === kind &&
          !DISCOVER_TERMINAL_STAGES.includes(job.stage),
      ) ?? null,
    queued: isQueued(kind) || isQueued('pair'),
    offers: detail.offersChecked ? (kind === 'ebook' ? detail.ebooks : detail.audiobooks) : null,
  });
  const ebook = kindState('ebook');
  const audiobook = kindState('audiobook');
  const vpnDown = acquisition?.state === 'vpn_down';

  const blocked = (state: KindState) =>
    sending !== null ||
    !!state.job ||
    state.queued ||
    (online && state.offers !== null && state.offers.length === 0);

  const statusLine = (state: KindState): string => {
    if (state.owned) return _('On your shelf');
    if (state.job) return stageLabel(_, state.job);
    if (state.queued) return _('Waiting to send');
    if (state.offers === null) {
      return lookup === 'loading' ? _('Checking sources') : _('Sources not checked yet');
    }
    if (state.offers.length === 0) return _('None found right now');
    return offerSummary(state.offers[0]!);
  };

  const get = async (want: DiscoverWant) => {
    setSending(want);
    setMessage(null);
    const result = await submitRequest(
      { title: detail.title, author: author || _('Unknown'), want },
      { holdForVpn: vpnDown },
    );
    setSending(null);
    if (result.outcome === 'sent') {
      onJobs(result.jobs);
      setMessage(_('Requested. Follow it under Getting.'));
    } else if (result.outcome === 'queued') {
      setMessage(
        vpnDown
          ? _('Saved. It sends when the VPN lane is back.')
          : _('Saved. It sends when Homebase is back.'),
      );
    } else {
      setMessage(failureMessage(_, result.failure));
    }
  };

  const getLabel = (kind: DiscoverKind) => (kind === 'ebook' ? _('Get ebook') : _('Get audiobook'));
  const bothOwned = ebook.owned && audiobook.owned;
  const showPair = !ebook.owned && !audiobook.owned;
  const pairBlocked = blocked(ebook) || blocked(audiobook) || isQueued('pair');

  const kindRow = (state: KindState) => (
    <li
      key={state.kind}
      className='flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3'
      data-testid={`discover-kind-${state.kind}`}
    >
      <div className='flex min-w-0 flex-1 basis-40 flex-col gap-0.5'>
        <span className='text-sm font-semibold leading-snug'>{kindLabel(_, state.kind)}</span>
        <span className='text-base-content/70 text-xs tabular-nums leading-snug [overflow-wrap:anywhere]'>
          {statusLine(state)}
        </span>
      </div>
      {state.owned ? (
        <span className='inline-flex h-11 items-center gap-1.5 text-sm font-semibold'>
          <IoCheckmarkCircle aria-hidden size={18} />
          {_('On your shelf')}
        </span>
      ) : (
        <button
          type='button'
          disabled={blocked(state)}
          onClick={() => void get(state.kind)}
          className='border-base-content/25 eink:border-base-content h-11 shrink-0 rounded-full border px-5 text-sm font-semibold disabled:opacity-50'
        >
          {sending === state.kind ? _('Sending') : getLabel(state.kind)}
        </button>
      )}
    </li>
  );

  return (
    <div className='fixed inset-0 z-50 flex items-end justify-center md:items-center md:p-6'>
      <button
        type='button'
        tabIndex={-1}
        aria-label={_('Close')}
        onClick={onClose}
        className='not-eink:bg-black/40 absolute inset-0 cursor-default'
      />
      <div
        role='dialog'
        aria-modal='true'
        aria-labelledby={titleId}
        className='bg-base-100 border-base-content/10 eink:border-base-content relative flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-2xl border shadow-xl md:max-w-2xl md:rounded-2xl'
      >
        <div className='flex shrink-0 justify-end px-2 pt-2'>
          <button
            type='button'
            aria-label={_('Close')}
            onClick={onClose}
            className='flex h-11 w-11 items-center justify-center rounded-full'
          >
            <IoClose aria-hidden size={22} />
          </button>
        </div>
        <div
          className='flex flex-col gap-6 overflow-y-auto px-5 sm:px-7'
          style={{ paddingBottom: 'max(24px, env(safe-area-inset-bottom))' }}
        >
          <div className='grid grid-cols-[96px_minmax(0,1fr)] items-start gap-4 sm:grid-cols-[140px_minmax(0,1fr)] sm:gap-6'>
            <DiscoverCover work={detail} />
            <div className='flex min-w-0 flex-col gap-1.5'>
              {detail.series && (
                <p className='text-base-content/70 text-xs font-medium leading-snug'>
                  {detail.series.index !== null
                    ? _('Book {{index}} of {{series}}', {
                        index: detail.series.index,
                        series: detail.series.name,
                      })
                    : detail.series.name}
                </p>
              )}
              <h2
                id={titleId}
                ref={titleRef}
                tabIndex={-1}
                className='text-xl font-bold leading-tight outline-none [text-wrap:balance] sm:text-2xl'
              >
                {detail.title}
              </h2>
              {detail.authors.length > 0 && (
                <p className='text-sm font-medium leading-snug'>{detail.authors.join(', ')}</p>
              )}
              {detail.year && (
                <p className='text-base-content/70 text-sm leading-snug'>
                  {_('Published {{year}}', { year: detail.year })}
                </p>
              )}
            </div>
          </div>

          {vpnDown && !bothOwned && (
            <div
              role='note'
              className='border-base-content/15 eink:border-base-content bg-base-200/60 eink:bg-base-100 flex items-start gap-3 rounded-xl border px-4 py-3'
            >
              <IoPauseCircleOutline aria-hidden size={20} className='mt-0.5 shrink-0' />
              <p className='text-sm font-medium leading-snug'>
                {_('Downloads paused: the VPN lane is down. Your request will wait.')}
              </p>
            </div>
          )}

          <div className='flex flex-col gap-3'>
            <ul className='divide-base-content/10 eink:divide-base-content flex flex-col divide-y'>
              {kindRow(ebook)}
              {kindRow(audiobook)}
            </ul>
            {showPair && (
              <button
                type='button'
                disabled={pairBlocked || sending !== null}
                onClick={() => void get('pair')}
                className={clsx(
                  'bg-primary text-primary-content h-12 w-full rounded-full px-5 text-base font-semibold disabled:opacity-50',
                  'eink:bg-base-content eink:text-base-100',
                )}
              >
                {sending === 'pair' ? _('Sending') : _('Get both (paired)')}
              </button>
            )}
            {bothOwned && (
              <p className='text-base-content/70 text-sm leading-snug'>
                {_('Both the ebook and the audiobook are on your shelf.')}
              </p>
            )}
            <p role='status' className='min-h-5 text-sm font-medium leading-snug'>
              {message ?? ''}
            </p>
          </div>

          {detail.description && (
            <div className='flex flex-col gap-1.5'>
              <h3 className='text-sm font-semibold'>{_('About')}</h3>
              <p className='text-base-content/80 line-clamp-[8] whitespace-pre-line text-sm leading-relaxed'>
                {detail.description}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default DiscoverWorkSheet;
