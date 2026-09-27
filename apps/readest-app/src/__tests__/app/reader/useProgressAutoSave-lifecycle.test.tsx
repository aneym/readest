import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

const h = vi.hoisted(() => {
  const state = {
    config: { location: 'start' },
    progress: { location: 'start' },
    previewMode: false,
  };
  const saveConfig = vi.fn(async () => {});
  const flushLibrary = vi.fn(async () => {});
  const getConfig = () => state.config;
  const envConfig = {};
  return { state, saveConfig, flushLibrary, getConfig, envConfig };
});

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ envConfig: h.envConfig, appService: { isDesktopApp: false } }),
}));
vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: (selector: (s: unknown) => unknown) =>
    selector({ getConfig: h.getConfig, saveConfig: h.saveConfig }),
  flushPendingLibrarySave: h.flushLibrary,
}));
vi.mock('@/store/readerStore', () => ({
  useReaderStore: {
    getState: () => ({ getViewState: () => ({ previewMode: h.state.previewMode }) }),
  },
}));
vi.mock('@/store/readerProgressStore', () => ({ useBookProgress: () => h.state.progress }));
vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: { getState: () => ({ settings: {} }) },
}));

import { useProgressAutoSave } from '@/app/reader/hooks/useProgressAutoSave';

const hide = async () => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
    await Promise.resolve();
  });
};
const turn = (rerender: () => void) => {
  h.state.config = { location: 'next' };
  h.state.progress = { location: 'next' };
  rerender();
};

beforeEach(() => {
  vi.useFakeTimers();
  h.state.config = { location: 'start' };
  h.state.progress = { location: 'start' };
  h.state.previewMode = false;
  h.saveConfig.mockClear();
  h.flushLibrary.mockClear();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});
afterEach(async () => {
  cleanup();
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
  vi.useRealTimers();
});

describe('reader position lifecycle', () => {
  test('hidden persists a changed location before the debounce fires', async () => {
    const { rerender } = renderHook(() => useProgressAutoSave('book'));
    turn(rerender);
    await hide();
    expect(h.saveConfig).toHaveBeenCalledTimes(1);
    expect(h.flushLibrary).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(h.saveConfig).toHaveBeenCalledTimes(1);
  });

  test('pagehide persists the changed location immediately', async () => {
    const { rerender } = renderHook(() => useProgressAutoSave('book'));
    turn(rerender);
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(h.saveConfig).toHaveBeenCalledTimes(1);
    expect(h.flushLibrary).toHaveBeenCalledTimes(1);
  });

  test('unchanged location does not bump the config timestamp on hide', async () => {
    renderHook(() => useProgressAutoSave('book'));
    await hide();
    expect(h.saveConfig).not.toHaveBeenCalled();
    expect(h.flushLibrary).toHaveBeenCalledTimes(1);
  });

  test('preview mode does not persist a transient location', async () => {
    const { rerender } = renderHook(() => useProgressAutoSave('book'));
    turn(rerender);
    h.state.previewMode = true;
    await hide();
    expect(h.saveConfig).not.toHaveBeenCalled();
  });

  test('rapid hides share a single in-flight flush', async () => {
    let finishSave!: () => void;
    h.saveConfig.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        }),
    );
    const { rerender } = renderHook(() => useProgressAutoSave('book'));
    turn(rerender);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    expect(h.saveConfig).toHaveBeenCalledTimes(1);
    await act(async () => {
      finishSave();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(h.flushLibrary).toHaveBeenCalledTimes(1);
  });

  test('unmount flushes pending progress and removes lifecycle listeners', async () => {
    const { rerender, unmount } = renderHook(() => useProgressAutoSave('book'));
    turn(rerender);
    unmount();
    await act(async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    expect(h.saveConfig).toHaveBeenCalledTimes(1);
    expect(h.flushLibrary).toHaveBeenCalledTimes(1);
    await hide();
    window.dispatchEvent(new Event('pagehide'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(h.flushLibrary).toHaveBeenCalledTimes(1);
  });
});
