import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { household, paired } = vi.hoisted(() => ({ household: vi.fn(), paired: vi.fn() }));
vi.mock('@/services/household', () => ({ isHouseholdBuild: household }));
vi.mock('@/services/householdPairing', () => ({ readPairedDevice: paired }));

import { useHouseholdStatusExport } from '@/hooks/useHouseholdStatusExport';
import { useHomebaseSyncStatus } from '@/services/sync/homebase/syncStatus';

const send = vi.fn();
const baseline = { active: 0, pending: 0, blocked: 0, error: null, lastSuccessAt: null };
const latest = () => JSON.parse(send.mock.lastCall?.[0] ?? '{}');
const tick = () => act(() => vi.advanceTimersByTime(1000));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1700000000100);
  household.mockReturnValue(true);
  paired.mockReturnValue({ profileId: 'reader' });
  window.HomebaseHousehold = { setSyncStatus: send };
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  useHomebaseSyncStatus.setState(baseline);
});

afterEach(() => {
  cleanup();
  delete window.HomebaseHousehold;
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('useHouseholdStatusExport', () => {
  it('exports each public state and numeric fields without identity', () => {
    renderHook(() => useHouseholdStatusExport());
    tick();
    expect(latest()).toEqual({
      pending: 0,
      state: 'idle',
      last_sync_at: 0,
      updated_at: 1700000001100,
    });

    act(() => useHomebaseSyncStatus.setState({ pending: 2, active: 1, lastSuccessAt: 1234 }));
    tick();
    expect(latest()).toMatchObject({ pending: 2, state: 'syncing', last_sync_at: 1234 });
    act(() => useHomebaseSyncStatus.setState({ error: 'private failure' }));
    tick();
    expect(latest().state).toBe('error');
    expect(JSON.stringify(latest())).not.toContain('private failure');

    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    act(() => window.dispatchEvent(new Event('offline')));
    tick();
    expect(latest().state).toBe('offline');

    paired.mockReturnValue(null);
    act(() => window.dispatchEvent(new Event('focus')));
    tick();
    expect(latest().state).toBe('unpaired');
  });

  it('debounces changes and does not republish equal values', () => {
    renderHook(() => useHouseholdStatusExport());
    act(() => {
      useHomebaseSyncStatus.setState({ pending: 1 });
      vi.advanceTimersByTime(500);
      useHomebaseSyncStatus.setState({ pending: 2 });
    });
    expect(send).not.toHaveBeenCalled();
    tick();
    expect(send).toHaveBeenCalledTimes(1);
    expect(latest().pending).toBe(2);
    act(() => useHomebaseSyncStatus.setState({ pending: 2 }));
    tick();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does nothing outside household builds or without the bridge', () => {
    household.mockReturnValue(false);
    const { unmount } = renderHook(() => useHouseholdStatusExport());
    tick();
    expect(send).not.toHaveBeenCalled();
    unmount();
    household.mockReturnValue(true);
    delete window.HomebaseHousehold;
    renderHook(() => useHouseholdStatusExport());
    tick();
    expect(send).not.toHaveBeenCalled();
  });
});
