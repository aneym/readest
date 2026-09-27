/**
 * The client seam (REVIEW-ONLY SPIKE).
 *
 * This is the whole point of the spike. `libs/sync.ts` exports a CONCRETE
 * `SyncClient` class, and exactly two places consume it:
 *
 *   - `context/SyncContext.tsx:6` constructs one and hands it to every reader
 *     surface through `useSyncContext()`.
 *   - `services/statistics/statsSync.ts:5-6` already depends on it
 *     STRUCTURALLY, via `Pick<SyncClient, 'pushChanges'>`.
 *
 * So the seam is a two-method structural interface. `SyncClient` satisfies it
 * as written — no edit to shipping code — and so does {@link HomebaseSyncClient}
 * below. Routing books/configs/notes/stats to Homebase is then a ONE-LINE change
 * in `SyncContext.tsx`:
 *
 *     -const syncClient = new SyncClient();
 *     +const syncClient = resolveRecordSyncClient();
 *
 * `src/__tests__/services/sync/homebase/seam.test.ts` proves both halves of that
 * claim (the type-level conformance and the runtime drop-in) without the edit
 * being applied, which is what keeps this branch review-only.
 *
 * KOSync is untouched by all of this. `services/sync/KOSyncClient.ts` speaks its
 * own protocol to its own server and shares nothing with `SyncClient`;
 * KOReader-compatible progress keeps flowing through it whichever record backend
 * is selected. See `homebase-kosync-isolation.test.ts`.
 */

import type { SyncClient, SyncData, SyncResult, SyncType } from '@/libs/sync';
import { HomebaseSyncError, type HomebaseSyncAdapter } from './adapter';
import { decodeEnvelope, encodeSyncData } from './wire';
import { isDefiniteRejection, type SyncOutbox } from './outbox';
import type { HomebaseEnvelope } from './types';
import { recordDiagnostic } from './diagnostics';
import {
  beginSyncRequest,
  endSyncRequest,
  reportOutboxQueue,
  reportPushAck,
  reportSyncError,
  reportSyncSuccess,
} from './syncStatus';

/**
 * The two methods the app actually calls on a record-sync backend. Written to
 * match `SyncClient`'s signatures exactly so `SyncClient` conforms without
 * being modified.
 */
export type RecordPushResult = SyncResult & {
  queued?: boolean;
  rejected?: HomebaseEnvelope['rejected'];
};

export interface RecordSyncClient {
  pullChanges(
    since: number,
    type?: SyncType,
    book?: string,
    metaHash?: string,
    limit?: number,
  ): Promise<SyncResult>;
  pushChanges(payload: SyncData): Promise<RecordPushResult>;
  flushOutbox?(): Promise<import('./outbox').FlushResult | null>;
}

/** Compile-time proof that the stock client already satisfies the seam. */
export type StockClientConformsToSeam = SyncClient extends RecordSyncClient ? true : never;

const EMPTY_RESULT: SyncResult = { books: null, configs: null, notes: null };

export interface HomebaseSyncClientOptions {
  adapter: HomebaseSyncAdapter;
  /**
   * Optional offline outbox. With one, all non-terminal failures (including
   * auth pauses and unknown failures) queue durably and resolve as queued.
   * Definite client rejections still propagate; without an outbox every failure
   * propagates exactly as the stock client's does.
   */
  outbox?: SyncOutbox;
  /** Called when rows are queued instead of sent, so the UI can show a badge. */
  onQueued?: (count: number, error: HomebaseSyncError) => void;
}

const countRecords = (payload: SyncData): number =>
  (payload.books?.length ?? 0) +
  (payload.configs?.length ?? 0) +
  (payload.notes?.length ?? 0) +
  (payload.statBooks?.length ?? 0) +
  (payload.statPages?.length ?? 0);

export class HomebaseSyncClient implements RecordSyncClient {
  private readonly adapter: HomebaseSyncAdapter;

  private async request<T>(run: () => Promise<T>): Promise<T> {
    beginSyncRequest();
    try {
      const result = await run();
      reportSyncSuccess();
      return result;
    } catch (error) {
      reportSyncError(error);
      throw error;
    } finally {
      endSyncRequest();
    }
  }
  private readonly outbox?: SyncOutbox;
  private readonly onQueued?: HomebaseSyncClientOptions['onQueued'];

  constructor(options: HomebaseSyncClientOptions) {
    this.adapter = options.adapter;
    this.outbox = options.outbox;
    this.onQueued = options.onQueued;
  }

  async pullChanges(
    since: number,
    type?: SyncType,
    book?: string,
    metaHash?: string,
    limit?: number,
  ): Promise<SyncResult> {
    const envelope = await this.request(() =>
      this.adapter.pull({
        since,
        // `SyncType` has no 'statBooks'/'statPages' members — 'stats' selects both
        // and the adapter expands it, matching how `statsSync.pullStats` calls in.
        ...(type ? { channel: type } : {}),
        ...(book ? { bookHash: book } : {}),
        ...(metaHash ? { metaHash } : {}),
        ...(limit ? { limit } : {}),
      }),
    );
    return decodeEnvelope(envelope);
  }

  async pushChanges(payload: SyncData): Promise<RecordPushResult> {
    const envelope = encodeSyncData(payload);
    try {
      const response = await this.request(() => this.adapter.push(envelope));
      this.handleRejected(envelope, response.rejected);
      if (this.outbox) {
        try {
          reportOutboxQueue(await this.outbox.settleAccepted(envelope, response.rejected));
        } catch (error) {
          recordDiagnostic('sync.outbox', 'warn', 'could not settle accepted sync rows', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return decodeEnvelope(response);
    } catch (err) {
      const error =
        err instanceof HomebaseSyncError
          ? err
          : new HomebaseSyncError(err instanceof Error ? err.message : String(err));
      if (!this.outbox || isDefiniteRejection(error)) throw error;
      await this.outbox.enqueueEnvelope(envelope, error);
      this.onQueued?.(countRecords(payload), error);
      return { ...EMPTY_RESULT, queued: true };
    }
  }

  private handleRejected(envelope: HomebaseEnvelope, rejected: HomebaseEnvelope['rejected']) {
    const sent = Object.entries(envelope).flatMap(([family, rows]) =>
      !Array.isArray(rows)
        ? []
        : rows.map((row: { book_hash?: string; bookHash?: string; id?: string }) => ({
            family,
            // Configs are keyed by book hash; the wire backfills `id` from it
            // because Homebase reports config rejections using record.id.
            id:
              family === 'configs'
                ? (row.book_hash ?? row.bookHash ?? row.id ?? '')
                : (row.id ?? row.book_hash ?? ''),
          })),
    );
    reportPushAck(sent, rejected);
    for (const row of rejected ?? []) {
      recordDiagnostic('sync.rejected', 'warn', 'server rejected sync row', row);
    }
  }

  /** Drain the outbox on startup, reconnect, resume, or manual Sync. */
  async flushOutbox() {
    if (!this.outbox) return null;
    const result = await this.outbox.flush(async (envelope) => {
      const response = await this.request(() => this.adapter.push(envelope));
      this.handleRejected(envelope, response.rejected);
      return response;
    });
    reportOutboxQueue([...(await this.outbox.pending()), ...result.poisoned]);
    return result;
  }
}
