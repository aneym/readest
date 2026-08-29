import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, test, vi } from 'vitest';
import { KOSyncClient } from '@/services/sync/KOSyncClient';
import { createMemoryHomebaseAdapter } from '@/services/sync/homebase/memoryAdapter';
import { HomebaseSyncClient } from '@/services/sync/homebase/recordSyncClient';
import type { Book } from '@/types/book';
import type { KOSyncSettings } from '@/types/settings';
import type { SyncData } from '@/libs/sync';

/**
 * The fork charter keeps KOSync carrying KOReader-compatible progress whatever
 * happens to the record channels. This file holds that line: it is easy to
 * "unify progress sync" during a Homebase migration and quietly break every
 * KOReader device in the house.
 *
 * Two claims, both checkable:
 *   1. The two stacks share no code. Asserted against the source import graph,
 *      because a shared import is how the coupling would actually creep in.
 *   2. They share no transport at runtime. Asserted by driving both with
 *      independent mocks and watching neither touch the other.
 */

const read = (rel: string) => readFileSync(resolve(process.cwd(), 'src', rel), 'utf-8');

/**
 * Import specifiers only. Prose mentions of the other stack are fine — a comment
 * saying "KOSync is untouched" is the opposite of coupling — so the assertions
 * below look at what the module actually pulls in.
 */
const importsOf = (source: string): string[] =>
  [...source.matchAll(/(?:from|import)\s+'([^']+)'/g)].map((m) => m[1] as string);

const SETTINGS: KOSyncSettings = {
  enabled: true,
  serverUrl: 'https://kosync.lan',
  username: 'reader',
  userkey: 'key',
  deviceId: 'device-1',
  deviceName: 'Studio',
  checksumMethod: 'binary',
  strategy: 'prompt',
};

const BOOK = {
  hash: 'abcdef0123456789',
  title: 'Piranesi',
  author: 'Susanna Clarke',
  format: 'EPUB',
} as unknown as Book;

describe('source-level isolation', () => {
  test('KOSyncClient imports nothing from libs/sync or the Homebase adapter', () => {
    const imports = importsOf(read('services/sync/KOSyncClient.ts'));
    expect(imports).not.toContain('@/libs/sync');
    expect(imports.filter((s) => s.includes('sync/homebase'))).toEqual([]);
  });

  test('the Homebase adapter imports nothing from KOSync', () => {
    for (const file of [
      'services/sync/homebase/recordSyncClient.ts',
      'services/sync/homebase/httpAdapter.ts',
      'services/sync/homebase/wire.ts',
      'services/sync/homebase/index.ts',
    ]) {
      expect(importsOf(read(file)).filter((s) => s.includes('KOSync'))).toEqual([]);
    }
  });

  test('SyncContext holds only the record client, so swapping it cannot reach KOSync', () => {
    // The one-line landing edit touches this file. If KOSync were wired through
    // the same context, that edit would no longer be safe on its own.
    const source = read('context/SyncContext.tsx');
    expect(source).not.toContain('KOSync');
    // The record backend is selected here without adding KOSync to the context.
    expect(source).toContain('const syncClient = resolveRecordSyncClient();');
  });
});

describe('runtime isolation', () => {
  test('a KOSync progress push does not go near the Homebase adapter', async () => {
    const homebase = createMemoryHomebaseAdapter();
    const push = vi.spyOn(homebase, 'push');

    const koFetch = vi.fn(
      async () => new Response(JSON.stringify({ document: 'x' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', koFetch);

    const ko = new KOSyncClient(SETTINGS);
    await ko.updateProgress(BOOK, '/body/DocFragment[3]', 42);

    expect(koFetch).toHaveBeenCalled();
    const [url] = koFetch.mock.calls[0] as unknown as [string];
    expect(String(url)).toContain('kosync.lan');
    expect(push).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  test('a Homebase record push does not go near the KOSync server', async () => {
    const koFetch = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', koFetch);

    const client = new HomebaseSyncClient({ adapter: createMemoryHomebaseAdapter() });
    await client.pushChanges({
      configs: [{ bookHash: 'a', xpointer: '/body/DocFragment[3]', updatedAt: 1 }],
    } as unknown as SyncData);

    // The memory adapter is in-process; nothing should have hit the network,
    // and certainly not the KOSync host.
    expect(koFetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  test('the KOReader document digest is unchanged by the record backend', () => {
    // KOSync addresses a document by the book's partialMD5. Homebase keys rows
    // by the same hash, which is why both can coexist — but the digest must
    // come from KOSyncClient's own rule, not from a synced field.
    const ko = new KOSyncClient(SETTINGS);
    const before = ko.getDocumentDigest(BOOK);
    const after = new KOSyncClient({
      ...SETTINGS,
      serverUrl: 'https://other.lan',
    }).getDocumentDigest(BOOK);
    expect(before).toBe(after);
    expect(before).toBeTruthy();
  });
});
