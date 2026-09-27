import { getHomebaseBaseUrl, isHomebaseSyncEnabled } from '@/services/sync/homebase/config';
import type { HalfState, PairState, RequestRecord, RequestWant, SearchResult } from './types';

export class ImmersionApiError extends Error {
  status: number;
  code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'ImmersionApiError';
    this.status = status;
    this.code = code;
  }
}

export interface ImmersionClient {
  search(query: string, signal?: AbortSignal): Promise<SearchResult[]>;
  createRequest(input: {
    title: string;
    author: string;
    isbn?: string;
    want: RequestWant;
  }): Promise<RequestRecord>;
  listRequests(signal?: AbortSignal): Promise<RequestRecord[]>;
  status(signal?: AbortSignal): Promise<Record<string, PairState>>;
  confirmPair(pairId: string): Promise<PairState>;
  realignPair(pairId: string): Promise<PairState>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const halfNames = ['have', 'missing', 'requested', 'acquiring', 'failed'];
const pairNames = ['none', 'candidate', 'queued', 'aligning', 'ready-to-swap', 'aligned', 'failed'];
const stages = [
  'staging',
  'importing',
  'transcribing',
  'syncing',
  'downloading',
  'validating',
  'swapping',
  'done',
];
const wants = ['ebook', 'audiobook', 'pair'];
const optionalString = (row: Record<string, unknown>, key: string) =>
  row[key] === undefined || isString(row[key]);

const isHalfState = (value: unknown): value is HalfState =>
  isObject(value) &&
  halfNames.includes(value['state'] as string) &&
  optionalString(value, 'id') &&
  optionalString(value, 'detail');
const isPairState = (value: unknown): value is PairState =>
  isObject(value) &&
  pairNames.includes(value['state'] as string) &&
  optionalString(value, 'pairId') &&
  optionalString(value, 'error') &&
  (value['progress'] === undefined ||
    (typeof value['progress'] === 'number' &&
      Number.isFinite(value['progress']) &&
      value['progress'] >= 0 &&
      value['progress'] <= 1)) &&
  (value['stage'] === undefined || stages.includes(value['stage'] as string));
const isSearchResult = (value: unknown): value is SearchResult =>
  isObject(value) &&
  isString(value['key']) &&
  isString(value['title']) &&
  isString(value['author']) &&
  (value['year'] === undefined ||
    (typeof value['year'] === 'number' && Number.isFinite(value['year']))) &&
  optionalString(value, 'coverUrl') &&
  optionalString(value, 'isbn') &&
  isHalfState(value['ebook']) &&
  isHalfState(value['audiobook']) &&
  isPairState(value['pair']);
const isRequestRecord = (value: unknown): value is RequestRecord =>
  isObject(value) &&
  isString(value['id']) &&
  isString(value['profileId']) &&
  isString(value['deviceId']) &&
  isString(value['title']) &&
  isString(value['author']) &&
  optionalString(value, 'isbn') &&
  wants.includes(value['want'] as string) &&
  isHalfState(value['ebook']) &&
  isHalfState(value['audiobook']) &&
  isPairState(value['pair']) &&
  typeof value['createdAt'] === 'number' &&
  Number.isFinite(value['createdAt']) &&
  typeof value['updatedAt'] === 'number' &&
  Number.isFinite(value['updatedAt']);

const validRows = <T>(value: unknown, guard: (row: unknown) => row is T): T[] =>
  Array.isArray(value) ? value.filter(guard) : [];

export function createImmersionClient(
  opts: {
    baseUrl?: string | null;
    token?: string | null;
    fetch?: typeof fetch;
    timeoutMs?: number;
  } = {},
): ImmersionClient | null {
  if (opts.baseUrl === undefined && opts.token === undefined && !isHomebaseSyncEnabled())
    return null;
  const rawBase = opts.baseUrl === undefined ? getHomebaseBaseUrl() : opts.baseUrl;
  const token =
    opts.token === undefined
      ? typeof localStorage === 'undefined'
        ? null
        : localStorage.getItem('token')
      : opts.token;
  if (!rawBase?.trim() || !token?.trim()) return null;
  // Homebase config already includes /api/readest, just as the sync adapter expects.
  const base = `${rawBase.trim().replace(/\/+$/, '')}/immersion`;
  const fetchImpl = opts.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const timeoutMs = opts.timeoutMs ?? 15_000;

  const request = async (
    path: string,
    init: RequestInit = {},
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> => {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    if (signal && !('any' in AbortSignal)) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${base}/${path}`, {
        ...init,
        signal:
          signal && 'any' in AbortSignal
            ? AbortSignal.any([signal, controller.signal])
            : controller.signal,
        headers: {
          Accept: 'application/json',
          ...(init.method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
          Authorization: `Bearer ${token}`,
        },
      });
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch (error) {
        if (controller.signal.aborted || signal?.aborted) throw error;
        parsed = null;
      }
      const body = isObject(parsed) ? parsed : {};
      if (!response.ok || body['ok'] === false) {
        const rawMessage = isString(body['error'])
          ? body['error']
          : response.statusText || `HTTP ${response.status}`;
        // A server error must never leak the paired credential, even if it echoes input.
        const message = rawMessage.split(token).join('[redacted]');
        throw new ImmersionApiError(
          response.status,
          message,
          isString(body['code']) ? body['code'] : undefined,
        );
      }
      if (body['ok'] !== true) {
        throw new ImmersionApiError(response.status, 'Invalid immersion response', 'bad_response');
      }
      return body;
    } catch (error) {
      if (error instanceof ImmersionApiError) throw error;
      if (signal?.aborted) throw error;
      if (controller.signal.aborted) {
        throw new ImmersionApiError(0, 'Immersion request timed out', 'timeout');
      }
      throw new ImmersionApiError(0, 'Immersion network request failed', 'network');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  };

  const updatePair = async (pairId: string, action: 'confirm' | 'realign'): Promise<PairState> => {
    const body = await request(`pairs/${encodeURIComponent(pairId)}/${action}`, {
      method: 'POST',
      body: '{}',
    });
    if (!isPairState(body['pair'])) {
      throw new ImmersionApiError(200, 'Invalid pair response', 'bad_response');
    }
    return body['pair'];
  };

  return {
    async search(query, signal) {
      const trimmed = query.trim();
      if (!trimmed) return [];
      const body = await request(`search?q=${encodeURIComponent(trimmed)}`, {}, signal);
      return validRows(body['results'], isSearchResult);
    },
    async createRequest(input) {
      const body = await request('requests', { method: 'POST', body: JSON.stringify(input) });
      if (!isRequestRecord(body['request']))
        throw new ImmersionApiError(200, 'Invalid request response', 'bad_response');
      return body['request'];
    },
    async listRequests(signal) {
      const body = await request('requests', {}, signal);
      return validRows(body['requests'], isRequestRecord);
    },
    async status(signal) {
      const body = await request('status', {}, signal);
      if (!isObject(body['books'])) return {};
      return Object.fromEntries(
        Object.entries(body['books']).filter((entry): entry is [string, PairState] =>
          isPairState(entry[1]),
        ),
      );
    },
    confirmPair(pairId) {
      return updatePair(pairId, 'confirm');
    },
    realignPair(pairId) {
      return updatePair(pairId, 'realign');
    },
  };
}
