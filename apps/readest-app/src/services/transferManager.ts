import { Book } from '@/types/book';
import { AppService, BaseDir } from '@/types/system';
import { useTransferStore, TransferItem, ReplicaTransferFile } from '@/store/transferStore';
import { useSettingsStore } from '@/store/settingsStore';
import { isReadestCloudStorageActive } from '@/services/sync/cloudSyncProvider';
import { TranslationFunc } from '@/hooks/useTranslation';
import { createProgressThrottle, ProgressHandler, ProgressPayload } from '@/utils/transfer';
import { eventDispatcher } from '@/utils/event';
import { isAudiobook } from '@/utils/audiobook';
import { getTransferMessages } from './transferMessages';
import { isBookIntegrityError } from './bookIntegrity';
import { isHouseholdBuild } from './household';

export const transferAuthMessage = (household: boolean): string =>
  household ? 'Pair this device with Homebase to transfer books.' : 'Please log in to continue';

const TRANSFER_QUEUE_KEY = 'readest_transfer_queue';
const RETRY_DELAY_BASE_MS = 2000;
// While the device reports itself offline a failed transfer is held, not
// retried: the attempt cannot succeed and would only burn the retry budget.
// The hold is re-checked on this cadence in case the `online` event never
// fires (some WebViews only flip navigator.onLine).
const OFFLINE_HOLD_MS = 30_000;
export const OFFLINE_HOLD_MESSAGE = 'Waiting for network';
// Reconnect/foreground revival is coalesced so a flapping connection cannot
// re-queue the same rows in a tight loop.
const REVIVAL_THROTTLE_MS = 5_000;
// Coalesce per-chunk progress emissions to at most ~10/sec per transfer so the
// transfer-store fan-out cannot sustain a synchronous React update storm (a
// buffered download emits progress once per chunk in a microtask burst, and
// transferSpeed changes every call so the store's no-op guard cannot help)
// (Sentry READEST-2).
const PROGRESS_THROTTLE_MS = 100;
// Quota failures in a batch import arrive one per book as transfers drain;
// collapse them into one summary toast per burst instead of N identical toasts.
const QUOTA_TOAST_FLUSH_MS = 1500;

interface PersistedQueueData {
  schemaVersion?: number;
  transfers: Record<string, TransferItem>;
  isQueuePaused: boolean;
}

const QUEUE_SCHEMA_VERSION = 1;

class TransferManager {
  private static instance: TransferManager;
  private appService: AppService | null = null;
  private isProcessing = false;
  private abortControllers: Map<string, AbortController> = new Map();
  private isInitialized = false;
  private getLibrary: (() => Book[]) | null = null;
  private updateBook: ((book: Book) => Promise<void>) | null = null;
  private _: TranslationFunc | null = null;
  private settingsUnsub: (() => void) | null = null;
  private quotaFailureCount = 0;
  private quotaToastTimer: ReturnType<typeof setTimeout> | null = null;
  private readyResolve: () => void = () => {};
  private readyPromise: Promise<void> = new Promise<void>((resolve) => {
    this.readyResolve = resolve;
  });
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private connectivityInstalled = false;
  private lastRevivalAt = 0;

  private constructor() {}

  private isOffline(): boolean {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
  }

  /**
   * Downloads that failed for a transient reason (network, server, auth
   * hiccup) are given a fresh retry budget when connectivity returns or the
   * app comes back to the foreground. Rows that failed because the served
   * bytes are not a book (`BookIntegrityError`) stay failed and visible:
   * fetching the same bytes again cannot fix them, and re-queuing them would
   * only delay the books that can succeed. Explicit user cancellations are
   * never revived.
   */
  reviveTransientFailures(reason: 'online' | 'foreground' | 'manual' = 'manual'): number {
    if (!this.isReady()) return 0;
    if (reason !== 'manual') {
      const now = Date.now();
      if (now - this.lastRevivalAt < REVIVAL_THROTTLE_MS) return 0;
      this.lastRevivalAt = now;
    }
    if (this.isOffline()) return 0;

    const store = useTransferStore.getState();
    let revived = 0;
    Object.values(store.transfers).forEach((t) => {
      if (t.type !== 'download') return;
      if (t.status === 'failed' && !isBookIntegrityError(t.error)) {
        store.retryTransfer(t.id);
        revived++;
      } else if (t.status === 'pending' && t.nextAttemptAt && t.error === OFFLINE_HOLD_MESSAGE) {
        // An offline hold is over the moment we are back online.
        store.setTransferStatus(t.id, 'pending', undefined);
        store.setNextAttemptAt(t.id, undefined);
        revived++;
      }
    });
    if (revived > 0) {
      console.info(`[transfer] revived ${revived} download(s) on ${reason}`);
      this.persistQueue();
    }
    this.processQueue();
    return revived;
  }

  private onlineHandler = () => {
    this.reviveTransientFailures('online');
  };

  private visibilityHandler = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      this.reviveTransientFailures('foreground');
    }
  };

  private installConnectivityRevival(): void {
    if (this.connectivityInstalled) return;
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.onlineHandler);
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.visibilityHandler);
    }
    this.connectivityInstalled = true;
  }

  /**
   * Settings hydrate asynchronously at app start (`settings` begins as
   * `{}`); `settings.version` truthiness is the loaded signal (same
   * convention as useSync). Before hydration the provider is unknown, so
   * book uploads are deferred rather than judged — acting on unknown
   * settings could both mis-cancel and mis-allow. Replica transfers and
   * downloads are never deferred: they are not provider-gated and the
   * boot-time replica pull relies on waitUntilReady().
   */
  private isSettingsLoaded(): boolean {
    return !!useSettingsStore.getState().settings?.version;
  }

  private isBookUploadAllowed(): boolean {
    return isReadestCloudStorageActive(useSettingsStore.getState().settings);
  }

  private isDeferredBookUpload(t: TransferItem): boolean {
    return t.kind === 'book' && t.type === 'upload' && !this.isSettingsLoaded();
  }

  /**
   * Cancel pending book uploads when Readest Cloud is not the selected
   * provider. Idempotent (acts on pending rows only) — safe to run on
   * every processQueue pass, which also re-settles rows another window
   * or a rogue retry re-pended. Cancellation is visible ('cancelled'
   * with cancelReason 'policy'), never a silent drop.
   */
  private reconcileUploadsWithProvider(): void {
    if (!this.isSettingsLoaded() || this.isBookUploadAllowed()) return;

    const store = useTransferStore.getState();
    const gated = store
      .getPendingTransfers()
      .filter((t) => t.kind === 'book' && t.type === 'upload');
    if (gated.length === 0) return;

    gated.forEach((t) => {
      store.setTransferStatus(t.id, 'cancelled', undefined, 'policy');
    });
    console.info(
      `[cloudSync] cancelled ${gated.length} pending Readest Cloud upload(s): third-party provider selected`,
    );
    this.persistQueue();
  }

  static getInstance(): TransferManager {
    if (!TransferManager.instance) {
      TransferManager.instance = new TransferManager();
    }
    return TransferManager.instance;
  }

  async initialize(
    appService: AppService,
    getLibrary: () => Book[],
    updateBook: (book: Book) => Promise<void>,
    translationFn: TranslationFunc,
  ): Promise<void> {
    if (this.isInitialized) return;

    this.appService = appService;
    this.getLibrary = getLibrary;
    this.updateBook = updateBook;
    this._ = translationFn;
    await this.loadPersistedQueue();
    this.reconcileUploadsWithProvider();
    this.isInitialized = true;
    this.readyResolve();
    this.installConnectivityRevival();

    // Re-gate when settings hydrate or the selected provider changes.
    this.settingsUnsub?.();
    this.settingsUnsub = useSettingsStore.subscribe((state, prev) => {
      if (state.settings === prev.settings) return;
      this.reconcileUploadsWithProvider();
      this.processQueue();
    });

    // Start processing queue
    this.processQueue();
  }

  isReady(): boolean {
    return this.isInitialized && this.appService !== null;
  }

  /**
   * Resolves once `initialize()` has completed. Lets callers that need
   * to enqueue transfers (e.g., the boot-time replica pull) defer until
   * the manager is wired up — the manager only inits after the library
   * is loaded, which can lag well behind app boot.
   */
  waitUntilReady(): Promise<void> {
    return this.readyPromise;
  }

  queueUpload(book: Book, priority: number = 10): string | null {
    if (!this.isReady()) {
      console.warn('TransferManager not initialized');
      return null;
    }

    // ABS books stream from the server; there is no local file to upload.
    if (isAudiobook(book)) return null;

    // Readest Cloud storage is not written to while a third-party
    // provider is selected. Before settings hydrate the entry is queued
    // and deferred; the reconcile on hydration decides its fate.
    if (this.isSettingsLoaded() && !this.isBookUploadAllowed()) {
      return null;
    }

    const store = useTransferStore.getState();

    // Check if already queued or in progress
    const existing = store.getTransferByBookHash(book.hash, 'upload');
    if (existing) {
      return existing.id;
    }

    const transferId = store.addTransfer(book.hash, book.title, 'upload', priority);
    this.persistQueue();
    this.processQueue();
    return transferId;
  }

  queueDownload(book: Book, priority: number = 10): string | null {
    if (!this.isReady()) {
      console.warn('TransferManager not initialized');
      return null;
    }

    // ABS books stream from the server; there is no cloud file to download.
    if (isAudiobook(book)) return null;

    const store = useTransferStore.getState();

    const existing = store.getTransferByBookHash(book.hash, 'download');
    if (existing) {
      return existing.id;
    }

    const transferId = store.addTransfer(book.hash, book.title, 'download', priority);
    this.persistQueue();
    this.processQueue();
    return transferId;
  }

  queueDelete(book: Book, priority: number = 10, isBackground: boolean = false): string | null {
    if (!this.isReady()) {
      console.warn('TransferManager not initialized');
      return null;
    }

    const store = useTransferStore.getState();

    const existing = store.getTransferByBookHash(book.hash, 'delete');
    if (existing) {
      return existing.id;
    }

    const transferId = store.addTransfer(book.hash, book.title, 'delete', priority, isBackground);
    this.persistQueue();
    this.processQueue();
    return transferId;
  }

  queueBatchUploads(books: Book[], priority: number = 10): string[] {
    return books
      .map((book) => this.queueUpload(book, priority))
      .filter((id): id is string => id !== null);
  }

  queueReplicaUpload(
    replicaKind: string,
    replicaId: string,
    displayTitle: string,
    files: ReplicaTransferFile[],
    base: BaseDir,
    opts: { priority?: number; isBackground?: boolean; reincarnation?: string } = {},
  ): string | null {
    if (!this.isReady()) {
      console.warn('TransferManager not initialized');
      return null;
    }
    const store = useTransferStore.getState();
    const existing = store.getReplicaTransfer(replicaKind, replicaId, 'upload');
    if (existing) return existing.id;

    const id = store.addReplicaTransfer(replicaKind, replicaId, displayTitle, 'upload', {
      priority: opts.priority,
      // Replica transfers are background sync by default — see the note on
      // queueReplicaDownload.
      isBackground: opts.isBackground ?? true,
      files,
      base,
      reincarnation: opts.reincarnation,
    });
    this.persistQueue();
    this.processQueue();
    return id;
  }

  queueReplicaDownload(
    replicaKind: string,
    replicaId: string,
    displayTitle: string,
    files: ReplicaTransferFile[],
    base: BaseDir,
    opts: { priority?: number; isBackground?: boolean } = {},
  ): string | null {
    if (!this.isReady()) {
      console.warn('TransferManager not initialized');
      return null;
    }
    const store = useTransferStore.getState();
    const existing = store.getReplicaTransfer(replicaKind, replicaId, 'download');
    if (existing) return existing.id;

    const id = store.addReplicaTransfer(replicaKind, replicaId, displayTitle, 'download', {
      priority: opts.priority,
      // Replica bundles (fonts, textures, dictionaries, OPDS catalogs) sync on
      // their own schedule, not because the user asked for this file right
      // now. Toasting each one turns a fresh device into a wall of
      // notifications, so they are background — and therefore silent — unless
      // a caller explicitly opts into the foreground.
      isBackground: opts.isBackground ?? true,
      files,
      base,
    });
    this.persistQueue();
    this.processQueue();
    return id;
  }

  queueReplicaDelete(
    replicaKind: string,
    replicaId: string,
    displayTitle: string,
    filenames: string[],
    opts: { priority?: number; isBackground?: boolean } = {},
  ): string | null {
    if (!this.isReady()) {
      console.warn('TransferManager not initialized');
      return null;
    }
    const store = useTransferStore.getState();
    const existing = store.getReplicaTransfer(replicaKind, replicaId, 'delete');
    if (existing) return existing.id;

    const id = store.addReplicaTransfer(replicaKind, replicaId, displayTitle, 'delete', {
      priority: opts.priority,
      // Background by default — see the note on queueReplicaDownload.
      isBackground: opts.isBackground ?? true,
      files: filenames.map((logical) => ({ logical, lfp: '', byteSize: 0 })),
    });
    this.persistQueue();
    this.processQueue();
    return id;
  }

  cancelTransfer(transferId: string): void {
    const controller = this.abortControllers.get(transferId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(transferId);
    }

    useTransferStore.getState().setTransferStatus(transferId, 'cancelled', undefined, 'user');
    this.persistQueue();
  }

  retryTransfer(transferId: string): void {
    const store = useTransferStore.getState();
    store.retryTransfer(transferId);
    this.persistQueue();
    this.processQueue();
  }

  retryAllFailed(): void {
    const store = useTransferStore.getState();
    const failed = store.getFailedTransfers();
    failed.forEach((transfer) => {
      store.retryTransfer(transfer.id);
    });
    this.persistQueue();
    this.processQueue();
  }

  pauseQueue(): void {
    useTransferStore.getState().pauseQueue();
    this.persistQueue();
  }

  resumeQueue(): void {
    useTransferStore.getState().resumeQueue();
    this.processQueue();
    this.persistQueue();
  }

  clearPending(): void {
    useTransferStore.getState().clearPending();
    this.persistQueue();
  }

  clearCompleted(): void {
    useTransferStore.getState().clearCompleted();
    this.persistQueue();
  }

  clearFailed(): void {
    useTransferStore.getState().clearFailed();
    this.persistQueue();
  }

  clearAll(): void {
    useTransferStore.getState().clearAll();
    this.persistQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessing) return;

    this.isProcessing = true;

    try {
      await this._processQueueInternal();
    } finally {
      this.isProcessing = false;
    }
  }

  private async _processQueueInternal(): Promise<void> {
    this.reconcileUploadsWithProvider();

    const store = useTransferStore.getState();

    if (store.isQueuePaused) return;

    const now = Date.now();
    const isDue = (t: TransferItem) => !t.nextAttemptAt || t.nextAttemptAt <= now;
    const runnable = store.getPendingTransfers().filter((t) => !this.isDeferredBookUpload(t));
    const pending = runnable.filter(isDue);
    // A backoff or offline hold is honoured by sleeping until the earliest
    // due row, never by re-scanning every 100ms (which is what let the old
    // loop burn every retry inside half a second).
    this.scheduleWake(runnable);
    const activeCount = store.getActiveTransfers().length;
    const maxConcurrent = store.maxConcurrent;

    const availableSlots = maxConcurrent - activeCount;
    if (availableSlots <= 0 || pending.length === 0) return;

    // Sort by priority (lower = higher priority) then by createdAt
    const sortedPending = [...pending].sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.createdAt - b.createdAt;
    });

    const toProcess = sortedPending.slice(0, availableSlots);

    await Promise.all(toProcess.map((transfer) => this.executeTransfer(transfer)));

    // Check if more items to process. Deferred book uploads (settings
    // not yet hydrated) don't count — re-looping on them every 100ms
    // would busy-wait; the settings subscription wakes them instead.
    const newStore = useTransferStore.getState();
    const after = Date.now();
    const processable = newStore
      .getPendingTransfers()
      .filter(
        (t) => !this.isDeferredBookUpload(t) && (!t.nextAttemptAt || t.nextAttemptAt <= after),
      );
    if (processable.length > 0 && !newStore.isQueuePaused) {
      setTimeout(() => this.processQueue(), 100);
    }
  }

  private scheduleWake(rows: TransferItem[]): void {
    const now = Date.now();
    const future = rows.map((t) => t.nextAttemptAt ?? 0).filter((at) => at > now);
    if (future.length === 0) return;
    const wakeAt = Math.min(...future);
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = setTimeout(
      () => {
        this.wakeTimer = null;
        this.processQueue();
      },
      Math.max(0, wakeAt - now),
    );
  }

  private async executeTransfer(transfer: TransferItem): Promise<void> {
    if (!this.appService || !this.getLibrary || !this.updateBook) {
      console.error('TransferManager not properly initialized');
      return;
    }

    const _ = this._!;
    const store = useTransferStore.getState();
    const abortController = new AbortController();
    this.abortControllers.set(transfer.id, abortController);

    store.setTransferStatus(transfer.id, 'in_progress');
    store.setActiveCount(store.getActiveTransfers().length + 1);

    const progressThrottle = createProgressThrottle((progress) => {
      const percentage = progress.total > 0 ? (progress.progress / progress.total) * 100 : 0;
      useTransferStore
        .getState()
        .updateTransferProgress(
          transfer.id,
          percentage,
          progress.progress,
          progress.total,
          progress.transferSpeed,
        );
    }, PROGRESS_THROTTLE_MS);

    const progressHandler = (progress: ProgressPayload) => {
      if (abortController.signal.aborted) return;
      progressThrottle.push(progress);
    };

    try {
      if (transfer.kind === 'replica') {
        await this.executeReplicaTransfer(transfer, progressHandler, abortController);
      } else {
        await this.executeBookTransfer(transfer, progressHandler, abortController);
      }

      // Land the final progress value that the throttle may still be holding.
      progressThrottle.flush();
      useTransferStore.getState().setTransferStatus(transfer.id, 'completed');

      const messages = getTransferMessages(transfer, _);

      if (!transfer.isBackground) {
        eventDispatcher.dispatch('toast', {
          type: 'info',
          timeout: 2000,
          message: messages.success[transfer.type],
        });
      }
    } catch (error) {
      if (abortController.signal.aborted) {
        // Already cancelled, don't update status
        return;
      }

      const errorMessage = error instanceof Error ? error.message : _('Unknown error');
      const currentStore = useTransferStore.getState();
      const currentTransfer = currentStore.transfers[transfer.id];

      // Quota exhaustion is permanent for this account state; retrying
      // burns three backoff rounds per book for the same 403.
      const isQuotaError = errorMessage.includes('Insufficient storage quota');
      // Served bytes that are not a book cannot be fixed by fetching them
      // again; fail now, keep the reason visible, let the rest of the queue run.
      const isIntegrityError = isBookIntegrityError(errorMessage);

      if (!isQuotaError && !isIntegrityError && currentTransfer && this.isOffline()) {
        // No network: hold the row without spending a retry. The `online`
        // listener releases it; the timed wake is only a fallback.
        currentStore.setTransferStatus(transfer.id, 'pending', OFFLINE_HOLD_MESSAGE);
        currentStore.setNextAttemptAt(transfer.id, Date.now() + OFFLINE_HOLD_MS);
      } else if (
        !isQuotaError &&
        !isIntegrityError &&
        currentTransfer &&
        currentTransfer.retryCount < currentTransfer.maxRetries
      ) {
        // Schedule retry with exponential backoff. The delay is enforced by
        // `nextAttemptAt` (persisted), not by the timer alone, so neither the
        // 100ms continuation loop nor an app restart can run it early.
        const delay = RETRY_DELAY_BASE_MS * Math.pow(2, currentTransfer.retryCount);
        currentStore.incrementRetryCount(transfer.id);
        currentStore.setTransferStatus(
          transfer.id,
          'pending',
          `Retry ${currentTransfer.retryCount + 1}/${currentTransfer.maxRetries}`,
        );
        currentStore.setNextAttemptAt(transfer.id, Date.now() + delay);

        setTimeout(() => {
          this.processQueue();
        }, delay);
      } else {
        // Background work fails quietly. The success path has always honoured
        // `isBackground`; the failure path did not, so a broken replica sync
        // fired one toast per file (issue #5675 — sixteen "Failed to download
        // file" toasts for sixteen fonts). The failure is still recorded on
        // the transfer, which is what the Transfer Queue panel reads.
        if (!transfer.isBackground) {
          if (errorMessage.includes('Not authenticated')) {
            eventDispatcher.dispatch('toast', {
              type: 'error',
              message: _(transferAuthMessage(isHouseholdBuild())),
            });
          } else if (isQuotaError) {
            this.recordQuotaFailure();
          } else {
            const errorMessages = getTransferMessages(
              { ...transfer, error: errorMessage },
              _,
            ).failure;

            eventDispatcher.dispatch('toast', {
              type: 'error',
              message: errorMessages[transfer.type],
            });
          }
        }

        useTransferStore.getState().setTransferStatus(transfer.id, 'failed', errorMessage);
      }
    } finally {
      // Drop any pending throttled progress + its trailing timer (a
      // failed/aborted transfer's stale progress must not fire after teardown).
      progressThrottle.cancel();
      this.abortControllers.delete(transfer.id);

      const currentStore = useTransferStore.getState();
      currentStore.setActiveCount(Math.max(0, currentStore.getActiveTransfers().length));
      this.persistQueue();

      // Continue processing
      setTimeout(() => this.processQueue(), 100);
    }
  }

  private recordQuotaFailure(): void {
    this.quotaFailureCount += 1;
    if (this.quotaToastTimer) clearTimeout(this.quotaToastTimer);
    this.quotaToastTimer = setTimeout(() => this.flushQuotaToast(), QUOTA_TOAST_FLUSH_MS);
  }

  private flushQuotaToast(): void {
    const _ = this._;
    const count = this.quotaFailureCount;
    this.quotaFailureCount = 0;
    this.quotaToastTimer = null;
    if (!count || !_) return;

    eventDispatcher.dispatch('toast', {
      type: 'error',
      message:
        count === 1
          ? _('Insufficient storage quota')
          : _('{{count}} uploads failed: insufficient storage quota', { count }),
    });
  }

  private async executeBookTransfer(
    transfer: TransferItem,
    progressHandler: (p: ProgressPayload) => void,
    _abortController: AbortController,
  ): Promise<void> {
    const _ = this._!;
    const library = this.getLibrary!();
    const book = library.find((b) => b.hash === transfer.bookHash);

    if (!book) {
      throw new Error(_('Book not found in library'));
    }

    if (transfer.type === 'upload') {
      await this.appService!.uploadBook(book, progressHandler);
      book.uploadedAt = Date.now();
      await this.updateBook!(book);
    } else if (transfer.type === 'download') {
      // `downloadBook` stamps `downloadedAt` itself, and only after the file
      // passed verification. Stamping here unconditionally turned every
      // resolved-but-unverified transfer into a durable "downloaded" shelf
      // state, which then suppressed the re-fetch on open.
      await this.appService!.downloadBook(book, false, false, progressHandler);
      if (!book.downloadedAt) {
        throw new Error(_('Book download did not produce a readable file'));
      }
      await this.updateBook!(book);
    } else if (transfer.type === 'delete') {
      await this.appService!.deleteBook(book, 'cloud');
      await this.updateBook!(book);
    }
  }

  private async executeReplicaTransfer(
    transfer: TransferItem,
    progressHandler: (p: ProgressPayload) => void,
    _abortController: AbortController,
  ): Promise<void> {
    const kind = transfer.replicaKind!;
    const replicaId = transfer.replicaId!;
    const files = transfer.replicaFiles ?? [];

    if (transfer.type === 'delete') {
      await this.appService!.deleteReplicaBundle(
        kind,
        replicaId,
        files.map((f) => f.logical),
      );
      eventDispatcher.dispatch('replica-transfer-complete', {
        kind,
        replicaId,
        type: 'delete',
        filenames: files.map((f) => f.logical),
      });
      return;
    }

    if (files.length === 0) {
      throw new Error(`replica ${transfer.type} requires replicaFiles on the transfer`);
    }

    const totalBytes = files.reduce((sum, f) => sum + f.byteSize, 0) || 1;
    let bytesAlreadyDone = 0;
    const fileProgressHandler =
      (filenameSize: number): ProgressHandler =>
      (p: ProgressPayload) => {
        const fileFraction = p.total > 0 ? p.progress / p.total : 0;
        const overallTransferred = bytesAlreadyDone + filenameSize * fileFraction;
        progressHandler({
          progress: overallTransferred,
          total: totalBytes,
          transferSpeed: p.transferSpeed,
        });
      };

    if (transfer.type === 'upload') {
      const base = transfer.replicaBase!;
      for (const file of files) {
        await this.appService!.uploadReplicaFile(
          kind,
          replicaId,
          file.logical,
          file.lfp,
          base,
          fileProgressHandler(file.byteSize),
        );
        bytesAlreadyDone += file.byteSize;
      }
      eventDispatcher.dispatch('replica-transfer-complete', {
        kind,
        replicaId,
        reincarnation: transfer.replicaReincarnation,
        type: 'upload',
        files,
      });
      return;
    }

    if (transfer.type === 'download') {
      const base = transfer.replicaBase!;
      for (const file of files) {
        await this.appService!.downloadReplicaFile(
          kind,
          replicaId,
          file.logical,
          file.lfp,
          base,
          fileProgressHandler(file.byteSize),
        );
        bytesAlreadyDone += file.byteSize;
      }
      eventDispatcher.dispatch('replica-transfer-complete', {
        kind,
        replicaId,
        type: 'download',
        files,
      });
      return;
    }
  }

  private async loadPersistedQueue(): Promise<void> {
    try {
      if (typeof localStorage === 'undefined') return;

      const stored = localStorage.getItem(TRANSFER_QUEUE_KEY);
      if (!stored) return;

      const data: PersistedQueueData = JSON.parse(stored);
      const store = useTransferStore.getState();

      // Restore all transfers using the store's restore method
      // This preserves the original IDs and handles in_progress -> pending conversion
      store.restoreTransfers(data.transfers, data.isQueuePaused);
    } catch (error) {
      console.error('Failed to load transfer queue:', error);
    }
  }

  private persistQueue(): void {
    try {
      if (typeof localStorage === 'undefined') return;

      const store = useTransferStore.getState();

      // Persist all transfers including completed (for history)
      const data: PersistedQueueData = {
        schemaVersion: QUEUE_SCHEMA_VERSION,
        transfers: store.transfers,
        isQueuePaused: store.isQueuePaused,
      };

      localStorage.setItem(TRANSFER_QUEUE_KEY, JSON.stringify(data));
    } catch (error) {
      console.error('Failed to persist transfer queue:', error);
    }
  }
}

export const transferManager = TransferManager.getInstance();
