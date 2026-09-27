import type { DiscoverBrowseResponse, DiscoverWorkResponse } from './types';

/**
 * Last-known Discover data, so the page has something true to show offline.
 * localStorage can be missing, full or denied; every access is guarded and a
 * failure just means no cache.
 */

const BROWSE_KEY = 'household.discover.browse';
const WORKS_KEY = 'household.discover.works';
export const MAX_CACHED_WORKS = 10;

export interface CachedBrowse {
  savedAt: number;
  /** Server time the shelves were generated, copied from the response. */
  generatedAt: number;
  data: DiscoverBrowseResponse;
}

export interface CachedWork {
  key: string;
  savedAt: number;
  data: DiscoverWorkResponse;
}

const read = <T>(key: string): T | null => {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
};

const write = (key: string, value: unknown): void => {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    // Quota or denied storage: the page still works online.
  }
};

export const saveBrowse = (data: DiscoverBrowseResponse, now = Date.now()): void => {
  write(BROWSE_KEY, {
    savedAt: now,
    generatedAt: data.generatedAt,
    data,
  } satisfies CachedBrowse);
};

export const loadBrowse = (): CachedBrowse | null => {
  const cached = read<CachedBrowse>(BROWSE_KEY);
  return cached && Array.isArray(cached.data?.shelves) ? cached : null;
};

const loadWorks = (): CachedWork[] => {
  const works = read<CachedWork[]>(WORKS_KEY);
  return Array.isArray(works) ? works : [];
};

/**
 * Keeps the ten most recently fetched works. `key` is the work key the page
 * asked about; the response's own key is stored too when it differs, so a
 * later lookup by either finds it.
 */
export const saveWork = (key: string, data: DiscoverWorkResponse, now = Date.now()): void => {
  const keys = new Set([key, data.work.key]);
  const rest = loadWorks().filter((entry) => !keys.has(entry.key));
  write(WORKS_KEY, [{ key, savedAt: now, data }, ...rest].slice(0, MAX_CACHED_WORKS));
};

export const loadWork = (key: string): CachedWork | null =>
  loadWorks().find((entry) => entry.key === key || entry.data?.work?.key === key) ?? null;
