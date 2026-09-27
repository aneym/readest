// Mirrors Homebase server/immersion/types.ts; change both together.

export type HalfStateName = 'have' | 'missing' | 'requested' | 'acquiring' | 'failed';

export interface HalfState {
  state: HalfStateName;
  /** Calibre book id (ebook) or audiobook shelf id (audiobook) when known. */
  id?: string;
  /** Short human-readable detail, e.g. "downloading" or a failure reason. */
  detail?: string;
}

export type PairStateName =
  | 'none'
  | 'candidate'
  | 'queued'
  | 'aligning'
  | 'ready-to-swap'
  | 'aligned'
  | 'failed';

export interface PairState {
  state: PairStateName;
  pairId?: string;
  /** 0..1 within the current stage while aligning. */
  progress?: number;
  stage?: AlignStage;
  error?: string;
}

export interface SearchResult {
  /** Stable key: normalized "title|author". */
  key: string;
  title: string;
  author: string;
  year?: number;
  coverUrl?: string;
  isbn?: string;
  ebook: HalfState;
  audiobook: HalfState;
  pair: PairState;
}

export type RequestWant = 'ebook' | 'audiobook' | 'pair';

export interface RequestRecord {
  id: string;
  profileId: string;
  deviceId: string;
  title: string;
  author: string;
  isbn?: string;
  want: RequestWant;
  ebook: HalfState;
  audiobook: HalfState;
  pair: PairState;
  createdAt: number;
  updatedAt: number;
}

export type AlignStage =
  | 'staging'
  | 'importing'
  | 'transcribing'
  | 'syncing'
  | 'downloading'
  | 'validating'
  | 'swapping'
  | 'done';
