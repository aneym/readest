import React from 'react';
import { IoCloudOfflineOutline, IoLockClosedOutline, IoRefresh } from 'react-icons/io5';
import { useTranslation, type TranslationFunc } from '@/hooks/useTranslation';
import type { CachedBrowse } from '@/services/discover/cache';
import type { DiscoverRejectReason } from '@/services/discover/client';
import type { RejectedRequest } from '@/services/discover/requestQueue';
import type { DiscoverQueuedRequest, DiscoverWant, DiscoverWork } from '@/services/discover/types';
import DiscoverShelf from './DiscoverShelf';

export const wantLabel = (_: TranslationFunc, want: DiscoverWant) =>
  want === 'ebook' ? _('Ebook') : want === 'audiobook' ? _('Audiobook') : _('Ebook and audiobook');

/** "just now", "5 minutes ago", "yesterday", in the reader's locale. */
export const formatSavedAgo = (savedAt: number, now: number, locale?: string): string => {
  const seconds = Math.round((savedAt - now) / 1000);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const abs = Math.abs(seconds);
  if (abs < 60) return format.format(0, 'second');
  if (abs < 3600) return format.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return format.format(Math.round(seconds / 3600), 'hour');
  return format.format(Math.round(seconds / 86_400), 'day');
};

const panelClass =
  'border-base-content/10 eink:border-base-content bg-base-200/60 eink:bg-base-100 flex flex-col items-start gap-4 rounded-2xl border px-5 py-6 sm:px-7 sm:py-8';

const outlineButton =
  'border-base-content/25 eink:border-base-content inline-flex h-11 items-center justify-center gap-2 rounded-full border px-5 text-sm font-semibold';

export const WaitingToSendList: React.FC<{
  queued: DiscoverQueuedRequest[];
  note?: string;
}> = ({ queued, note }) => {
  const _ = useTranslation();
  if (queued.length === 0) return null;
  return (
    <section aria-label={_('Waiting to send')} className='flex flex-col gap-2'>
      <div className='flex flex-col gap-0.5'>
        <h2 className='text-base font-semibold leading-snug'>{_('Waiting to send')}</h2>
        {note && <p className='text-base-content/70 text-sm leading-snug'>{note}</p>}
      </div>
      <ul className='border-base-content/10 eink:border-base-content divide-base-content/10 eink:divide-base-content flex flex-col divide-y rounded-xl border'>
        {queued.map((entry) => (
          <li key={entry.requestId} className='flex min-h-11 flex-col justify-center px-3 py-2'>
            <span className='line-clamp-1 text-sm font-semibold leading-snug'>
              {entry.body.title}
            </span>
            <span className='text-base-content/70 line-clamp-1 text-xs leading-snug'>
              {[entry.body.author, wantLabel(_, entry.body.want)].filter(Boolean).join(' · ')}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
};

/** Says why Homebase turned a queued request down, and what to do next. */
export const rejectReasonText = (_: TranslationFunc, reason: DiscoverRejectReason): string => {
  switch (reason) {
    case 'title':
      return _(
        'Homebase could not read the title. Find the book again and request it from its page.',
      );
    case 'author':
      return _(
        'Homebase could not read the author name. Find the book again and request it from its page.',
      );
    case 'format':
      return _('Homebase did not recognise the format asked for. Choose ebook or audiobook again.');
    case 'offer_expired':
      return _('The release it pointed to has expired. Search again to pick a current one.');
    case 'id_conflict':
      return _('Homebase already had a different request under the same id. Request it again.');
    case 'too_large':
      return _('The request was larger than Homebase accepts. Request it again from its page.');
    default:
      return _('Homebase could not read the request. Try it again from its page.');
  }
};

export const NotSentList: React.FC<{
  rejected: RejectedRequest[];
  onDismiss: () => void;
}> = ({ rejected, onDismiss }) => {
  const _ = useTranslation();
  if (rejected.length === 0) return null;
  return (
    <section aria-label={_('Not sent')} className='flex flex-col gap-2'>
      <div className='flex items-baseline justify-between gap-3'>
        <h2 className='text-base font-semibold leading-snug'>{_('Not sent')}</h2>
        <button type='button' onClick={onDismiss} className='h-11 px-2 text-sm font-medium'>
          {_('Dismiss')}
        </button>
      </div>
      <ul className='flex flex-col gap-1'>
        {rejected.map((item) => (
          <li key={item.requestId} className='text-sm leading-snug'>
            <span className='font-semibold'>{item.title}</span>
            <span className='text-base-content/70'>
              {' · '}
              {rejectReasonText(_, item.reason)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
};

interface DiscoverOfflineStateProps {
  saved: CachedBrowse | null;
  queued: DiscoverQueuedRequest[];
  now: number;
  onBack: () => void;
  onOpenWork: (work: DiscoverWork) => void;
}

/** Calm, complete and static: no spinner, nothing that pretends to load. */
const DiscoverOfflineState: React.FC<DiscoverOfflineStateProps> = ({
  saved,
  queued,
  now,
  onBack,
  onOpenWork,
}) => {
  const _ = useTranslation();
  const savedNote = saved
    ? _('Saved {{time}}', { time: formatSavedAgo(saved.savedAt, now) })
    : undefined;
  return (
    <div className='flex flex-col gap-10'>
      <section className={panelClass} data-testid='discover-offline'>
        <IoCloudOfflineOutline aria-hidden size={28} />
        <div className='flex max-w-prose flex-col gap-1.5'>
          <h2 className='text-xl font-semibold leading-tight'>{_('You are offline.')}</h2>
          <p className='text-base-content/80 text-base leading-relaxed'>
            {_('Discover needs Homebase; your downloaded books are all still here.')}
          </p>
        </div>
        <button type='button' onClick={onBack} className={outlineButton}>
          {_('Back to library')}
        </button>
      </section>
      <WaitingToSendList
        queued={queued}
        note={_('These send by themselves when Homebase is back.')}
      />
      {saved?.data.shelves.map((shelf, index) => (
        <DiscoverShelf
          key={`${shelf.key}:${index}`}
          title={shelf.title}
          reason={shelf.reason}
          works={shelf.works}
          onOpenWork={onOpenWork}
          note={index === 0 ? savedNote : undefined}
        />
      ))}
    </div>
  );
};

export const DiscoverForbiddenState: React.FC<{
  onBack: () => void;
  onRetry: () => void;
}> = ({ onBack, onRetry }) => {
  const _ = useTranslation();
  return (
    <section className={panelClass} data-testid='discover-forbidden'>
      <IoLockClosedOutline aria-hidden size={28} />
      <div className='flex max-w-prose flex-col gap-1.5'>
        <h2 className='text-xl font-semibold leading-tight'>
          {_('Discover works on the home tailnet')}
        </h2>
        <p className='text-base-content/80 text-base leading-relaxed'>
          {_(
            'Connect this device to Tailscale, then try again. Your downloaded books are all still here.',
          )}
        </p>
      </div>
      <div className='flex flex-wrap gap-2'>
        <button type='button' onClick={onRetry} className={outlineButton}>
          <IoRefresh aria-hidden size={16} />
          {_('Try again')}
        </button>
        <button type='button' onClick={onBack} className={outlineButton}>
          {_('Back to library')}
        </button>
      </div>
    </section>
  );
};

export const DiscoverUnavailableState: React.FC<{ onRetry: () => void }> = ({ onRetry }) => {
  const _ = useTranslation();
  return (
    <section className={panelClass} data-testid='discover-unavailable'>
      <div className='flex max-w-prose flex-col gap-1.5'>
        <h2 className='text-xl font-semibold leading-tight'>{_('Suggestions did not load')}</h2>
        <p className='text-base-content/80 text-base leading-relaxed'>
          {_('Homebase did not answer this time. Try again in a moment.')}
        </p>
      </div>
      <button type='button' onClick={onRetry} className={outlineButton}>
        <IoRefresh aria-hidden size={16} />
        {_('Try again')}
      </button>
    </section>
  );
};

export default DiscoverOfflineState;
