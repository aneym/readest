import type { SyncData, SyncResult, SyncType } from '@/libs/sync';
import type { HomebaseSyncAdapter, HomebaseSyncError } from './adapter';
import { decodeEnvelope, encodeSyncData } from './wire';
import {
  envelopeRejectionKeys,
  isDefiniteRejection,
  toSyncError,
  type FlushResult,
  type SyncOutbox,
} from './outbox';
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
  flushOutbox?(options?: { resendBlocked?: boolean }): Promise<FlushResult | null>;
}

export interface HomebaseSyncClientOptions {
  adapter: HomebaseSyncAdapter;
  outbox?: SyncOutbox;
  onQueued?: (count: number, error: HomebaseSyncError) => void;
}

const countRecords = (payload: SyncData): number =>
  (payload.books?.length ?? 0) +
  (payload.configs?.length ?? 0) +
  (payload.notes?.length ?? 0) +
  (payload.statBooks?.length ?? 0) +
  (payload.statPages?.length ?? 0);

const drainDiagnostic = (result: FlushResult) => {
  const counts = {
    pushed: result.pushed,
    remaining: result.remaining,
    rejected: result.newlyPoisoned,
  };
  const { stoppedBy } = result;
  const detail = stoppedBy
    ? { ...counts, code: stoppedBy.code, status: stoppedBy.status ?? null }
    : counts;
  if (stoppedBy && !isDefiniteRejection(stoppedBy)) {
    recordDiagnostic('sync.drain', 'warn', 'outbox drain paused; rows stay queued', detail);
  } else if (result.newlyPoisoned > 0) {
    recordDiagnostic('sync.drain', 'warn', 'outbox drain: server rejected rows', detail);
  } else if (result.pushed > 0) {
    recordDiagnostic('sync.drain', 'info', 'outbox drained', counts);
  }
};

export class HomebaseSyncClient implements RecordSyncClient {
  private readonly adapter: HomebaseSyncAdapter;
  private readonly outbox?: SyncOutbox;
  private readonly onQueued?: HomebaseSyncClientOptions['onQueued'];

  constructor(options: HomebaseSyncClientOptions) {
    this.adapter = options.adapter;
    this.outbox = options.outbox;
    this.onQueued = options.onQueued;
  }

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

  private async push(envelope: HomebaseEnvelope): Promise<HomebaseEnvelope> {
    const response = await this.request(() => this.adapter.push(envelope));
    reportPushAck(envelopeRejectionKeys(envelope), response.rejected);
    for (const row of response.rejected ?? []) {
      recordDiagnostic('sync.rejected', 'warn', 'server rejected sync row', { ...row });
    }
    return response;
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
    let response: HomebaseEnvelope;
    try {
      response = await this.push(envelope);
    } catch (err) {
      const error = toSyncError(err);
      if (!this.outbox || isDefiniteRejection(error)) throw error;
      await this.outbox.enqueueEnvelope(envelope, error);
      this.onQueued?.(countRecords(payload), error);
      return { books: null, configs: null, notes: null, queued: true };
    }
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
  }

  async flushOutbox(options: { resendBlocked?: boolean } = {}) {
    if (!this.outbox) return null;
    if (options.resendBlocked) {
      const resent = await this.outbox.requeueBlocked();
      if (resent > 0)
        recordDiagnostic('sync.resend', 'info', 'blocked rows queued again', { resent });
    }
    const result = await this.outbox.flush((envelope) => this.push(envelope));
    reportOutboxQueue([...(await this.outbox.pending()), ...result.poisoned]);
    drainDiagnostic(result);
    return result;
  }
}
