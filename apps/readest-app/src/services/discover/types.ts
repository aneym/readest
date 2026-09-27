// Copied verbatim from Homebase packages/domain/src/books-discovery.ts
// (worktree books-discovery-20260927, working tree as of 2026-09-27, which
// adds requestId and DiscoverQueuedRequest). Do not import across repos: when
// the contract changes, copy it again. Only the quote style differs.
//
// Books Discover contract: 'what we can get'. Served by server/books-discovery
// at /api/books/discover/*, consumed by the web Discover page and the Readest
// fork. Household/tailnet only (classifyMediaRequest); the Cloudflare lane is
// denied. POST routes need `content-type: application/json`,
// `x-homebase-media-action: 1` and an allowed Origin (loopback or
// https://studio.tailf266ac.ts.net). Contract doc:
// docs/wiki/books/discover/contract.md.

export type DiscoverKind = 'ebook' | 'audiobook';

// `mam` is a reserved slot (no account yet); `annas` is manual only and never
// searched or downloaded automatically.
export type DiscoverProviderId = 'prowlarr' | 'libgen' | 'abb' | 'librivox' | 'mam' | 'annas';

export type DiscoverProviderState = 'ok' | 'degraded' | 'unavailable' | 'unconfigured' | 'manual';

export interface DiscoverProviderStatus {
  id: DiscoverProviderId;
  label: string;
  kinds: DiscoverKind[];
  state: DiscoverProviderState;
  /** Human reason when state is not 'ok' ('VPN lane down', 'no account yet'). */
  detail: string | null;
  /** Results this provider contributed to the response; null when not searched. */
  resultCount: number | null;
  latencyMs: number | null;
}

/** One obtainable release of a work from one provider. */
export interface DiscoverOffer {
  /** Opaque, server-issued, valid for at least one hour. Never a URL. */
  id: string;
  provider: DiscoverProviderId;
  kind: DiscoverKind;
  protocol: 'torrent' | 'http';
  /** Release name as the provider lists it. */
  releaseTitle: string;
  /** Lowercase extension: epub, azw3, mobi, pdf, m4b, mp3, ... */
  format: string | null;
  sizeBytes: number | null;
  /** ISO 639-1 when known ('en'). */
  language: string | null;
  seeders: number | null;
  /** Audiobook bitrate/narrator or ebook edition note, display only. */
  quality: string | null;
  /** Audiobooks only, when the provider lists them. */
  narrator: string | null;
  durationSeconds: number | null;
  /** 0..100, server ranking; offers arrive sorted best first. */
  score: number;
}

/** `shelfKey` is the /books work key, for 'Open in Books' links. */
export interface DiscoverOwnership {
  ebook: {
    calibreId: number;
    formats: string[];
    shelfKey: string | null;
  } | null;
  audiobook: { absItemId: string; shelfKey: string | null } | null;
}

/** Whether downloads can start right now (VPN fail-closed lane). */
export interface DiscoverAcquisitionStatus {
  state: 'ok' | 'vpn_down' | 'unknown';
  detail: string | null;
  checkedAt: number;
}

export interface DiscoverSeries {
  name: string;
  index: number | null;
}

export interface DiscoverWork {
  /**
   * Stable key from normalized title + first author's surname ('dune|herbert').
   * Idempotency and /work?key= use it; identifiers carry exact editions.
   */
  key: string;
  title: string;
  authors: string[];
  series: DiscoverSeries | null;
  year: number | null;
  coverUrl: string | null;
  description: string | null;
  identifiers: {
    openLibraryWork?: string;
    isbn13?: string;
    googleBooks?: string;
    asin?: string;
  };
  owned: DiscoverOwnership;
  /**
   * False when offers have not been looked up yet (browse shelves). Fetch
   * GET /api/books/discover/work?title=&author= to fill them.
   */
  offersChecked: boolean;
  ebooks: DiscoverOffer[];
  audiobooks: DiscoverOffer[];
  /** Jobs for this work that are not terminal. */
  activeJobIds: string[];
}

export interface DiscoverSearchResponse {
  query: string;
  works: DiscoverWork[];
  /** True when more than the 30 returned works matched. No pagination in v1. */
  truncated: boolean;
  providers: DiscoverProviderStatus[];
  acquisition: DiscoverAcquisitionStatus;
  tookMs: number;
}

export interface DiscoverWorkResponse {
  work: DiscoverWork;
  providers: DiscoverProviderStatus[];
  acquisition: DiscoverAcquisitionStatus;
}

export interface DiscoverProvidersResponse {
  providers: DiscoverProviderStatus[];
  acquisition: DiscoverAcquisitionStatus;
}

export type DiscoverShelfId = 'trending' | 'new' | 'more-by-author' | 'series-gaps';

export interface DiscoverShelf {
  /** Unique per response ('more-by-author:le guin'). */
  key: string;
  id: DiscoverShelfId;
  title: string;
  /** 'Because you own The Expanse 1-3', 'More by Ursula K. Le Guin'. */
  reason: string | null;
  works: DiscoverWork[];
}

export interface DiscoverBrowseResponse {
  shelves: DiscoverShelf[];
  generatedAt: number;
}

export type DiscoverJobStage =
  | 'queued'
  | 'searching'
  | 'downloading'
  | 'importing'
  | 'on_shelf'
  | 'failed'
  | 'cancelled';

export const DISCOVER_TERMINAL_STAGES: readonly DiscoverJobStage[] = [
  'on_shelf',
  'failed',
  'cancelled',
];

export type DiscoverFailureCode =
  | 'vpn_down'
  | 'not_found'
  | 'provider_error'
  | 'download_stalled'
  | 'import_timeout'
  | 'already_owned'
  | 'internal';

export interface DiscoverAlignment {
  state: 'waiting' | 'queued' | 'aligning' | 'aligned' | 'needs_confirm' | 'failed';
  progress: number | null;
  detail: string | null;
  immersionPairId: string | null;
  updatedAt: number;
}

export interface DiscoverJob {
  id: string;
  requestId: string | null;
  /** Set only on pair jobs once both halves are on_shelf; waiting means the alignment service isn't reachable yet. */
  alignment: DiscoverAlignment | null;
  workKey: string;
  title: string;
  author: string;
  coverUrl: string | null;
  kind: DiscoverKind;
  /** Shared by the ebook and audiobook jobs of one 'pair' request. */
  pairId: string | null;
  stage: DiscoverJobStage;
  /** 0..100 while downloading; null otherwise or when unknown. */
  percent: number | null;
  bytesDone: number | null;
  bytesTotal: number | null;
  etaSeconds: number | null;
  offer: Pick<DiscoverOffer, 'provider' | 'releaseTitle' | 'format' | 'sizeBytes'> | null;
  failure: { code: DiscoverFailureCode; message: string } | null;
  /** Where it landed; set only once confirmed in Calibre or Audiobookshelf. */
  shelf: { calibreId?: number; absItemId?: string; shelfKey?: string } | null;
  attempts: number;
  canRetry: boolean;
  canCancel: boolean;
  createdAt: number;
  updatedAt: number;
}

export type DiscoverWant = 'ebook' | 'audiobook' | 'pair';

export interface DiscoverRequestBody {
  title: string;
  author: string;
  want: DiscoverWant;
  /** Client-generated id matching /^[A-Za-z0-9_-]{8,64}$/; stable across offline replays. */
  requestId?: string;
  /** Pin a specific offer from a search; omitted = server picks the best offer. */
  ebookOfferId?: string;
  audiobookOfferId?: string;
}

export interface DiscoverRequestResponse {
  /** New, replayed, or already-active jobs; idempotent per requestId and active workKey+kind. */
  jobs: DiscoverJob[];
}

/** Device-side outbox shape shared by the web page, Readest fork, and launcher. */
export interface DiscoverQueuedRequest {
  requestId: string;
  body: DiscoverRequestBody & { requestId: string };
  queuedAt: number;
  attempts: number;
  lastError: string | null;
}

export interface DiscoverJobsResponse {
  jobs: DiscoverJob[];
  /** Server clock in milliseconds at response time; use as the next catch-up cursor. */
  serverTime: number;
}

export interface DiscoverJobResponse {
  job: DiscoverJob;
}

export interface DiscoverErrorResponse {
  error: string;
}
