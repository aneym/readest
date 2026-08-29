import type { OutboxEntry, OutboxStore } from './outbox';

export const HOMEBASE_OUTBOX_STORAGE_KEY = 'readest-homebase-outbox';
export const HOMEBASE_CLIENT_ID_STORAGE_KEY = 'readest-homebase-client-id';

export interface HomebaseStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const browserStorage = (): HomebaseStorage | null =>
  typeof localStorage === 'undefined' ? null : localStorage;

export const createPersistentOutboxStore = (
  storage: HomebaseStorage | null = browserStorage(),
): OutboxStore => ({
  async read() {
    const raw = storage?.getItem(HOMEBASE_OUTBOX_STORAGE_KEY);
    if (!raw) return [];
    try {
      return JSON.parse(raw) as OutboxEntry[];
    } catch {
      return [];
    }
  },
  async write(entries) {
    storage?.setItem(HOMEBASE_OUTBOX_STORAGE_KEY, JSON.stringify(entries));
  },
});

export const getOrCreateHomebaseClientId = (
  storage: HomebaseStorage | null = browserStorage(),
): string => {
  const existing = storage?.getItem(HOMEBASE_CLIENT_ID_STORAGE_KEY);
  if (existing) return existing;
  const clientId = crypto.randomUUID();
  storage?.setItem(HOMEBASE_CLIENT_ID_STORAGE_KEY, clientId);
  return clientId;
};

export const getHomebaseToken = async (
  storage: HomebaseStorage | null = browserStorage(),
): Promise<string | null> => storage?.getItem('token') ?? null;
