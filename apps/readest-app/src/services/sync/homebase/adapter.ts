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
  status?: number;
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
  since: number;
  channel?: HomebaseChannel | 'stats';
  bookHash?: string;
  metaHash?: string;
  limit?: number;
}

export interface HomebaseSyncAdapter {
  pull(query: HomebasePullQuery): Promise<HomebaseEnvelope>;
  push(envelope: HomebaseEnvelope): Promise<HomebaseEnvelope>;
}
