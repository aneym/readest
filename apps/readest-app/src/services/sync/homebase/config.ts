import { getRuntimeConfig } from '@/services/runtimeConfig';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace NodeJS {
    interface ProcessEnv {
      HOMEBASE_API_BASE_URL?: string;
      NEXT_PUBLIC_HOMEBASE_API_BASE_URL?: string;
      HOMEBASE_SYNC_ENABLED?: string;
      NEXT_PUBLIC_HOMEBASE_SYNC_ENABLED?: string;
    }
  }
}

const runtime = () => getRuntimeConfig() ?? {};

const trimSlash = (url: string) => url.replace(/\/+$/, '');

export const getHomebaseBaseUrl = (): string | null => {
  const raw =
    runtime().homebaseApiBaseUrl ||
    process.env.HOMEBASE_API_BASE_URL ||
    process.env.NEXT_PUBLIC_HOMEBASE_API_BASE_URL ||
    '';
  return raw ? trimSlash(raw) : null;
};

export const isHomebaseSyncEnabled = (): boolean => {
  if (!getHomebaseBaseUrl()) return false;
  if (runtime().homebaseSyncEnabled === true) return true;
  const flag = process.env.HOMEBASE_SYNC_ENABLED ?? process.env.NEXT_PUBLIC_HOMEBASE_SYNC_ENABLED;
  return flag === '1' || flag === 'true';
};

export const DEFAULT_HOMEBASE_SYNC_PATH = '/reader/sync';
export const DEFAULT_HOMEBASE_STORAGE_PATH = '/reader/storage';

const readPairedToken = (): string =>
  typeof localStorage !== 'undefined' ? (localStorage.getItem('token') ?? '') : '';

export const resolveHomebaseCoverUrl = async (bookHash: string): Promise<string | null> => {
  const base = getHomebaseBaseUrl();
  if (!base || !bookHash) return null;
  try {
    const response = await fetch(
      `${base}${DEFAULT_HOMEBASE_SYNC_PATH}?since=0&type=books&book=${encodeURIComponent(bookHash)}`,
      { headers: { Authorization: `Bearer ${readPairedToken()}` } },
    );
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      books?: { hash?: string; book_hash?: string; coverImageUrl?: string }[];
    };
    const row = (payload.books ?? []).find(
      (book) => book.hash === bookHash || book.book_hash === bookHash,
    );
    return row?.coverImageUrl ?? null;
  } catch {
    return null;
  }
};
