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
  const { appService } = useEnv();
  const library = useLibraryStore((s) => s.library);
  const libraryLoaded = useLibraryStore((s) => s.libraryLoaded);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
              (t.status === 'failed' && isBookIntegrityError(t.error)) ||
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

  return { reconcile };
};
