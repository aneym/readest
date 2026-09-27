import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

const h = vi.hoisted(() => {
  const settings = { version: 1, keepLogin: true };
  return {
    settings,
    setSettings: vi.fn(),
    saveSettings: vi.fn(),
    navigate: vi.fn(),
    pull: vi.fn(),
  };
});
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/context/EnvContext', () => ({ useEnv: () => ({ envConfig: {} }) }));
vi.mock('@/context/SyncContext', () => ({
  useSyncContext: () => ({ syncClient: { pullChanges: h.pull } }),
}));
vi.mock('@/store/settingsStore', () => {
  const store = { settings: h.settings, setSettings: h.setSettings, saveSettings: h.saveSettings };
  const useSettingsStore = Object.assign(() => store, { getState: () => store });
  return { useSettingsStore };
});
vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: () => ({ getConfig: () => null, setConfig: vi.fn() }),
}));
vi.mock('@/store/readerStore', () => ({ useReaderStore: () => ({ setIsSyncing: vi.fn() }) }));
vi.mock('@/utils/nav', () => ({ navigateToLogin: h.navigate }));

import { useSync } from '@/hooks/useSync';
import { HomebaseSyncError } from '@/services/sync/homebase';
import { syncErrorMessage, useHomebaseSyncStatus } from '@/services/sync/homebase/syncStatus';

beforeEach(() => {
  h.settings.keepLogin = true;
  h.setSettings.mockClear();
  h.saveSettings.mockClear();
  h.navigate.mockClear();
  h.pull.mockReset();
  useHomebaseSyncStatus.setState({ authPaused: 0, error: null });
});
afterEach(() => cleanup());

const pullFailure = async (error: Error) => {
  h.pull.mockRejectedValue(error);
  const { result } = renderHook(() => useSync());
  await act(async () => {
    await result.current.pullChanges('configs', 0, vi.fn(), vi.fn());
  });
};

describe('pull authentication handling', () => {
  test('Homebase AUTH_FAILED pauses sync instead of navigating to stock login', async () => {
    const error = new HomebaseSyncError('Not authenticated', 'AUTH_FAILED');
    await pullFailure(error);
    expect(h.navigate).not.toHaveBeenCalled();
    expect(h.settings.keepLogin).toBe(true);
    expect(useHomebaseSyncStatus.getState()).toMatchObject({
      authPaused: 1,
      error: syncErrorMessage(error),
    });
  });

  test('stock Not authenticated errors still route keepLogin users to login', async () => {
    await pullFailure(new Error('Not authenticated'));
    expect(h.navigate).toHaveBeenCalledTimes(1);
    expect(h.settings.keepLogin).toBe(false);
    expect(h.setSettings).toHaveBeenCalled();
  });
});
