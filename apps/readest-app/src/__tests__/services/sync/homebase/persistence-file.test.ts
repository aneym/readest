import { describe, expect, it, vi } from 'vitest';

const nativeFiles = vi.hoisted(() => {
  const files = new Map<string, string>();
  let directoryExists = false;
  let readError: string | null = null;
  return {
    files,
    reset: () => {
      files.clear();
      directoryExists = false;
      readError = null;
    },
    failReads: (message: string | null) => {
      readError = message;
    },
    readTextFile: async (path: string) => {
      if (readError) throw new Error(readError);
      if (!directoryExists)
        throw new Error('The system cannot find the path specified. (os error 3)');
      const content = files.get(path);
      if (content === undefined)
        throw new Error('The system cannot find the file specified. (os error 2)');
      return content;
    },
    mkdir: async () => {
      directoryExists = true;
    },
    writeTextFile: async (path: string, content: string) => {
      if (!directoryExists)
        throw new Error('The system cannot find the path specified. (os error 3)');
      files.set(path, content);
    },
    rename: async (from: string, to: string) => {
      files.set(to, files.get(from)!);
      files.delete(from);
    },
  };
});

vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: nativeFiles.readTextFile,
  writeTextFile: nativeFiles.writeTextFile,
  mkdir: nativeFiles.mkdir,
  rename: nativeFiles.rename,
  remove: async (path: string) => {
    nativeFiles.files.delete(path);
  },
}));
vi.mock('@/services/environment', () => ({
  default: {
    getAppService: async () => ({
      resolveFilePath: async (path: string) => `C:/app/Data/${path}`,
    }),
  },
}));
import {
  createFileOutboxStore,
  createTauriOutboxFs,
  HOMEBASE_OUTBOX_STORAGE_KEY,
  type HomebaseStorage,
  type OutboxFs,
} from '@/services/sync/homebase/persistence';
import { createSyncOutbox, type OutboxEntry } from '@/services/sync/homebase/outbox';

const path = 'homebase/outbox.json';
const item = (key: string, revision = 1, queuedAt = 1): OutboxEntry => ({
  key: `notes:hash:${key}`,
  channel: 'notes',
  record: { id: key, book_hash: 'hash', updated_at: revision },
  queuedAt,
  attempts: 0,
  revision,
});

const fixture = () => {
  const files = new Map<string, string>();
  let failWrite = false;
  let failRename = false;
  const fs: OutboxFs = {
    readText: async (name) => files.get(name) ?? null,
    writeText: async (name, text) => {
      if (failWrite) throw new Error('disk full');
      files.set(name, text);
    },
    rename: async (from, to) => {
      if (failRename) throw new Error('interrupted rename');
      const value = files.get(from);
      if (value === undefined) throw new Error('missing source');
      files.set(to, value);
      files.delete(from);
    },
    remove: async (name) => {
      files.delete(name);
    },
  };
  const keys = new Map<string, string>();
  const legacy: HomebaseStorage = {
    getItem: (key) => keys.get(key) ?? null,
    setItem: (key, value) => {
      keys.set(key, value);
    },
    removeItem: (key) => {
      keys.delete(key);
    },
  };
  const store = () => createFileOutboxStore({ fs, legacy });
  return {
    files,
    fs,
    legacy,
    store,
    failWrite: (value: boolean) => {
      failWrite = value;
    },
    failRename: (value: boolean) => {
      failRename = value;
    },
  };
};

describe('Homebase file outbox durability', () => {
  it('queues on a fresh Windows install when the Data/homebase directory is absent', async () => {
    nativeFiles.reset();
    const fs = await createTauriOutboxFs();
    const store = createFileOutboxStore({ fs, legacy: null });
    expect(await store.read()).toEqual([]);
    await store.write([item('first')]);
    expect(await createFileOutboxStore({ fs, legacy: null }).read()).toEqual([item('first')]);
  });

  it.each([
    'Too many open files (os error 24)',
    'Too many open files in system (os error 23)',
    'Is a directory (os error 21)',
    'The process cannot access the file because it is being used by another process. (os error 32)',
    'Permission denied (os error 13)',
  ])('never treats a non-missing read error as an empty queue: %s', async (message) => {
    nativeFiles.reset();
    const fs = await createTauriOutboxFs();
    const outbox = createSyncOutbox({ store: createFileOutboxStore({ fs, legacy: null }) });
    await outbox.enqueue('notes', [{ id: 'queued', book_hash: 'hash', updated_at: 1 }]);
    nativeFiles.failReads(message);
    await expect(
      createSyncOutbox({ store: createFileOutboxStore({ fs, legacy: null }) }).enqueue('notes', [
        { id: 'next', book_hash: 'hash', updated_at: 2 },
      ]),
    ).rejects.toThrow(message);
    nativeFiles.failReads(null);
    const afterRestart = createSyncOutbox({ store: createFileOutboxStore({ fs, legacy: null }) });
    expect((await afterRestart.pending()).map(({ key }) => key)).toEqual(['notes:hash:queued']);
  });

  it('round trips across independent store instances', async () => {
    const { files, store } = fixture();
    await store().write([item('one')]);
    expect(await store().read()).toEqual([item('one')]);
    expect(JSON.parse(files.get(path)!)).toEqual([item('one')]);
  });

  it('keeps the previous complete queue after interruption before rename', async () => {
    const { files, store, failRename } = fixture();
    await store().write([item('old')]);
    failRename(true);
    await expect(store().write([item('new')])).rejects.toThrow('interrupted rename');
    expect(JSON.parse(files.get(path)!)).toEqual([item('old')]);
    failRename(false);
    expect(await store().read()).toEqual([item('old')]);
  });

  it('reads the new content after rename, even when the old writer disappears', async () => {
    const { store, files } = fixture();
    await store().write([item('old')]);
    await store().write([item('new')]);
    expect(files.has(`${path}.tmp`)).toBe(false);
    expect(await store().read()).toEqual([item('new')]);
  });

  it('migrates legacy only after durable write; preserves it on write failure', async () => {
    const { store, legacy, files, failWrite } = fixture();
    legacy.setItem(HOMEBASE_OUTBOX_STORAGE_KEY, JSON.stringify([item('legacy')]));
    failWrite(true);
    await expect(store().read()).rejects.toThrow('disk full');
    expect(legacy.getItem(HOMEBASE_OUTBOX_STORAGE_KEY)).not.toBeNull();
    expect(files.has(path)).toBe(false);
    failWrite(false);
    expect(await store().read()).toEqual([item('legacy')]);
    expect(legacy.getItem(HOMEBASE_OUTBOX_STORAGE_KEY)).toBeNull();
    expect(await store().read()).toEqual([item('legacy')]);
  });

  it('merges a crash-during-migration file and legacy by revision then queuedAt', async () => {
    const { store, files, legacy } = fixture();
    files.set(path, JSON.stringify([item('higher', 3, 1), item('later', 2, 3)]));
    legacy.setItem(
      HOMEBASE_OUTBOX_STORAGE_KEY,
      JSON.stringify([item('higher', 2, 10), item('later', 2, 4), item('only')]),
    );
    const merged = await store().read();
    expect(merged).toEqual([item('higher', 3, 1), item('later', 2, 4), item('only')]);
    expect(JSON.parse(files.get(path)!)).toEqual(merged);
    expect(legacy.getItem(HOMEBASE_OUTBOX_STORAGE_KEY)).toBeNull();
  });

  it('recovers valid tmp data while retaining corrupt main for recovery', async () => {
    const { files, store } = fixture();
    files.set(path, '{bad');
    files.set(`${path}.tmp`, JSON.stringify([item('recovered')]));
    expect(await store().read()).toEqual([item('recovered')]);
    expect(
      [...files].some(([name, value]) => name.startsWith(`${path}.corrupt-`) && value === '{bad'),
    ).toBe(true);
    expect(JSON.parse(files.get(path)!)).toEqual([item('recovered')]);
  });

  it('rejects corrupt main without tmp, and retains original bytes', async () => {
    const { files, store } = fixture();
    files.set(path, '{bad');
    await expect(store().read()).rejects.toThrow(
      'Stored sync queue is invalid; original data retained',
    );
    expect([...files.values()]).toContain('{bad');
    expect([...files.keys()].some((name) => name.startsWith(`${path}.corrupt-`))).toBe(true);
  });

  it('serializes 50 writes so the last issued state wins without tmp interleaving', async () => {
    const { files, store } = fixture();
    const outboxStore = store();
    await Promise.all(Array.from({ length: 50 }, (_, i) => outboxStore.write([item(String(i))])));
    expect(await store().read()).toEqual([item('49')]);
    expect(files.has(`${path}.tmp`)).toBe(false);
  });

  it.each([
    false,
    true,
  ])('recovers after an interrupted first tmp write (legacy: %s)', async (withLegacy) => {
    const { files, store, legacy } = fixture();
    files.set(`${path}.tmp`, '{partial');
    if (withLegacy) {
      legacy.setItem(HOMEBASE_OUTBOX_STORAGE_KEY, JSON.stringify([item('legacy')]));
    }
    const outbox = createSyncOutbox({ store: store() });
    await outbox.enqueue('notes', [{ id: 'new', book_hash: 'hash', updated_at: 1 }]);
    const afterRestart = createSyncOutbox({ store: store() });
    expect((await afterRestart.pending()).map(({ key }) => key)).toEqual(
      withLegacy ? ['notes:hash:legacy', 'notes:hash:new'] : ['notes:hash:new'],
    );
    if (withLegacy) expect(legacy.getItem(HOMEBASE_OUTBOX_STORAGE_KEY)).toBeNull();
  });

  it('survives a process restart after enqueueing offline through the real outbox', async () => {
    const { store } = fixture();
    const first = createSyncOutbox({ store: store() });
    await first.enqueue('notes', [
      { id: 'a', book_hash: 'hash', updated_at: 1 },
      { id: 'b', book_hash: 'hash', updated_at: 2 },
    ]);
    const afterRestart = createSyncOutbox({ store: store() });
    expect((await afterRestart.pending()).map(({ key }) => key)).toEqual([
      'notes:hash:a',
      'notes:hash:b',
    ]);
  });
});
