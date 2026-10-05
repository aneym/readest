import { useEffect, useState } from 'react';
import { useBookDataStore } from '@/store/bookDataStore';
import { useReaderStore } from '@/store/readerStore';
import { useImmersionStore } from '@/store/immersionStore';
import { discoverClient } from '@/services/discover/client';
import { createImmersionClient } from '@/services/homebase/immersion/client';
import { hasMediaOverlays } from '@/services/tts/mediaOverlay';
import { findPairedAudiobookSection } from '@/services/tts/pairedAudiobook';
import { eventDispatcher } from '@/utils/event';

export type NarrationAvailabilityState =
  | 'narrated'
  | 'queued'
  | 'aligning'
  | 'needs-check'
  | 'swap-ready'
  | 'fetching-edition'
  | 'failed'
  | 'can-align'
  | 'none'
  | 'unknown';
export interface NarrationAvailability {
  state: NarrationAvailabilityState;
  stage?: string;
  progress?: number;
  error?: string;
  pairId?: string;
}
export function deriveNarrationState(input: {
  narratable: boolean;
  pair?: {
    state: string;
    stage?: string;
    progress?: number;
    error?: string;
    pairId?: string;
  } | null;
  ownsAudiobook?: boolean | null;
}): NarrationAvailability {
  if (input.narratable) return { state: 'narrated' };
  const pair = input.pair;
  if (pair && pair.state !== 'none') {
    const states: Record<string, NarrationAvailabilityState> = {
      queued: 'queued',
      aligning: 'aligning',
      candidate: 'needs-check',
      'ready-to-swap': 'swap-ready',
      aligned: 'fetching-edition',
      failed: 'failed',
    };
    const state = states[pair.state];
    if (state) return { ...pair, state };
  }
  return {
    state: input.ownsAudiobook == null ? 'unknown' : input.ownsAudiobook ? 'can-align' : 'none',
  };
}

export const NARRATION_STATUS_OPEN_EVENT = 'narration-status-open';
const syntheticBooks = new Set<string>();
export function markSyntheticChosen(bookKey: string): void {
  syntheticBooks.add(bookKey);
}
export function hasChosenSynthetic(bookKey: string): boolean {
  return syntheticBooks.has(bookKey);
}

export function shouldOpenNarrationStatus(
  bookKey: string,
  availability: NarrationAvailability,
): boolean {
  return (
    !hasChosenSynthetic(bookKey) && !['narrated', 'none', 'unknown'].includes(availability.state)
  );
}

const stages: Record<string, [number, string]> = {
  staging: [1, 'preparing the files'],
  importing: [1, 'preparing the files'],
  transcribing: [2, 'transcribing the audio'],
  syncing: [3, 'matching audio to text'],
  downloading: [4, 'checking the result'],
  validating: [4, 'checking the result'],
  swapping: [5, 'finishing up'],
  done: [5, 'finishing up'],
};
export function narrationStageLine(
  _: (s: string, o?: Record<string, unknown>) => string,
  a: NarrationAvailability,
  bwEink: boolean,
): string {
  const [n, stage] = stages[a.stage ?? 'staging'] ?? stages['staging']!;
  // Same rounding as requestModel's private percent(): clamp, floor, then floor to five.
  const value = Math.max(0, Math.min(100, Math.floor((a.progress ?? 0) * 100)));
  const percent = bwEink ? Math.floor(value / 5) * 5 : value;
  return _(
    a.progress == null ? 'Step {{n}} of 5: {{stage}}' : 'Step {{n}} of 5: {{stage}}, {{percent}}%',
    {
      n,
      stage: _(stage),
      percent,
    },
  );
}

interface ReaderSession {
  users: number;
  open: boolean;
  playing: boolean;
  ownership?: Promise<boolean | null>;
  timer: ReturnType<typeof setInterval>;
}
const sessions = new Map<string, ReaderSession>();
const requestedHashes = new Set<string>();
// Keep a successful local POST visible until the server reports its pair.
export function markNarrationQueued(hash: string): void {
  requestedHashes.add(hash);
  const store = useImmersionStore.getState();
  store.setPairs({ ...store.pairByHash, [hash]: { ...store.pairByHash[hash], state: 'queued' } });
}
let statusFlight: Promise<void> | null = null;
function fetchStatus(): Promise<void> {
  if (statusFlight) return statusFlight;
  const api = createImmersionClient();
  if (!api) return Promise.resolve();
  statusFlight = api
    .status()
    .then((pairs) => {
      for (const hash of requestedHashes) {
        if (pairs[hash] && pairs[hash].state !== 'none') requestedHashes.delete(hash);
        else pairs[hash] = { state: 'queued' };
      }
      useImmersionStore.getState().setPairs(pairs);
    })
    .catch(() => {
      /* Keep the last known status offline. */
    })
    .finally(() => {
      statusFlight = null;
    });
  return statusFlight;
}

export function useNarrationAvailability(bookKey: string): NarrationAvailability {
  const data = useBookDataStore((s) => s.booksData[bookKey.split('-')[0]!]);
  const pair = useImmersionStore((s) => {
    const value = data?.book ? s.pairByHash[data.book.hash] : undefined;
    // Avoid progress ticks that cannot change the visible stage line on e-ink.
    const settings = useReaderStore.getState().getViewSettings(bookKey);
    const bw = settings?.isEink && !settings.isColorEink;
    return value
      ? JSON.stringify({
          ...value,
          progress:
            value.progress == null
              ? undefined
              : (bw
                  ? Math.floor(Math.floor(value.progress * 100) / 5) * 5
                  : Math.floor(value.progress * 100)) / 100,
        })
      : '';
  });
  const [ownsAudiobook, setOwnership] = useState<boolean | null>(null);
  const book = data?.book;
  useEffect(() => {
    if (!book) return;
    let session = sessions.get(bookKey);
    if (!session) {
      session = {
        users: 0,
        open: false,
        playing: false,
        timer: setInterval(() => {
          const current = sessions.get(bookKey);
          const state = useImmersionStore.getState().pairByHash[book.hash]?.state;
          if (
            current?.open ||
            (current?.playing &&
              hasChosenSynthetic(bookKey) &&
              state &&
              ['queued', 'aligning', 'candidate', 'ready-to-swap', 'aligned'].includes(state))
          )
            void fetchStatus();
        }, 60_000),
      };
      sessions.set(bookKey, session);
      void fetchStatus();
    }
    session.users++;
    const onOpen = (event: CustomEvent<{ bookKey: string; open?: boolean }>) => {
      if (event.detail?.bookKey === bookKey) session.open = event.detail.open !== false;
    };
    const onPlayback = (event: CustomEvent<{ bookKey: string; state: string }>) => {
      if (event.detail?.bookKey === bookKey)
        session.playing = event.detail.state === 'playing' || event.detail.state === 'paused';
    };
    eventDispatcher.on(NARRATION_STATUS_OPEN_EVENT, onOpen);
    eventDispatcher.on('narration-status-visibility', onOpen);
    eventDispatcher.on('tts-playback-state', onPlayback);
    return () => {
      eventDispatcher.off(NARRATION_STATUS_OPEN_EVENT, onOpen);
      eventDispatcher.off('narration-status-visibility', onOpen);
      eventDispatcher.off('tts-playback-state', onPlayback);
      if (--session.users === 0) {
        clearInterval(session.timer);
        sessions.delete(bookKey);
        requestedHashes.delete(book.hash);
        syntheticBooks.delete(bookKey);
      }
    };
  }, [bookKey, book?.hash]);
  useEffect(() => {
    setOwnership(null);
    if (!book || !createImmersionClient()) return;
    const parsed = pair ? JSON.parse(pair) : null;
    if (parsed && parsed.state !== 'none') return;
    const session = sessions.get(bookKey);
    if (!session) return;
    session.ownership ??= discoverClient
      .work({ title: book.title, author: book.author })
      .then((result) => (result.ok ? !!result.data.work.owned.audiobook : null))
      .catch(() => null);
    let active = true;
    void session.ownership.then((owned) => {
      if (active) setOwnership(owned);
    });
    return () => {
      active = false;
    };
  }, [bookKey, book?.hash, pair]);
  const narratable =
    hasMediaOverlays(data?.bookDoc) ||
    !!(
      data?.bookDoc &&
      data.config?.audiobook &&
      findPairedAudiobookSection(data.bookDoc, data.config.audiobook, 0, 1) >= 0
    );
  return deriveNarrationState({ narratable, pair: pair ? JSON.parse(pair) : null, ownsAudiobook });
}
