import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { createMemoryOutboxStore, createSyncOutbox } from '@/services/sync/homebase/outbox';
import { HomebaseSyncClient } from '@/services/sync/homebase/recordSyncClient';
import { HomebaseSyncError } from '@/services/sync/homebase/adapter';

const mock = vi.hoisted(() => ({
  client: null as HomebaseSyncClient | null,
  flush: vi.fn<() => Promise<unknown>>(async () => null),
}));
vi.mock('@/services/sync/homebase', () => ({
  resolveRecordSyncClient: () => ({ flushOutbox: () => mock.flush() }),
}));

import { SyncProvider } from '@/context/SyncContext';

afterEach(() => {
  cleanup();
  mock.client = null;
  mock.flush.mockReset();
});

test('startup drains durable rows; reconnect retries without a manual Sync', async () => {
  const box = createSyncOutbox({ store: createMemoryOutboxStore() });
  await box.enqueue('notes', [{ book_hash: 'book', id: 'n1', updated_at: 1 }]);
  let online = false;
  const push = vi.fn(async () => {
    if (!online) throw new HomebaseSyncError('offline', 'NETWORK');
    return {};
  });
  mock.client = new HomebaseSyncClient({
    outbox: box,
    adapter: {
      endpointId: 'fixture',
      capabilities: async () => null,
      pull: async () => ({}),
      push,
    },
  });
  mock.flush.mockImplementation(() => mock.client!.flushOutbox());
  const mounted = render(<SyncProvider>Reader</SyncProvider>);
  await waitFor(async () => expect((await box.pending())[0]?.attempts).toBe(1));
  online = true;
  window.dispatchEvent(new Event('online'));
  await waitFor(async () => expect(await box.pending()).toHaveLength(0));
  expect(push).toHaveBeenCalledTimes(2);
  mounted.unmount();
  window.dispatchEvent(new Event('online'));
  expect(push).toHaveBeenCalledTimes(2);
});

test('visible resume drains and teardown removes visibility listener', async () => {
  const box = createSyncOutbox({ store: createMemoryOutboxStore() });
  const push = vi.fn(async () => ({}));
  mock.client = new HomebaseSyncClient({
    outbox: box,
    adapter: {
      endpointId: 'fixture',
      capabilities: async () => null,
      pull: async () => ({}),
      push,
    },
  });
  mock.flush.mockImplementation(() => mock.client!.flushOutbox());
  const mounted = render(<SyncProvider>Reader</SyncProvider>);
  await waitFor(() => expect(mock.flush).toHaveBeenCalledTimes(1));
  await box.enqueue('notes', [{ book_hash: 'book', id: 'n1', updated_at: 1 }]);
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  document.dispatchEvent(new Event('visibilitychange'));
  await waitFor(async () => expect(await box.pending()).toHaveLength(0));
  expect(push).toHaveBeenCalledTimes(1);
  mounted.unmount();
  await box.enqueue('notes', [{ book_hash: 'book', id: 'n2', updated_at: 1 }]);
  document.dispatchEvent(new Event('visibilitychange'));
  expect(await box.pending()).toHaveLength(1);
  visibility.mockRestore();
});
