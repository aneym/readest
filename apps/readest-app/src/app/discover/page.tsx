'use client';

import clsx from 'clsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { IoArrowBack, IoPauseCircleOutline, IoSearch } from 'react-icons/io5';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from '@/hooks/useTranslation';
import { useThemeStore } from '@/store/themeStore';
import {
  discoverClient,
  isDeviceOnline,
  type DiscoverFailure,
  type DiscoverSearchKind,
} from '@/services/discover/client';
import { loadBrowse, saveBrowse, type CachedBrowse } from '@/services/discover/cache';
import {
  dismissRejected,
  flushQueue,
  loadQueue,
  loadRejected,
  startQueueAutoFlush,
  subscribeQueue,
  type FlushOutcome,
  type RejectedRequest,
} from '@/services/discover/requestQueue';
import {
  DISCOVER_TERMINAL_STAGES,
  type DiscoverAcquisitionStatus,
  type DiscoverBrowseResponse,
  type DiscoverJob,
  type DiscoverQueuedRequest,
  type DiscoverSearchResponse,
  type DiscoverWork,
} from '@/services/discover/types';
import DiscoverShelf from './components/DiscoverShelf';
import DiscoverWorkSheet from './components/DiscoverWorkSheet';
import DiscoverJobsStrip from './components/DiscoverJobsStrip';
import DiscoverOfflineState, {
  DiscoverForbiddenState,
  DiscoverUnavailableState,
  NotSentList,
  WaitingToSendList,
  formatSavedAgo,
} from './components/DiscoverOfflineState';

const JOB_POLL_MS = 3_000;
const QUEUE_RETRY_MS = 60_000;
/** Probe backoff while Homebase is unreachable: 15 s, 30 s, 60 s ... up to 5 min. */
const RECONNECT_FIRST_MS = 15_000;
const RECONNECT_MAX_MS = 5 * 60_000;
/** Finished and failed jobs stay in the strip this long after they settle. */
const RECENT_JOB_MS = 60 * 60 * 1000;

type Load<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'failed'; failure: DiscoverFailure };

interface SearchState {
  query: string;
  kind: DiscoverSearchKind;
  load: Load<DiscoverSearchResponse>;
}

const isTerminal = (job: DiscoverJob) => DISCOVER_TERMINAL_STAGES.includes(job.stage);

const mergeJobs = (current: DiscoverJob[], incoming: DiscoverJob[]): DiscoverJob[] => {
  const byId = new Map(current.map((job) => [job.id, job]));
  for (const job of incoming) byId.set(job.id, job);
  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
};

const visibleJobs = (jobs: DiscoverJob[], now: number) =>
  jobs.filter((job) => !isTerminal(job) || now - job.updatedAt < RECENT_JOB_MS);

const SEARCH_KINDS: DiscoverSearchKind[] = ['all', 'ebook', 'audiobook'];

/** One row of placeholder covers at each breakpoint's column count. */
const PLACEHOLDER_VISIBILITY = [
  undefined,
  undefined,
  'max-[379px]:hidden',
  'hidden sm:block',
  'hidden md:block',
  'hidden lg:block',
  'hidden xl:block',
];

const DiscoverPage = () => {
  const _ = useTranslation();
  const router = useRouter();
  const { safeAreaInsets } = useThemeStore();
  useTheme({ systemUIVisible: true, appThemeColor: 'base-100' });

  const [online, setOnline] = useState(true);
  const [browse, setBrowse] = useState<Load<DiscoverBrowseResponse>>({
    status: 'idle',
  });
  const [saved, setSaved] = useState<CachedBrowse | null>(null);
  const [search, setSearch] = useState<SearchState | null>(null);
  const [queryInput, setQueryInput] = useState('');
  const [kind, setKind] = useState<DiscoverSearchKind>('all');
  const [jobs, setJobs] = useState<DiscoverJob[]>([]);
  const [acquisition, setAcquisition] = useState<DiscoverAcquisitionStatus | null>(null);
  const [queue, setQueue] = useState<DiscoverQueuedRequest[]>([]);
  const [rejected, setRejected] = useState<RejectedRequest[]>([]);
  const [selected, setSelected] = useState<DiscoverWork | null>(null);
  const [busyJobIds, setBusyJobIds] = useState<ReadonlySet<string>>(new Set());
  const [now, setNow] = useState(() => Date.now());
  const searchRef = useRef<HTMLInputElement>(null);

  const goBack = useCallback(() => router.push('/library'), [router]);

  const onFlushed = useCallback((outcome: FlushOutcome) => {
    if (outcome.jobs.length > 0) setJobs((current) => mergeJobs(current, outcome.jobs));
  }, []);

  const refreshJobs = useCallback(async () => {
    const result = await discoverClient.jobs();
    if (result.ok) setJobs((current) => mergeJobs(current, result.data.jobs));
  }, []);

  const loadAll = useCallback(async () => {
    setNow(Date.now());
    if (!isDeviceOnline()) {
      setOnline(false);
      return;
    }
    setBrowse({ status: 'loading' });
    const result = await discoverClient.browse();
    // Any answer from Homebase, even a refusal, means it is reachable again.
    setOnline(result.ok || result.failure !== 'offline');
    if (result.ok) {
      saveBrowse(result.data);
      setSaved(loadBrowse());
      setBrowse({ status: 'ready', data: result.data });
    } else {
      setBrowse({ status: 'failed', failure: result.failure });
      return;
    }
    const [providers] = await Promise.all([discoverClient.providers(), refreshJobs()]);
    if (providers.ok) setAcquisition(providers.data.acquisition);
    onFlushed(await flushQueue());
  }, [onFlushed, refreshJobs]);

  // Mount: show what is saved at once, then ask Homebase.
  useEffect(() => {
    setSaved(loadBrowse());
    setQueue(loadQueue());
    setRejected(loadRejected());
    setOnline(isDeviceOnline());
    void loadAll();
    const unsubscribe = subscribeQueue(() => {
      setQueue(loadQueue());
      setRejected(loadRejected());
    });
    const stopAutoFlush = startQueueAutoFlush(onFlushed);
    const onOnline = () => {
      setOnline(true);
      void loadAll();
    };
    const onOffline = () => {
      setOnline(false);
      setNow(Date.now());
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      unsubscribe();
      stopAutoFlush();
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [loadAll, onFlushed]);

  // The browser's 'online' event only fires after the device itself was
  // offline. When the network is up but Homebase is out of reach (tailnet
  // down, server restarting), nothing would fire, so while in that state the
  // page probes Homebase on a backoff and whenever it comes back on screen.
  // A successful probe clears the offline state and flushes the queue.
  useEffect(() => {
    if (online) return;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const probe = async () => {
      if (cancelled || !isDeviceOnline() || document.visibilityState !== 'visible') return;
      await loadAll();
    };
    const schedule = () => {
      const delay = Math.min(RECONNECT_FIRST_MS * 2 ** attempt, RECONNECT_MAX_MS);
      attempt += 1;
      timer = setTimeout(() => {
        void probe().finally(() => {
          if (!cancelled) schedule();
        });
      }, delay);
    };
    schedule();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void probe();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [online, loadAll]);

  // Poll only while something is moving and the page is on screen.
  const moving = jobs.some((job) => !isTerminal(job));
  useEffect(() => {
    if (!online || !moving) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refreshJobs();
    }, JOB_POLL_MS);
    return () => clearInterval(timer);
  }, [online, moving, refreshJobs]);

  // Requests held back (VPN lane down, server busy) get another try now and
  // then while the page is open.
  useEffect(() => {
    if (!online || queue.length === 0) return;
    const timer = setInterval(() => {
      void flushQueue().then(onFlushed);
    }, QUEUE_RETRY_MS);
    return () => clearInterval(timer);
  }, [online, queue.length, onFlushed]);

  const runSearch = useCallback(async (query: string, searchKind: DiscoverSearchKind) => {
    const trimmed = query.trim();
    if (trimmed.length < 2) return;
    setSearch({
      query: trimmed,
      kind: searchKind,
      load: { status: 'loading' },
    });
    const result = await discoverClient.search(trimmed, searchKind);
    if (result.ok) setAcquisition(result.data.acquisition);
    else if (result.failure === 'offline') setOnline(false);
    setSearch((current) =>
      current && current.query === trimmed && current.kind === searchKind
        ? {
            ...current,
            load: result.ok
              ? { status: 'ready', data: result.data }
              : { status: 'failed', failure: result.failure },
          }
        : current,
    );
  }, []);

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    searchRef.current?.blur();
    void runSearch(queryInput, kind);
  };

  const onKindChange = (next: DiscoverSearchKind) => {
    setKind(next);
    if (search) void runSearch(search.query, next);
  };

  const clearSearch = () => {
    setSearch(null);
    setQueryInput('');
  };

  const actOnJob = async (jobId: string, action: 'retry' | 'cancel') => {
    setBusyJobIds((current) => new Set(current).add(jobId));
    const result = await discoverClient[action](jobId);
    if (result.ok) setJobs((current) => mergeJobs(current, [result.data.job]));
    setBusyJobIds((current) => {
      const next = new Set(current);
      next.delete(jobId);
      return next;
    });
  };

  const forbidden =
    online &&
    ((browse.status === 'failed' && browse.failure === 'forbidden') ||
      (search?.load.status === 'failed' && search.load.failure === 'forbidden'));
  const vpnDown = online && acquisition?.state === 'vpn_down';
  const shownJobs = online ? visibleJobs(jobs, now) : [];
  const savedNote = saved
    ? _('Saved {{time}}', { time: formatSavedAgo(saved.savedAt, now) })
    : undefined;

  const renderBrowse = () => {
    if (browse.status === 'ready') {
      const shelves = browse.data.shelves.filter((shelf) => shelf.works.length > 0);
      if (shelves.length === 0) {
        return (
          <div className='flex max-w-prose flex-col gap-1'>
            <h2 className='text-base font-semibold'>{_('Nothing to suggest yet')}</h2>
            <p className='text-base-content/70 text-sm leading-relaxed'>
              {_('Search for a book, author or series above.')}
            </p>
          </div>
        );
      }
      return shelves.map((shelf, index) => (
        <DiscoverShelf
          key={`${shelf.key}:${index}`}
          title={shelf.title}
          reason={shelf.reason}
          works={shelf.works}
          onOpenWork={setSelected}
        />
      ));
    }
    if (browse.status === 'failed') {
      return (
        <>
          <DiscoverUnavailableState onRetry={() => void loadAll()} />
          {saved?.data.shelves.map((shelf, index) => (
            <DiscoverShelf
              key={`${shelf.key}:${index}`}
              title={shelf.title}
              reason={shelf.reason}
              works={shelf.works}
              onOpenWork={setSelected}
              note={index === 0 ? savedNote : undefined}
            />
          ))}
        </>
      );
    }
    // Static placeholder: no spinner, nothing that animates on e-ink.
    return (
      <div role='status' className='flex flex-col gap-3'>
        <p className='text-base-content/70 text-sm'>{_('Loading suggestions')}</p>
        <div className='grid grid-cols-3 gap-x-4 max-[379px]:grid-cols-2 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7'>
          {Array.from({ length: 7 }, (_unused, index) => (
            <div
              key={index}
              className={clsx(
                'border-base-content/10 eink:border-base-content bg-base-200 eink:bg-base-100 aspect-[2/3] rounded-md border',
                PLACEHOLDER_VISIBILITY[index],
              )}
            />
          ))}
        </div>
      </div>
    );
  };

  const renderSearch = (state: SearchState) => {
    const { load } = state;
    if (load.status === 'ready') {
      if (load.data.works.length === 0) {
        return (
          <div className='flex max-w-prose flex-col gap-1'>
            <h2 className='text-base font-semibold'>
              {_('Nothing found for “{{query}}”', { query: state.query })}
            </h2>
            <p className='text-base-content/70 text-sm leading-relaxed'>
              {_("No source has it right now. Try the author's name, or fewer words.")}
            </p>
          </div>
        );
      }
      return (
        <DiscoverShelf
          title={_('Results for “{{query}}”', { query: state.query })}
          works={load.data.works}
          onOpenWork={setSelected}
          collapsible={false}
        />
      );
    }
    if (load.status === 'failed') {
      return (
        <div className='flex max-w-prose flex-col items-start gap-3'>
          <p className='text-sm font-medium'>
            {load.failure === 'unavailable'
              ? _('Homebase is busy right now. Try again in a moment.')
              : _('Search did not go through.')}
          </p>
          <button
            type='button'
            onClick={() => void runSearch(state.query, state.kind)}
            className='border-base-content/25 eink:border-base-content h-11 rounded-full border px-5 text-sm font-semibold'
          >
            {_('Try again')}
          </button>
        </div>
      );
    }
    return (
      <p role='status' className='text-base-content/70 text-sm'>
        {_('Searching every source. Slow ones can take up to 20 seconds.')}
      </p>
    );
  };

  const kindLabels: Record<DiscoverSearchKind, string> = {
    all: _('All'),
    ebook: _('Ebooks'),
    audiobook: _('Audiobooks'),
  };

  return (
    <div
      className='bg-base-100 text-base-content full-height flex flex-col overflow-hidden'
      style={{
        paddingTop: `${safeAreaInsets?.top || 0}px`,
        paddingBottom: `${safeAreaInsets?.bottom || 0}px`,
      }}
    >
      <header className='border-base-content/10 eink:border-base-content flex h-14 shrink-0 items-center gap-1 border-b px-2 sm:px-4'>
        <button
          type='button'
          aria-label={_('Back to library')}
          onClick={goBack}
          className='flex h-11 w-11 items-center justify-center rounded-full'
        >
          <IoArrowBack aria-hidden size={22} className='rtl:rotate-180' />
        </button>
        <h1 className='text-lg font-semibold'>{_('Discover')}</h1>
      </header>

      <main className='flex-1 overflow-y-auto'>
        <div className='mx-auto flex w-full max-w-6xl flex-col gap-10 px-4 pb-12 pt-5 sm:px-6 sm:pt-8'>
          {online && !forbidden && (
            <div className='flex flex-col gap-3'>
              <form role='search' onSubmit={onSubmit} className='flex w-full max-w-2xl gap-2'>
                <label className='border-base-content/20 eink:border-base-content bg-base-100 focus-within:border-base-content flex h-11 min-w-0 flex-1 items-center gap-2 rounded-full border px-4'>
                  <IoSearch aria-hidden size={18} className='text-base-content/70 shrink-0' />
                  <input
                    ref={searchRef}
                    type='search'
                    enterKeyHint='search'
                    value={queryInput}
                    onChange={(event) => setQueryInput(event.target.value)}
                    placeholder={_('Title, author or series')}
                    aria-label={_('Search books')}
                    className='placeholder:text-base-content/50 min-w-0 flex-1 bg-transparent text-base outline-none'
                  />
                </label>
                <button
                  type='submit'
                  className='bg-base-content text-base-100 eink-inverted h-11 shrink-0 rounded-full px-5 text-sm font-semibold'
                >
                  {_('Search')}
                </button>
              </form>
              <div className='flex flex-wrap items-center gap-2'>
                <div role='radiogroup' aria-label={_('Search in')} className='flex gap-2'>
                  {SEARCH_KINDS.map((option) => (
                    <button
                      key={option}
                      type='button'
                      role='radio'
                      aria-checked={kind === option}
                      onClick={() => onKindChange(option)}
                      className={clsx(
                        'h-11 rounded-full border px-4 text-sm font-medium',
                        kind === option
                          ? 'border-base-content bg-base-content text-base-100 eink-inverted'
                          : 'border-base-content/20 eink:border-base-content',
                      )}
                    >
                      {kindLabels[option]}
                    </button>
                  ))}
                </div>
                {search && (
                  <button
                    type='button'
                    onClick={clearSearch}
                    className='h-11 px-3 text-sm font-medium underline underline-offset-4'
                  >
                    {_('Back to suggestions')}
                  </button>
                )}
              </div>
            </div>
          )}

          {vpnDown && (
            <div
              role='note'
              className='border-base-content/15 eink:border-base-content bg-base-200/60 eink:bg-base-100 flex max-w-2xl items-start gap-3 rounded-xl border px-4 py-3'
            >
              <IoPauseCircleOutline aria-hidden size={20} className='mt-0.5 shrink-0' />
              <p className='text-sm font-medium leading-snug'>
                {_('Downloads paused: the VPN lane is down. Your request will wait.')}
              </p>
            </div>
          )}

          {!online ? (
            <DiscoverOfflineState
              saved={saved}
              queued={queue}
              now={now}
              onBack={goBack}
              onOpenWork={setSelected}
            />
          ) : forbidden ? (
            <DiscoverForbiddenState onBack={goBack} onRetry={() => void loadAll()} />
          ) : (
            <>
              <DiscoverJobsStrip
                jobs={shownJobs}
                busyJobIds={busyJobIds}
                onRetry={(id) => void actOnJob(id, 'retry')}
                onCancel={(id) => void actOnJob(id, 'cancel')}
              />
              <WaitingToSendList
                queued={queue}
                note={
                  vpnDown
                    ? _('These send once the VPN lane is back.')
                    : _('These send on the next try.')
                }
              />
              <NotSentList rejected={rejected} onDismiss={dismissRejected} />
              {search ? renderSearch(search) : renderBrowse()}
            </>
          )}
        </div>
      </main>

      {selected && (
        <DiscoverWorkSheet
          key={selected.key}
          work={selected}
          online={online}
          acquisition={acquisition}
          jobs={jobs}
          queued={queue}
          onClose={() => setSelected(null)}
          onJobs={(incoming) => setJobs((current) => mergeJobs(current, incoming))}
          onAcquisition={setAcquisition}
        />
      )}
    </div>
  );
};

export default DiscoverPage;
