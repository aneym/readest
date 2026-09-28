import {
  discoverClient,
  isDeviceOnline,
  rejectReasonFor,
  type DiscoverFailure,
  type DiscoverRejectReason,
} from './client';
import type { DiscoverJob, DiscoverQueuedRequest, DiscoverRequestBody } from './types';

/**
 * Durable outbox for Discover requests made while Homebase is out of reach.
 *
 * Entries live in localStorage in the contract's DiscoverQueuedRequest shape
 * and are sent oldest first when the device comes back online. Each entry
 * keeps the requestId it was created with, so a replay of a request the
 * server already saw is answered from the server's idempotency record instead
 * of starting a second download.
 */

const QUEUE_KEY = 'household.discover.queue';
const REJECTED_KEY = 'household.discover.rejected';
const CHANGE_EVENT = 'household-discover-queue';
const MAX_REJECTED = 5;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** A queued request the server turned down; kept so the page can say so. */
export interface RejectedRequest {
  requestId: string;
  title: string;
  author: string;
  want: DiscoverRequestBody['want'];
  status: number;
  /** Why it was turned down, as a code the page words; never the server's text. */
  reason: DiscoverRejectReason;
  rejectedAt: number;
}

export type FlushHold = DiscoverFailure | 'vpn';

export interface FlushOutcome {
  jobs: DiscoverJob[];
  sent: number;
  dropped: number;
  remaining: number;
  /** Why sending stopped early, when it did. */
  held: FlushHold | null;
}

export type SubmitOutcome =
  | { outcome: 'sent'; jobs: DiscoverJob[] }
  | { outcome: 'queued'; entry: DiscoverQueuedRequest }
  | { outcome: 'failed'; failure: DiscoverFailure };

const normalize = (value: string): string =>
  value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

export const requestDedupeKey = (body: Pick<DiscoverRequestBody, 'title' | 'author' | 'want'>) =>
  `${normalize(body.title)}|${normalize(body.author)}|${body.want}`;

const newRequestId = (): string => {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
};

const readList = <T>(key: string): T[] => {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
};

const writeList = (key: string, list: unknown[]): void => {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(list));
  } catch {
    // Storage denied or full; the in-memory call still completes.
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHANGE_EVENT));
};

const isQueued = (entry: DiscoverQueuedRequest): boolean =>
  !!entry &&
  typeof entry.requestId === 'string' &&
  typeof entry.body?.title === 'string' &&
  typeof entry.body?.author === 'string';

export const loadQueue = (): DiscoverQueuedRequest[] =>
  readList<DiscoverQueuedRequest>(QUEUE_KEY).filter(isQueued);

const REJECT_REASONS: ReadonlySet<string> = new Set<DiscoverRejectReason>([
  'title',
  'author',
  'format',
  'offer_expired',
  'id_conflict',
  'too_large',
  'unreadable',
]);

export const loadRejected = (): RejectedRequest[] =>
  readList<RejectedRequest>(REJECTED_KEY)
    .filter((item) => !!item && typeof item.requestId === 'string')
    .map((item) =>
      // Entries saved before reasons were kept get the reason their status implies.
      REJECT_REASONS.has(item.reason)
        ? item
        : { ...item, reason: rejectReasonFor(item.status, null) },
    );

export const dismissRejected = (): void => writeList(REJECTED_KEY, []);

/**
 * Adds a request unless the same title, author and want is already waiting.
 * Offer ids are dropped: they expire server-side within hours, and a queued
 * request should get whatever release is best when it is finally sent.
 */
export const enqueueRequest = (body: DiscoverRequestBody, now = Date.now()) => {
  const queue = loadQueue();
  const key = requestDedupeKey(body);
  const existing = queue.find((entry) => requestDedupeKey(entry.body) === key);
  if (existing) return existing;
  const requestId =
    body.requestId && REQUEST_ID.test(body.requestId) ? body.requestId : newRequestId();
  const entry: DiscoverQueuedRequest = {
    requestId,
    body: {
      title: body.title,
      author: body.author,
      want: body.want,
      requestId,
    },
    queuedAt: now,
    attempts: 0,
    lastError: null,
  };
  writeList(QUEUE_KEY, [...queue, entry]);
  return entry;
};

const removeEntry = (requestId: string) =>
  writeList(
    QUEUE_KEY,
    loadQueue().filter((entry) => entry.requestId !== requestId),
  );

const markAttempt = (requestId: string, error: string) =>
  writeList(
    QUEUE_KEY,
    loadQueue().map((entry) =>
      entry.requestId === requestId
        ? { ...entry, attempts: entry.attempts + 1, lastError: error }
        : entry,
    ),
  );

/** Gives an entry a new requestId in place, keeping its queue position. */
const reissueEntry = (entry: DiscoverQueuedRequest): DiscoverQueuedRequest => {
  const requestId = newRequestId();
  const next: DiscoverQueuedRequest = { ...entry, requestId, body: { ...entry.body, requestId } };
  writeList(
    QUEUE_KEY,
    loadQueue().map((item) => (item.requestId === entry.requestId ? next : item)),
  );
  return next;
};

const rememberRejected = (
  entry: DiscoverQueuedRequest,
  status: number,
  reason: DiscoverRejectReason,
) =>
  writeList(
    REJECTED_KEY,
    [
      {
        requestId: entry.requestId,
        title: entry.body.title,
        author: entry.body.author,
        want: entry.body.want,
        status,
        reason,
        rejectedAt: Date.now(),
      } satisfies RejectedRequest,
      ...loadRejected().filter((item) => item.requestId !== entry.requestId),
    ].slice(0, MAX_REJECTED),
  );

let inflight: Promise<FlushOutcome> | null = null;

const flushOnce = async (): Promise<FlushOutcome> => {
  const outcome: FlushOutcome = {
    jobs: [],
    sent: 0,
    dropped: 0,
    remaining: 0,
    held: null,
  };
  const queue = loadQueue();
  if (queue.length === 0) return outcome;
  const stop = (held: FlushHold) => ({
    ...outcome,
    held,
    remaining: loadQueue().length,
  });
  if (!isDeviceOnline()) return stop('offline');

  // With the VPN lane down the server would accept the request and fail it
  // at once, so the outbox keeps it until downloads can start.
  const providers = await discoverClient.providers();
  if (!providers.ok && providers.failure === 'offline') return stop('offline');
  if (providers.ok && providers.data.acquisition.state === 'vpn_down') return stop('vpn');

  for (const queued of queue) {
    let entry = queued;
    let result = await discoverClient.request(entry.body);
    if (!result.ok && result.status === 409) {
      // POST /requests answers 409 only when this requestId is already on
      // record for a different work or format. The entry itself is still a
      // real request, so it gets a fresh id and one more send. Books already
      // on the shelf come back as 202 with an on_shelf job, not 409.
      entry = reissueEntry(entry);
      result = await discoverClient.request(entry.body);
    }
    if (result.ok) {
      removeEntry(entry.requestId);
      outcome.jobs.push(...result.data.jobs);
      outcome.sent += 1;
      continue;
    }
    const { status, failure } = result;
    if (status !== null && status >= 400 && status < 500 && status !== 403 && status !== 408) {
      // Validation, or a second id conflict: sending the same body again can
      // never succeed, so it leaves the queue and the page says it was not sent.
      removeEntry(entry.requestId);
      rememberRejected(entry, status, result.reason ?? rejectReasonFor(status, null));
      outcome.dropped += 1;
      continue;
    }
    // Network down, off the tailnet, or a server fault: keep it and keep the
    // order, since everything behind it would hit the same wall.
    markAttempt(entry.requestId, failure);
    return stop(failure);
  }
  return { ...outcome, remaining: loadQueue().length };
};

/** Sends waiting requests in FIFO order. Concurrent callers share one pass. */
export const flushQueue = (): Promise<FlushOutcome> => {
  if (!inflight) {
    inflight = flushOnce().finally(() => {
      inflight = null;
    });
  }
  return inflight;
};

/**
 * Sends a request now, or queues it when the device is offline, the network
 * fails, or `holdForVpn` says downloads cannot start yet.
 */
export const submitRequest = async (
  body: DiscoverRequestBody,
  options: { holdForVpn?: boolean } = {},
): Promise<SubmitOutcome> => {
  const requestId =
    body.requestId && REQUEST_ID.test(body.requestId) ? body.requestId : newRequestId();
  let withId = { ...body, requestId };
  if (options.holdForVpn || !isDeviceOnline()) {
    return { outcome: 'queued', entry: enqueueRequest(withId) };
  }
  let result = await discoverClient.request(withId);
  if (!result.ok && result.status === 409) {
    // The id is already on record for another request: same fix as the queue.
    withId = { ...withId, requestId: newRequestId() };
    result = await discoverClient.request(withId);
  }
  if (result.ok) return { outcome: 'sent', jobs: result.data.jobs };
  if (result.failure === 'offline') return { outcome: 'queued', entry: enqueueRequest(withId) };
  return { outcome: 'failed', failure: result.failure };
};

/** Calls `listener` whenever the queue or the rejected list changes. */
export const subscribeQueue = (listener: () => void): (() => void) => {
  if (typeof window === 'undefined') return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key === QUEUE_KEY || event.key === REJECTED_KEY) listener();
  };
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener('storage', onStorage);
  };
};

/** Flushes whenever the window reports it is back online. */
export const startQueueAutoFlush = (onFlushed?: (outcome: FlushOutcome) => void) => {
  if (typeof window === 'undefined') return () => {};
  const onOnline = () => {
    void flushQueue().then((outcome) => onFlushed?.(outcome));
  };
  window.addEventListener('online', onOnline);
  return () => window.removeEventListener('online', onOnline);
};
