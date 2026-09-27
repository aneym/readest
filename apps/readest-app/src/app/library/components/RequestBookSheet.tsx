import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { useImmersionStore } from '@/store/immersionStore';
import { createImmersionClient } from '@/services/homebase/immersion/client';
import type { RequestRecord, SearchResult } from '@/services/homebase/immersion/types';
import { useSettingsStore } from '@/store/settingsStore';
import RequestResultRow from './request/RequestResultRow';
import RequestStatusRow from './request/RequestStatusRow';
import type { ResultAction } from './request/requestModel';

export default function RequestBookSheet() {
  const _ = useTranslation();
  const { sheet, openSheet, closeSheet } = useImmersionStore();
  const isBwEink = useSettingsStore(
    (s) => !!s.settings.globalViewSettings?.isEink && !s.settings.globalViewSettings?.isColorEink,
  );
  const [results, setResults] = useState<SearchResult[]>([]);
  const [requests, setRequests] = useState<RequestRecord[]>([]);
  const [searchState, setSearchState] = useState<'idle' | 'loading' | 'empty' | 'error'>('idle');
  const [retrySearch, setRetrySearch] = useState(0);
  const [requestState, setRequestState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [connected, setConnected] = useState(
    () => typeof navigator === 'undefined' || navigator.onLine,
  );
  const [errors, setErrors] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [requested, setRequested] = useState<Set<string>>(new Set());
  const client = useRef<ReturnType<typeof createImmersionClient>>(null);
  const hasInFlight = useRef(false);
  if (sheet.open && client.current === null) client.current = createImmersionClient();
  useEffect(() => {
    if (!sheet.open) return;
    const refreshConnection = () => setConnected(navigator.onLine);
    window.addEventListener('online', refreshConnection);
    window.addEventListener('offline', refreshConnection);
    return () => {
      window.removeEventListener('online', refreshConnection);
      window.removeEventListener('offline', refreshConnection);
    };
  }, [sheet.open]);
  const online = connected;

  useEffect(() => {
    if (!sheet.open || sheet.tab !== 'find') return;
    const query = sheet.query.trim();
    if (query.length < 2 || !online || !client.current) {
      setSearchState('idle');
      setResults([]);
      return;
    }
    const controller = new AbortController();
    setSearchState('loading');
    const timer = setTimeout(() => {
      void client
        .current!.search(query, controller.signal)
        .then((rows) => {
          if (controller.signal.aborted) return;
          setResults(rows);
          setSearchState(rows.length ? 'idle' : 'empty');
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setResults([]);
            setSearchState('error');
          }
        });
    }, 400);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [sheet.open, sheet.tab, sheet.query, online, retrySearch]);

  useEffect(() => {
    if (!sheet.open || !online || !client.current) return;
    let cancelled = false;
    const controller = new AbortController();
    const refresh = () => {
      void client
        .current!.listRequests(controller.signal)
        .then((rows) => {
          if (cancelled) return;
          setRequests(rows);
          hasInFlight.current = rows.some(
            (row) =>
              row.pair.state === 'queued' ||
              row.pair.state === 'aligning' ||
              (row.want !== 'audiobook' && ['requested', 'acquiring'].includes(row.ebook.state)) ||
              (row.want !== 'ebook' && ['requested', 'acquiring'].includes(row.audiobook.state)),
          );
          setRequestState('ready');
        })
        .catch(() => {
          if (!cancelled) setRequestState('error');
        });
    };
    setRequestState('loading');
    refresh();
    // Only keep polling while some request still needs work or a decision.
    const timer = setInterval(() => {
      if (sheet.tab === 'requests' && hasInFlight.current) refresh();
    }, 10_000);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(timer);
    };
  }, [sheet.open, sheet.tab, online]);

  const runAction = async (result: SearchResult, action: ResultAction) => {
    const api = client.current;
    if (!api || !online) return;
    setBusy(result.key);
    setErrors((previous) => ({ ...previous, [result.key]: false }));
    if (action.want) setRequested((previous) => new Set(previous).add(result.key));
    try {
      if (action.want) {
        const record = await api.createRequest({
          title: result.title,
          author: result.author,
          isbn: result.isbn,
          want: action.want,
        });
        setRequests((previous) => [record, ...previous]);
        hasInFlight.current = true;
        setRequested((previous) => new Set(previous).add(result.key));
      } else if (action.pairId && action.operation) {
        await (action.operation === 'confirm'
          ? api.confirmPair(action.pairId)
          : api.realignPair(action.pairId));
        setRequested((previous) => new Set(previous).add(result.key));
      }
    } catch {
      setRequested((previous) => {
        const next = new Set(previous);
        next.delete(result.key);
        return next;
      });
      setErrors((previous) => ({ ...previous, [result.key]: true }));
    } finally {
      setBusy(null);
    }
  };

  const actOnPair = async (pairId: string, operation: 'confirm' | 'realign') => {
    const api = client.current;
    if (!api) return;
    setBusy(pairId);
    try {
      const pair = await (operation === 'confirm'
        ? api.confirmPair(pairId)
        : api.realignPair(pairId));
      setRequests((previous) =>
        previous.map((row) => (row.pair.pairId === pairId ? { ...row, pair } : row)),
      );
    } catch {
      setRequestState('error');
    } finally {
      setBusy(null);
    }
  };

  if (!sheet.open) return null;
  return (
    <div
      className='fixed inset-0 z-[100] flex items-end justify-center bg-black/50 sm:items-center'
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeSheet();
      }}
    >
      <section
        role='dialog'
        aria-modal='true'
        aria-label={_('Get a book')}
        className='bg-base-100 text-base-content flex max-h-[90vh] w-full max-w-xl flex-col rounded-t-2xl p-5 sm:rounded-2xl'
      >
        <header className='flex items-center justify-between'>
          <h2 className='text-xl font-bold'>{_('Get a book')}</h2>
          <button
            aria-label={_('Close')}
            type='button'
            className='btn btn-ghost btn-sm'
            onClick={closeSheet}
          >
            ×
          </button>
        </header>
        <div role='tablist' className='my-4 flex gap-3'>
          <button
            type='button'
            role='tab'
            aria-selected={sheet.tab === 'find'}
            className='btn btn-sm'
            onClick={() => openSheet('find')}
          >
            {_('Find')}
          </button>
          <button
            type='button'
            role='tab'
            aria-selected={sheet.tab === 'requests'}
            className='btn btn-sm'
            onClick={() => openSheet('requests')}
          >
            {_('Requests')} ({requests.length})
          </button>
        </div>
        {!online || !client.current ? (
          <p role='status'>
            {online
              ? _('Connect Homebase in Settings to request books.')
              : _("You're offline. Requests need a connection.")}
          </p>
        ) : sheet.tab === 'find' ? (
          <div className='min-h-0 overflow-y-auto'>
            <label htmlFor='request-book-query' className='sr-only'>
              {_('Find a book')}
            </label>
            <input
              id='request-book-query'
              autoFocus
              className='input input-bordered w-full'
              placeholder={_('Search by title or author')}
              value={sheet.query}
              onChange={(event) => openSheet('find', event.target.value)}
            />
            {sheet.query.trim().length < 2 ? (
              <p className='py-4'>{_('Enter at least 2 characters to search.')}</p>
            ) : null}
            {searchState === 'loading' && (
              <p role='status' className='py-4'>
                {_('Searching…')}
              </p>
            )}
            {searchState === 'empty' && (
              <p role='status' className='py-4'>
                {_('No matches for "{{q}}". Try the author\'s name.', { q: sheet.query.trim() })}
              </p>
            )}
            {searchState === 'error' && (
              <div className='py-4'>
                <p role='alert'>{_("Couldn't reach Homebase.")}</p>
                <button
                  type='button'
                  className='btn btn-sm btn-outline'
                  onClick={() => setRetrySearch((value) => value + 1)}
                >
                  {_('Try again')}
                </button>
              </div>
            )}
            <ul>
              {results.map((result) => (
                <RequestResultRow
                  key={result.key}
                  result={result}
                  requested={requested.has(result.key)}
                  error={!!errors[result.key]}
                  busy={busy === result.key}
                  onAction={(action) => void runAction(result, action)}
                />
              ))}
            </ul>
          </div>
        ) : (
          <div className='min-h-0 overflow-y-auto'>
            {requestState === 'loading' && <p role='status'>{_('Loading requests…')}</p>}
            {requestState === 'error' && (
              <p role='alert'>{_('Couldn’t load requests. Try again.')}</p>
            )}
            {requestState === 'ready' && requests.length === 0 && (
              <p role='status'>{_('Nothing requested yet.')}</p>
            )}
            <ul>
              {requests.map((record) => (
                <RequestStatusRow
                  key={record.id}
                  record={record}
                  isBwEink={isBwEink}
                  busy={busy === record.pair.pairId}
                  onConfirm={(id) => void actOnPair(id, 'confirm')}
                  onRealign={(id) => void actOnPair(id, 'realign')}
                />
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}
