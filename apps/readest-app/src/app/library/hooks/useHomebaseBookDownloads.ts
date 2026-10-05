import { isMissingHomebaseBookError } from '@/services/bookDownloadErrors';
import { useCallback, useEffect, useRef } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useEnv } from '@/context/EnvContext';
import { useLibraryStore } from '@/store/libraryStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useTransferStore } from '@/store/transferStore';
import { transferManager } from '@/services/transferManager';
import { isHomebaseSyncEnabled } from '@/services/sync/homebase/config';
import { isReadestCloudEnabled } from '@/services/sync/cloudSyncProvider';
import { isBookIntegrityError } from '@/services/bookIntegrity';
import { isFeedBook } from '@/services/rss/feedBookUrl';
import { isDemoBook } from '@/services/demoBooks';
import { isAudiobook } from '@/utils/audiobook';
import { Book } from '@/types/book';
import { createImmersionClient } from '@/services/homebase/immersion/client';
import { useImmersionStore } from '@/store/immersionStore';
import { DocumentLoader } from '@/libs/document';
import { hasMediaOverlays } from '@/services/tts/mediaOverlay';

// Library changes arrive in bursts (adoption batches of 10, cover rewrites);
// one reconciliation per burst is enough.
const RECONCILE_DEBOUNCE_MS = 1500;
// Backfill of the existing shelf runs behind anything the user asked for
// (manual downloads are priority 1, plain queue rows 10).
const AUTO_DOWNLOAD_PRIORITY = 20;

/**
 * A shelf row the household server can serve and this device does not yet
 * hold. Feed/ABS/demo rows are fileless or local-only by construction.
 */
export const isDesiredHomebaseDownload = (book: Book): boolean =>
  !!book.uploadedAt &&
  !book.downloadedAt &&
  !book.deletedAt &&
  !isFeedBook(book) &&
  !isAudiobook(book) &&
  !isDemoBook(book);

/**
 * Homebase-only: every canonical book the server advertises is fetched onto
 * the device automatically, so the shelf a reader sees offline is the library,
 * not a list of covers. Readest Cloud proper never did this (its metadata
 * sync adopts rows and covers only; bytes arrive on open or "Download All"),
 * and for a household server the whole library is the desired set.
 *
 * Reconciles on: library adoption (debounced), transfer-manager readiness,
 * reconnect (`online`) and return to foreground. Idempotent: rows already
 * pending/in-flight are deduped by hash inside the manager, and rows that
 * failed integrity stay failed and visible instead of being re-queued in a
 * loop. Transient failures are revived by the manager itself.
 *
 * Verification of what is on disk happens in `downloadBook`, so an
 * `uploadedAt && !downloadedAt` row whose file already exists intact costs one
 * local check and no network.
 */
export const useHomebaseBookDownloads = () => {
  const { user } = useAuth();
  const { appService, envConfig } = useEnv();
  const library = useLibraryStore((s) => s.library);
  const libraryLoaded = useLibraryStore((s) => s.libraryLoaded);
  // A primitive selector only changes on book download completion, not on progress ticks.
  const completedBookHashes = useTransferStore((s) =>
    Object.values(s.transfers)
      .filter((t) => t.kind === 'book' && t.type === 'download' && t.status === 'completed')
      .map((t) => t.bookHash)
      .sort()
      .join('|'),
  );
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const checkedNarration = useRef(new Set<string>());
  const narrationQueue = useRef<Book[]>([]);
  const narrationRunning = useRef(false);

  const enabled = !!user && !!appService && isHomebaseSyncEnabled();

  const reconcile = useCallback(async () => {
    if (!enabled) return 0;
    if (!isReadestCloudEnabled(useSettingsStore.getState().settings)) return 0;
    await transferManager.waitUntilReady();
    const transfers = Object.values(useTransferStore.getState().transfers);
    const blocked = new Set(
      transfers
        .filter(
          (t) =>
            t.type === 'download' &&
            (t.status === 'pending' ||
              t.status === 'in_progress' ||
              (t.status === 'failed' &&
                (isBookIntegrityError(t.error) || isMissingHomebaseBookError(t.error))) ||
              (t.status === 'cancelled' && t.cancelReason === 'user')),
        )
        .map((t) => t.bookHash),
    );
    const desired = useLibraryStore
      .getState()
      .library.filter((book) => isDesiredHomebaseDownload(book) && !blocked.has(book.hash));
    // Oldest failures first would starve new arrivals; newest adoption first
    // means the book that was just requested lands before the backfill.
    desired.sort((a, b) => (b.syncedAt ?? b.updatedAt) - (a.syncedAt ?? a.updatedAt));
    let queued = 0;
    for (const book of desired) {
      if (transferManager.queueDownload(book, AUTO_DOWNLOAD_PRIORITY)) queued++;
    }
    if (queued > 0) {
      console.info(`[homebase] queued ${queued} book download(s)`);
    }
    return queued;
  }, [enabled]);

  const scheduleReconcile = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void reconcile();
    }, RECONCILE_DEBOUNCE_MS);
  }, [reconcile]);

  useEffect(() => {
    if (!enabled || !libraryLoaded) return;
    scheduleReconcile();
  }, [enabled, libraryLoaded, library, scheduleReconcile]);

  useEffect(() => {
    if (!enabled) return;
    const onOnline = () => scheduleReconcile();
    const onVisible = () => {
      if (document.visibilityState === 'visible') scheduleReconcile();
    };
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisible);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [enabled, scheduleReconcile]);

  // The shelf status endpoint is independent of book transfer scheduling.
  useEffect(() => {
    if (!enabled) return;
    const api = createImmersionClient();
    if (!api) return;
    let mounted = true;
    let controller: AbortController | null = null;
    const poll = () => {
      if (document.visibilityState === 'hidden') return;
      controller?.abort();
      controller = new AbortController();
      void api
        .status(controller.signal)
        .then((pairs) => {
          if (mounted) useImmersionStore.getState().setPairs(pairs);
        })
        .catch(() => {
          /* Retain the last known shelf status while offline. */
        });
    };
    poll();
    const timer = setInterval(poll, 60_000);
    document.addEventListener('visibilitychange', poll);
    window.addEventListener('online', poll);
    return () => {
      mounted = false;
      controller?.abort();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', poll);
      window.removeEventListener('online', poll);
    };
  }, [enabled]);

  // Transfer completion stamps downloadedAt only after integrity verification.
  // Process completed EPUBs serially, including outstanding completed rows on mount.
  // A successful negative result is persisted as false to avoid re-parsing on remount.
  useEffect(() => {
    if (!enabled || !appService || !envConfig || !libraryLoaded) return;
    const completed = new Set(completedBookHashes ? completedBookHashes.split('|') : []);
    for (const book of library) {
      if (
        book.format !== 'EPUB' ||
        !book.downloadedAt ||
        book.hasNarration !== undefined ||
        !completed.has(book.hash) ||
        checkedNarration.current.has(book.hash)
      )
        continue;
      checkedNarration.current.add(book.hash);
      narrationQueue.current.push(book);
    }
    if (narrationRunning.current || narrationQueue.current.length === 0) return;
    narrationRunning.current = true;
    void (async () => {
      try {
        while (narrationQueue.current.length) {
          const book = narrationQueue.current.shift()!;
          let loaded: Awaited<ReturnType<DocumentLoader['open']>>['book'] | undefined;
          try {
            const { file } = await appService.loadBookContent(book);
            ({ book: loaded } = await new DocumentLoader(file).open());
            const hasNarration = hasMediaOverlays(loaded);
            const current = useLibraryStore.getState().getBookByHash(book.hash);
            if (current && current.hasNarration === undefined)
              await useLibraryStore.getState().updateBook(envConfig, { ...current, hasNarration });
          } catch {
            /* A failed detection leaves the flag undefined, skipped this session. */
          } finally {
            try {
              await loaded?.destroy?.();
            } catch {
              /* Best effort cleanup. */
            }
          }
        }
      } finally {
        narrationRunning.current = false;
      }
    })();
  }, [enabled, appService, envConfig, libraryLoaded, library, completedBookHashes]);

  return { reconcile };
};
