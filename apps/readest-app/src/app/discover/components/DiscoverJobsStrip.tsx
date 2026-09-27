import React from 'react';
import { useTranslation, type TranslationFunc } from '@/hooks/useTranslation';
import type { DiscoverJob } from '@/services/discover/types';

export const kindLabel = (_: TranslationFunc, kind: DiscoverJob['kind']) =>
  kind === 'ebook' ? _('Ebook') : _('Audiobook');

export const stageLabel = (_: TranslationFunc, job: DiscoverJob): string => {
  switch (job.stage) {
    case 'queued':
      return _('Queued');
    case 'searching':
      return _('Finding a release');
    case 'downloading':
      return job.percent !== null
        ? _('Downloading {{percent}}%', { percent: Math.round(job.percent) })
        : _('Downloading');
    case 'importing':
      return _('Adding to your library');
    case 'on_shelf':
      return _('On your shelf');
    case 'cancelled':
      return _('Cancelled');
    case 'failed':
      switch (job.failure?.code) {
        case 'vpn_down':
          return _('Paused: the VPN lane is down');
        case 'not_found':
          return _('No source has this right now');
        case 'download_stalled':
          return _('The download stalled');
        case 'import_timeout':
          return _('Downloaded, but never reached the library');
        case 'already_owned':
          return _('Already on your shelf');
        default:
          return _('Something went wrong');
      }
  }
};

interface DiscoverJobsStripProps {
  jobs: DiscoverJob[];
  busyJobIds: ReadonlySet<string>;
  onRetry: (jobId: string) => void;
  onCancel: (jobId: string) => void;
}

/** Requests Homebase is working on, with the one action each can take. */
const DiscoverJobsStrip: React.FC<DiscoverJobsStripProps> = ({
  jobs,
  busyJobIds,
  onRetry,
  onCancel,
}) => {
  const _ = useTranslation();
  if (jobs.length === 0) return null;
  return (
    <section aria-label={_('Getting')} className='flex flex-col gap-2'>
      <h2 className='text-base font-semibold leading-snug'>{_('Getting')}</h2>
      <ul className='grid gap-2 md:grid-cols-2 xl:grid-cols-3'>
        {jobs.map((job) => {
          const busy = busyJobIds.has(job.id);
          const showBar = job.stage === 'downloading' && job.percent !== null;
          return (
            <li
              key={job.id}
              data-testid='discover-job'
              className='border-base-content/10 eink:border-base-content flex items-center gap-3 rounded-xl border px-3 py-2'
            >
              <div className='flex min-w-0 flex-1 flex-col gap-1'>
                <p className='line-clamp-1 text-sm font-semibold leading-snug'>{job.title}</p>
                <p className='text-base-content/70 text-xs tabular-nums leading-snug'>
                  {kindLabel(_, job.kind)} · {stageLabel(_, job)}
                </p>
                {showBar && (
                  <div
                    role='progressbar'
                    aria-label={_('Download progress')}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(job.percent!)}
                    className='bg-base-200 eink:bg-base-100 eink:border eink:border-base-content h-1 w-full overflow-hidden rounded-full'
                  >
                    <div
                      className='bg-primary eink:bg-base-content h-full'
                      style={{
                        width: `${Math.max(0, Math.min(100, job.percent!))}%`,
                      }}
                    />
                  </div>
                )}
              </div>
              {job.canRetry && (
                <button
                  type='button'
                  disabled={busy}
                  onClick={() => onRetry(job.id)}
                  className='border-base-content/20 eink:border-base-content h-11 shrink-0 rounded-full border px-4 text-sm font-medium disabled:opacity-50'
                >
                  {_('Retry')}
                </button>
              )}
              {!job.canRetry && job.canCancel && (
                <button
                  type='button'
                  disabled={busy}
                  onClick={() => onCancel(job.id)}
                  className='border-base-content/20 eink:border-base-content h-11 shrink-0 rounded-full border px-4 text-sm font-medium disabled:opacity-50'
                >
                  {_('Cancel')}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
};

export default DiscoverJobsStrip;
