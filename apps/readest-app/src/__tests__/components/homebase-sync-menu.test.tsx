import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import HomebaseSyncMenu from '@/components/HomebaseSyncMenu';
import { HomebaseSyncClient } from '@/services/sync/homebase/recordSyncClient';
import { createSyncOutbox, createMemoryOutboxStore } from '@/services/sync/homebase/outbox';
import { HomebaseSyncError } from '@/services/sync/homebase/adapter';
import {
  PRIVATE_SERVER_UNAVAILABLE,
  useHomebaseSyncStatus,
} from '@/services/sync/homebase/syncStatus';

const context = vi.hoisted(() => ({ client: {} as object }));
vi.mock('@/context/SyncContext', () => ({
  useSyncContext: () => ({ syncClient: context.client }),
}));
vi.mock('@/services/sync/homebase/config', () => ({ isHomebaseSyncEnabled: () => true }));
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (text: string, args?: Record<string, unknown>) =>
    text.replace(/{{(\w+)}}/g, (_, key) => String(args?.[key] ?? key)),
}));

beforeEach(() => {
  localStorage.clear();
  useHomebaseSyncStatus.setState({
    active: 0,
    pending: 0,
    retrying: 0,
    authPaused: 0,
    rejectedCount: 0,
    rejectedReasons: [],
    blocked: 0,
    lastSuccessAt: null,
    error: null,
  });
});
afterEach(cleanup);

describe('actual sync request receipts and menu', () => {
  it('shows running, prevents duplicate clicks, flushes before refresh and records successful empty deltas', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const order: string[] = [];
    const client = new HomebaseSyncClient({
      adapter: {
        endpointId: 'fixture',
        capabilities: async () => null,
        pull: async () => {
          order.push('pull');
          await gate;
          return {};
        },
        push: async () => ({}),
      },
    });
    context.client = {
      flushOutbox: async () => {
        order.push('flush');
        return null;
      },
    };
    const onSync = vi.fn(() => client.pullChanges(0));
    render(<HomebaseSyncMenu onSync={onSync} />);
    expect(screen.getByText(/not yet recorded/)).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sync now' }));
    await waitFor(() => expect(order).toEqual(['flush', 'pull']));
    expect(screen.getByRole('menuitem').hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('menuitem'));
    expect(onSync).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Sync now' })).toBeTruthy());
    expect(useHomebaseSyncStatus.getState().lastSuccessAt).toBeGreaterThan(0);
    expect(localStorage.getItem('readest-homebase-last-successful-sync')).toBeTruthy();
  });
  it('keeps failed offline pushes pending without inventing a successful sync or claiming VPN is off', async () => {
    const box = createSyncOutbox({ store: createMemoryOutboxStore() });
    const client = new HomebaseSyncClient({
      outbox: box,
      adapter: {
        endpointId: 'fixture',
        capabilities: async () => null,
        pull: async () => ({}),
        push: async () => {
          throw new HomebaseSyncError('Failed to fetch', 'NETWORK');
        },
      },
    });
    await client.pushChanges({
      notes: [{ id: 'note', bookHash: 'book', note: 'keep offline', updatedAt: 1 }],
    });
    context.client = client;
    const onSync = vi.fn();
    render(<HomebaseSyncMenu onSync={onSync} />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sync now' }));
    await waitFor(() => expect(screen.getByText('1 pending changes')).toBeTruthy());
    expect(screen.getByText(PRIVATE_SERVER_UNAVAILABLE)).toBeTruthy();
    expect(onSync).not.toHaveBeenCalled();
    expect(useHomebaseSyncStatus.getState().lastSuccessAt).toBeNull();
    expect((await box.pending())[0]?.record).toMatchObject({ note: 'keep offline' });
    expect(screen.getByText(/not yet recorded/)).toBeTruthy();
  });
  it('renders retrying, auth pause, blocked and latest rejection reasons', () => {
    context.client = {};
    useHomebaseSyncStatus.setState({
      pending: 3,
      retrying: 1,
      authPaused: 1,
      blocked: 1,
      rejectedReasons: ['notes/n1: invalid row'],
    });
    render(<HomebaseSyncMenu onSync={() => {}} />);
    expect(screen.getByText('1 changes retrying')).toBeTruthy();
    expect(screen.getByText('1 changes paused until sign-in')).toBeTruthy();
    expect(screen.getByText('1 blocked changes retained on this device')).toBeTruthy();
    expect(screen.getByText('notes/n1: invalid row')).toBeTruthy();
  });

  it('does not erase a failure when a concurrent unrelated request succeeds', async () => {
    const client = new HomebaseSyncClient({
      adapter: {
        endpointId: 'fixture',
        capabilities: async () => null,
        pull: async () => ({}),
        push: async () => {
          throw new HomebaseSyncError('offline', 'NETWORK');
        },
      },
    });
    await expect(client.pushChanges({})).rejects.toThrow();
    await client.pullChanges(0);
    expect(useHomebaseSyncStatus.getState()).toMatchObject({
      active: 0,
      error: PRIVATE_SERVER_UNAVAILABLE,
    });
  });
});
