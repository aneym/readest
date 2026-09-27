import { useCallback, useEffect, useRef } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useReaderStore } from '@/store/readerStore';
import { useThemeStore } from '@/store/themeStore';
import { refreshEinkScreen } from '@/utils/bridge';

/** Called once for each committed (frame-coalesced) foliate relocation. */
export const useEinkDarkRefresh = (bookKey: string) => {
  const { appService } = useEnv();
  const isDarkMode = useThemeStore((s) => s.isDarkMode);
  const isEink = useReaderStore((s) => s.viewStates[bookKey]?.viewSettings?.isEink);
  const interval = useReaderStore(
    (s) => s.viewStates[bookKey]?.viewSettings?.einkDarkRefreshPages ?? 6,
  );
  const scrolled = useReaderStore((s) => s.viewStates[bookKey]?.viewSettings?.scrolled);
  const count = useRef(0);
  // Foliate's listener is registered once; read the live mode and settings from
  // this ref even when its original relocate callback remains attached.
  const current = useRef({ isEink, isDarkMode, interval, scrolled });
  current.current = { isEink, isDarkMode, interval, scrolled };
  const timers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  useEffect(() => {
    count.current = 0;
    const pending = timers.current;
    return () => {
      pending.forEach(clearTimeout);
      pending.clear();
    };
  }, [bookKey, isDarkMode, isEink, interval, scrolled]);

  return useCallback(() => {
    const { isEink, isDarkMode, interval, scrolled } = current.current;
    const android = appService?.isAndroidApp;
    if (!android || !isEink || !isDarkMode || scrolled || interval <= 0) return;
    if (++count.current % interval !== 0) return;
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      refreshEinkScreen().catch(() => {});
    }, 120);
    timers.current.add(timer);
  }, [appService]);
};
