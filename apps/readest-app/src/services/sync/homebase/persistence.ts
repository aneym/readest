import type { OutboxEntry, OutboxStore } from './outbox';
import environmentConfig from '@/services/environment';

export const HOMEBASE_OUTBOX_STORAGE_KEY = 'readest-homebase-outbox';
export const HOMEBASE_CLIENT_ID_STORAGE_KEY = 'readest-homebase-client-id';

export interface HomebaseStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

const browserStorage = (): HomebaseStorage | null =>
  typeof localStorage === 'undefined' ? null : localStorage;

export const createPersistentOutboxStore = (
  storage: HomebaseStorage | null = browserStorage(),
): OutboxStore => ({
  async read() {
    const raw = storage?.getItem(HOMEBASE_OUTBOX_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed))
      throw new Error('Stored sync queue is invalid; original data retained');
    return parsed as OutboxEntry[];
  },
  async write(entries) {
    if (!storage) throw new Error('Sync queue storage unavailable');
    storage.setItem(HOMEBASE_OUTBOX_STORAGE_KEY, JSON.stringify(entries));
  },
});

export interface OutboxFs {
  readText(path: string): Promise<string | null>;
  writeText(path: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}

/** File paths exposed by OutboxFs are relative to the app's Data directory. */
export const createTauriOutboxFs = async (): Promise<OutboxFs> => {
  const [fs, appService] = await Promise.all([
    import('@tauri-apps/plugin-fs'),
    environmentConfig.getAppService(),
  ]);
  const resolve = (path: string) => appService.resolveFilePath(path, 'Data');
  return {
    async readText(path) {
      try {
        return await fs.readTextFile(await resolve(path));
      } catch (error) {
        // Missing is distinct from access/IO errors: never treat a permission
        // failure as an empty queue and subsequently overwrite the original.
        const text = String(error);
        // Anchor the OS error number: "(os error 2)" / "(os error 3)" only, so
        // EMFILE (24), ENFILE (23), EISDIR (21) or a sharing violation (32)
        // throw instead of reading as a missing (empty) queue.
        if (
          /not found|no such file|ENOENT|\(os error [23]\)|cannot find the (path|file)/i.test(text)
        )
          return null;
        throw error;
      }
    },
    async writeText(path, text) {
      const target = await resolve(path);
      const parent = target.slice(0, target.lastIndexOf('/'));
      await fs.mkdir(parent, { recursive: true });
      await fs.writeTextFile(target, text);
    },
    async rename(from, to) {
      await fs.rename(await resolve(from), await resolve(to));
    },
    async remove(path) {
      await fs.remove(await resolve(path));
    },
  };
};

const invalidQueue = () => new Error('Stored sync queue is invalid; original data retained');
const parseEntries = (text: string | null): OutboxEntry[] | null => {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as OutboxEntry[]) : null;
  } catch {
    return null;
  }
};

const mergeEntries = (file: OutboxEntry[], legacy: OutboxEntry[]): OutboxEntry[] => {
  const byKey = new Map(file.map((entry) => [entry.key, entry]));
  for (const entry of legacy) {
    const previous = byKey.get(entry.key);
    if (
      !previous ||
      (entry.revision ?? 0) > (previous.revision ?? 0) ||
      ((entry.revision ?? 0) === (previous.revision ?? 0) && entry.queuedAt > previous.queuedAt)
    ) {
      byKey.set(entry.key, entry);
    }
  }
  return [...byKey.values()];
};

export const createFileOutboxStore = (opts: {
  fs: OutboxFs;
  legacy?: HomebaseStorage | null;
  path?: string;
}): OutboxStore => {
  const { fs, path = 'homebase/outbox.json', legacy = browserStorage() } = opts;
  const tmp = `${path}.tmp`;
  let chain: Promise<unknown> = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = chain.then(operation, operation);
    chain = next.catch(() => undefined);
    return next;
  };
  const persist = async (entries: OutboxEntry[]) => {
    await fs.writeText(tmp, JSON.stringify(entries));
    await fs.rename(tmp, path);
  };
  const read = async (): Promise<OutboxEntry[]> => {
    const mainText = await fs.readText(path);
    let entries = parseEntries(mainText);
    if (!entries) {
      const tmpText = await fs.readText(tmp);
      entries = parseEntries(tmpText);
      if (entries) {
        // Keep an invalid main for recovery even when the tmp is usable.
        if (mainText !== null) await fs.rename(path, `${path}.corrupt-${Date.now()}`);
        await fs.rename(tmp, path);
      } else if (mainText !== null) {
        // An invalid main may hold acknowledged data, so retain it and refuse
        // to overwrite it. A lone invalid tmp is an interrupted first write;
        // ignore it so the next enqueue or legacy migration can proceed.
        await fs.writeText(`${path}.corrupt-${Date.now()}`, mainText);
        throw invalidQueue();
      }
    }
    const legacyText = legacy?.getItem(HOMEBASE_OUTBOX_STORAGE_KEY);
    const legacyEntries = legacyText ? parseEntries(legacyText) : null;
    if (legacyText && !legacyEntries) throw invalidQueue();
    if (legacyEntries?.length) {
      const merged = mergeEntries(entries ?? [], legacyEntries);
      await persist(merged);
      legacy?.removeItem?.(HOMEBASE_OUTBOX_STORAGE_KEY);
      return merged;
    }
    if (legacyText) legacy?.removeItem?.(HOMEBASE_OUTBOX_STORAGE_KEY);
    return entries ?? [];
  };
  return {
    read: () => serialize(read),
    write: (entries) =>
      serialize(async () => {
        // A direct write before the first read must not discard legacy rows
        // omitted from the new snapshot. Normal post-migration writes replace it.
        const hasLegacy = Boolean(legacy?.getItem(HOMEBASE_OUTBOX_STORAGE_KEY));
        const existing = await read();
        await persist(hasLegacy ? mergeEntries(existing, entries) : entries);
      }),
  };
};

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
