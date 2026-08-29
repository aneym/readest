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
import type { SyncOutbox } from './outbox';

/**
 * The two methods the app actually calls on a record-sync backend. Written to
 * match `SyncClient`'s signatures exactly so `SyncClient` conforms without
 * being modified.
 */
export interface RecordSyncClient {
  pullChanges(
    since: number,
    type?: SyncType,
    book?: string,
    metaHash?: string,
    limit?: number,
  ): Promise<SyncResult>;
  pushChanges(payload: SyncData): Promise<SyncResult>;
}

/** Compile-time proof that the stock client already satisfies the seam. */
export type StockClientConformsToSeam = SyncClient extends RecordSyncClient ? true : never;

const EMPTY_RESULT: SyncResult = { books: null, configs: null, notes: null };

export interface HomebaseSyncClientOptions {
  adapter: HomebaseSyncAdapter;
  /**
   * Optional offline outbox. With one, a retryable push failure queues the rows
   * and RESOLVES — the local write is durable, so reporting failure to the user
   * would be a lie. Without one, the failure propagates exactly as the stock
   * client's does. A non-retryable failure always propagates.
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
    const envelope = await this.adapter.pull({
      since,
      // `SyncType` has no 'statBooks'/'statPages' members — 'stats' selects both
      // and the adapter expands it, matching how `statsSync.pullStats` calls in.
      ...(type ? { channel: type } : {}),
      ...(book ? { bookHash: book } : {}),
      ...(metaHash ? { metaHash } : {}),
      ...(limit ? { limit } : {}),
    });
    return decodeEnvelope(envelope);
  }

  async pushChanges(payload: SyncData): Promise<SyncResult> {
    const envelope = encodeSyncData(payload);
    try {
      return decodeEnvelope(await this.adapter.push(envelope));
    } catch (err) {
      const error =
        err instanceof HomebaseSyncError
          ? err
          : new HomebaseSyncError(err instanceof Error ? err.message : String(err));
      if (!this.outbox || !error.retryable) throw error;
      await this.outbox.enqueueEnvelope(envelope);
      this.onQueued?.(countRecords(payload), error);
      // Resolving with the empty result mirrors "nothing came back from the
      // server", which is true. `useSync.pushChanges` reads only the boolean
      // outcome, and `setSyncResult` treats null channels as "unsynced" rather
      // than "empty", so a queued push does not clear anything locally.
      return EMPTY_RESULT;
    }
  }

  /** Drain the outbox. Called by whatever the app already uses as a sync tick. */
  async flushOutbox() {
    if (!this.outbox) return null;
    return await this.outbox.flush((envelope) => this.adapter.push(envelope));
  }
}
