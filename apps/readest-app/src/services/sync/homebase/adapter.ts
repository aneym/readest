/**
 * Transport abstraction for the Homebase reader API (REVIEW-ONLY SPIKE).
 *
 * Deliberately modelled on `services/sync/file/provider.ts`: that seam already
 * proved in this codebase that a narrow transport interface plus a shared
 * conformance suite is enough to add a backend without touching the engine
 * above it. This is the same move for the RECORD channels, which have no such
 * seam today — `libs/sync.ts` hard-codes `getAPIBaseUrl() + '/sync'` and a
 * Supabase bearer token.
 *
 * Error contract, matching `FileSyncError` so the two seams read alike:
 * a missing resource resolves (never throws) where "missing" is a normal
 * outcome; every other failure throws a {@link HomebaseSyncError} with a
 * normalised `code` so callers branch on auth / network / conflict without
 * knowing the transport.
 */

import type { HomebaseChannel, HomebaseEnvelope } from './types';

export type HomebaseErrorCode =
  | 'AUTH_FAILED'
  | 'NOT_FOUND'
  | 'NETWORK'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'UNKNOWN';

export class HomebaseSyncError extends Error {
  code: HomebaseErrorCode;
  /** HTTP status when the request reached the server, if applicable. */
  status?: number;
  /**
   * Whether a retry could plausibly succeed. The outbox reads this: a
   * retryable failure keeps the entry queued, a permanent one poisons it
   * instead of hammering the server forever.
   */
  retryable: boolean;

  constructor(
    message: string,
    code: HomebaseErrorCode = 'UNKNOWN',
    status?: number,
    retryable = code === 'NETWORK' || code === 'RATE_LIMITED',
  ) {
    super(message);
    this.name = 'HomebaseSyncError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export interface HomebasePullQuery {
  /** Cursor, epoch ms. Rows with a strictly newer server clock are returned. */
  since: number;
  /**
   * Restrict to one channel. Absent means every channel — the shape
   * `SyncClient.pullChanges` already supports with an empty `type`.
   */
  channel?: HomebaseChannel | 'stats';
  /** Restrict to one book hash (config/note per-book pulls). */
  bookHash?: string;
  /** Restrict to one metadata hash (edition-level pulls). */
  metaHash?: string;
  /** Page size. Required for books and stats, which page (#5832, #5833). */
  limit?: number;
}

/**
 * What a Homebase deployment claims to support. The client reads this once and
 * degrades rather than guessing: a Homebase that has not shipped stats yet
 * should make the app skip that channel, not fail every sync on a 404.
 */
export interface HomebaseCapabilities {
  channels: readonly HomebaseChannel[];
  /** Object storage for book bytes / covers is available. */
  storage: boolean;
  /** `note.audio` payloads are accepted and returned. */
  noteAudio: boolean;
  /** Wire schema version the server speaks. */
  schemaVersion: number;
}

export interface HomebaseSyncAdapter {
  /** Stable id for logs and the outbox's per-endpoint queue key. */
  readonly endpointId: string;

  /**
   * Advertised capabilities. Resolves `null` when the server does not expose
   * the probe — an older Homebase — which the caller treats as "assume the v1
   * channel set", never as "unusable".
   */
  capabilities(): Promise<HomebaseCapabilities | null>;

  /** Incremental pull. Throws on any non-2xx; an empty delta is `{}`, not an error. */
  pull(query: HomebasePullQuery): Promise<HomebaseEnvelope>;

  /**
   * Push a batch. The server applies the same LWW + field-clock rules the
   * client uses locally (see `clocks.ts`) and returns the resolved rows, so a
   * client that lost a merge learns the winning value from its own push.
   */
  push(envelope: HomebaseEnvelope): Promise<HomebaseEnvelope>;
}
