import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { isTauriAppPlatform } from '@/services/environment';
import { getHomebaseBaseUrl } from '@/services/sync/homebase/config';
import type {
  DiscoverBrowseResponse,
  DiscoverJobResponse,
  DiscoverJobsResponse,
  DiscoverProvidersResponse,
  DiscoverRequestBody,
  DiscoverRequestResponse,
  DiscoverSearchResponse,
  DiscoverWorkResponse,
} from './types';

/**
 * Client for Homebase's Books Discover API (`/api/books/discover/*`).
 *
 * Every call resolves to a result, never throws. Failures carry only a
 * category and the HTTP status: server bodies and URLs stay out of the UI.
 */

export type DiscoverFailure = 'offline' | 'forbidden' | 'unavailable' | 'error';

/**
 * Why Homebase refused a request it could read (a 4xx other than 403). The
 * server's message is matched against the validator's known wording and
 * reduced to one of these codes; the page words it, the raw text is dropped.
 */
export type DiscoverRejectReason =
  | 'title'
  | 'author'
  | 'format'
  | 'offer_expired'
  | 'id_conflict'
  | 'too_large'
  | 'unreadable';

export type DiscoverResult<T> =
  | { ok: true; status: number; data: T }
  | {
      ok: false;
      failure: DiscoverFailure;
      status: number | null;
      /** Present only for a refused request (400, 409, 413, 415, 422). */
      reason?: DiscoverRejectReason;
    };

export type DiscoverSearchKind = 'all' | 'ebook' | 'audiobook';

export const DISCOVER_TIMEOUT_MS = 10_000;

/**
 * The server's mutation guard only accepts POSTs from loopback or the tailnet
 * host. A native client has no browser origin of its own, so it names the
 * tailnet host explicitly (tauri-plugin-http is built with `unsafe-headers`).
 * Browsers drop a script-set Origin and send their own.
 */
export const DISCOVER_POST_ORIGIN = 'https://studio.tailf266ac.ts.net';

const BASE_PATH = '/api/books/discover';

export const isDeviceOnline = (): boolean =>
  typeof navigator === 'undefined' || navigator.onLine !== false;

const discoverOrigin = (): string | null => {
  const base = getHomebaseBaseUrl();
  if (!base) return null;
  try {
    return new URL(base).origin;
  } catch {
    return null;
  }
};

const classifyStatus = (status: number): DiscoverFailure => {
  if (status === 403) return 'forbidden';
  if (status === 503) return 'unavailable';
  return 'error';
};

const REJECT_STATUSES = new Set([400, 409, 413, 415, 422]);

/** Server validator wording (server/books-discovery/api.ts, service.ts) to a code. */
const REJECT_PATTERNS: [RegExp, DiscoverRejectReason][] = [
  [/^Invalid title$/, 'title'],
  [/^Invalid author$/, 'author'],
  [/^Invalid want$|OfferId does not match want$/, 'format'],
  [/^Offer is unknown or expired|^Offer does not belong to|^Invalid \w+OfferId$/, 'offer_expired'],
  [/^requestId /, 'id_conflict'],
  [/^Body too large$/, 'too_large'],
];

export const rejectReasonFor = (status: number, message: unknown): DiscoverRejectReason => {
  if (typeof message === 'string') {
    for (const [pattern, reason] of REJECT_PATTERNS) if (pattern.test(message)) return reason;
  }
  if (status === 409) return 'id_conflict';
  if (status === 413) return 'too_large';
  return 'unreadable';
};

const readRejectReason = async (response: Response): Promise<DiscoverRejectReason> => {
  let message: unknown = null;
  try {
    const body: unknown = await response.json();
    if (body && typeof body === 'object') message = (body as { error?: unknown }).error;
  } catch {
    // No JSON body: fall back to what the status alone says.
  }
  return rejectReasonFor(response.status, message);
};

const call = async <T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<DiscoverResult<T>> => {
  if (!isDeviceOnline()) return { ok: false, failure: 'offline', status: null };
  const origin = discoverOrigin();
  if (!origin) return { ok: false, failure: 'unavailable', status: null };

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method === 'POST') {
    headers['Content-Type'] = 'application/json';
    headers['X-Homebase-Media-Action'] = '1';
    headers['Origin'] = DISCOVER_POST_ORIGIN;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCOVER_TIMEOUT_MS);
  const fetchImpl = isTauriAppPlatform() ? tauriFetch : globalThis.fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${origin}${BASE_PATH}${path}`, {
      method,
      headers,
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
      signal: controller.signal,
    });
  } catch {
    // Network failure, DNS, TLS, or our own timeout abort: all mean Homebase
    // is out of reach from here right now.
    clearTimeout(timer);
    return { ok: false, failure: 'offline', status: null };
  }

  try {
    if (!response.ok) {
      const failure = classifyStatus(response.status);
      if (REJECT_STATUSES.has(response.status)) {
        const reason = await readRejectReason(response);
        return { ok: false, failure, status: response.status, reason };
      }
      return { ok: false, failure, status: response.status };
    }
    const data = (await response.json()) as T;
    return { ok: true, status: response.status, data };
  } catch {
    // Aborted mid-body reads as a network failure; a body that is not JSON is
    // a server fault.
    if (controller.signal.aborted) return { ok: false, failure: 'offline', status: null };
    return { ok: false, failure: 'error', status: response.status };
  } finally {
    clearTimeout(timer);
  }
};

const query = (params: Record<string, string | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, value);
  }
  return search.toString();
};

export const discoverClient = {
  browse: () => call<DiscoverBrowseResponse>('GET', '/browse'),
  providers: () => call<DiscoverProvidersResponse>('GET', '/providers'),
  search: (q: string, kind: DiscoverSearchKind = 'all') =>
    call<DiscoverSearchResponse>('GET', `/search?${query({ q: q.trim(), kind })}`),
  work: (lookup: { key: string } | { title: string; author?: string }) =>
    call<DiscoverWorkResponse>(
      'GET',
      `/work?${query('key' in lookup ? { key: lookup.key } : { title: lookup.title, author: lookup.author })}`,
    ),
  jobs: () => call<DiscoverJobsResponse>('GET', '/jobs?active=1'),
  request: (body: DiscoverRequestBody) => call<DiscoverRequestResponse>('POST', '/requests', body),
  retry: (jobId: string) =>
    call<DiscoverJobResponse>('POST', `/jobs/${encodeURIComponent(jobId)}/retry`),
  cancel: (jobId: string) =>
    call<DiscoverJobResponse>('POST', `/jobs/${encodeURIComponent(jobId)}/cancel`),
};
