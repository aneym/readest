import { useCallback, useEffect, useRef } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useBookDataStore, flushPendingLibrarySave } from '@/store/bookDataStore';
import { useReaderStore } from '@/store/readerStore';
import { useBookProgress } from '@/store/readerProgressStore';
import { useSettingsStore } from '@/store/settingsStore';
import { debounce } from '@/utils/debounce';
import { useWindowActiveChanged } from './useWindowActiveChanged';

export const useProgressAutoSave = (bookKey: string) => {
  const { envConfig } = useEnv();
  const getConfig = useBookDataStore((s) => s.getConfig);
  const saveConfig = useBookDataStore((s) => s.saveConfig);
  // Reactive subscription so the effect below fires the debounced save
  // whenever this book's progress changes. Reads from readerProgressStore.
  const progress = useBookProgress(bookKey);

  // Tracks the location we last persisted (or, before the first save, the
  // location loaded from disk at book open). We skip saveConfig when the
  // in-memory location matches — saveConfig unconditionally bumps
  // config.updatedAt, and a bump on the initial relocate makes the local
  // record look newer than a fresher server-side push, so the next sync
  // overwrites the server's progress with the stale local one (issue #4222).
  const lastSavedLocationRef = useRef<string | null>(null);
  const initializedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushRef = useRef<Promise<void> | null>(null);
  const saveRef = useRef<Promise<void> | null>(null);

  const persistNow = useCallback(async () => {
    // If a timer's save has already started, wait for it before reading the
    // latest location. Otherwise a hide racing that save can write an older
    // position last, or save the same position twice.
    if (saveRef.current) await saveRef.current;
    if (useReaderStore.getState().getViewState(bookKey)?.previewMode) return;
    const config = getConfig(bookKey);
    if (!config) return;
    const currentLocation = config.location ?? null;
    if (!initializedRef.current) {
      initializedRef.current = true;
      lastSavedLocationRef.current = currentLocation;
      return;
    }
    if (currentLocation === lastSavedLocationRef.current) return;
    const save = Promise.resolve().then(() =>
      saveConfig(envConfig, bookKey, config, useSettingsStore.getState().settings),
    );
    saveRef.current = save;
    try {
      await save;
      lastSavedLocationRef.current = currentLocation;
    } finally {
      if (saveRef.current === save) saveRef.current = null;
    }
  }, [bookKey, envConfig, getConfig, saveConfig]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const saveBookConfig = useCallback(
    debounce(() => {
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void persistNow();
      }, 500);
    }, 1000),
    [persistNow],
  );

  const flushNow = useCallback((): Promise<void> => {
    if (flushRef.current) return flushRef.current;
    saveBookConfig.cancel();
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const flush = (async () => {
      await persistNow();
      await flushPendingLibrarySave();
    })();
    flushRef.current = flush;
    void flush
      .finally(() => {
        if (flushRef.current === flush) flushRef.current = null;
      })
      .catch(() => {});
    return flush;
  }, [persistNow, saveBookConfig]);

  useEffect(() => {
    // Snapshot the loaded-from-disk location before any progress events fire,
    // so we don't treat the initial relocate as a user-driven change.
    if (!initializedRef.current) {
      const config = getConfig(bookKey);
      if (config) {
        initializedRef.current = true;
        lastSavedLocationRef.current = config.location ?? null;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookKey]);

  useEffect(() => {
    saveBookConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress, bookKey]);

  // Desktop Tauri windows use focus rather than visibility to signal a pause.
  // On web/mobile this shares the hidden signal with visibilitychange; the
  // in-flight guard makes the two notifications one flush.
  useWindowActiveChanged((isActive) => {
    if (!isActive) void flushNow().catch(() => {});
  });

  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === 'hidden') void flushNow().catch(() => {});
    };
    const onPageHide = () => void flushNow().catch(() => {});
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', onPageHide);
      // Book closed: persist config.json first, then flush library.json.
      void flushNow().catch(() => {});
    };
  }, [flushNow]);
};
