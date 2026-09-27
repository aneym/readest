import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReaderStore } from '@/store/readerStore';
import { useThemeStore } from '@/store/themeStore';
import { useEinkDarkRefresh } from '@/app/reader/hooks/useEinkDarkRefresh';
import { refreshEinkScreen } from '@/utils/bridge';
import type { ViewSettings } from '@/types/book';

const device = vi.hoisted(() => ({ isAndroidApp: true }));
vi.mock('@/context/EnvContext', () => ({ useEnv: () => ({ appService: device }) }));
vi.mock('@/utils/bridge', () => ({ refreshEinkScreen: vi.fn().mockResolvedValue(undefined) }));

const setSettings = (isEink: boolean, pages: number, scrolled = false) => {
  useReaderStore.setState((s) => ({
    viewStates: {
      ...s.viewStates,
      book: {
        ...s.viewStates['book']!,
        viewSettings: { isEink, einkDarkRefreshPages: pages, scrolled } as ViewSettings,
      },
    },
  }));
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(refreshEinkScreen).mockClear();
  device.isAndroidApp = true;
  useReaderStore.setState({ viewStates: {} });
  setSettings(true, 6);
  useThemeStore.setState({ isDarkMode: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('periodic dark e-ink refresh', () => {
  it('refreshes only after six completed relocations and waits for the page to draw', () => {
    const { result } = renderHook(() => useEinkDarkRefresh('book'));
    act(() => {
      for (let i = 0; i < 6; i++) result.current();
      vi.advanceTimersByTime(119);
    });
    expect(refreshEinkScreen).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(refreshEinkScreen).toHaveBeenCalledTimes(1);
  });

  it('does not count scrolling relocations toward a later paginated refresh', () => {
    setSettings(true, 6, true);
    const { result } = renderHook(() => useEinkDarkRefresh('book'));
    act(() => {
      for (let i = 0; i < 12; i++) result.current();
      vi.advanceTimersByTime(120);
    });
    expect(refreshEinkScreen).not.toHaveBeenCalled();
    act(() => setSettings(true, 6, false));
    act(() => {
      for (let i = 0; i < 5; i++) result.current();
      vi.advanceTimersByTime(120);
    });
    expect(refreshEinkScreen).not.toHaveBeenCalled();
    act(() => {
      result.current();
      vi.advanceTimersByTime(120);
    });
    expect(refreshEinkScreen).toHaveBeenCalledTimes(1);
  });

  it('does not refresh in light mode, with an off interval, or off Android', () => {
    const { result } = renderHook(() => useEinkDarkRefresh('book'));
    act(() => useThemeStore.setState({ isDarkMode: false }));
    act(() => {
      for (let i = 0; i < 6; i++) result.current();
      vi.advanceTimersByTime(120);
    });
    act(() => useThemeStore.setState({ isDarkMode: true }));
    act(() => setSettings(true, 0));
    act(() => {
      for (let i = 0; i < 6; i++) result.current();
      vi.advanceTimersByTime(120);
    });
    act(() => setSettings(true, 6));
    device.isAndroidApp = false;
    act(() => {
      for (let i = 0; i < 6; i++) result.current();
      vi.advanceTimersByTime(120);
    });
    expect(refreshEinkScreen).not.toHaveBeenCalled();
  });
});
