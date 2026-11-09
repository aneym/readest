import type { SyncResult } from '@/libs/sync';

export type HomebaseChannel = 'books' | 'configs' | 'notes' | 'statBooks' | 'statPages';

export const HOMEBASE_CHANNELS: readonly HomebaseChannel[] = [
  'books',
  'configs',
  'notes',
  'statBooks',
  'statPages',
] as const;

export const HOMEBASE_WIRE_VERSION = 1;

type HomebaseExtFields = Record<`hb${string}`, unknown>;

export type HomebaseBookRecord = Partial<NonNullable<SyncResult['books']>[number]> &
  HomebaseExtFields;
export type HomebaseConfigRecord = Partial<NonNullable<SyncResult['configs']>[number]> &
  HomebaseExtFields;
export type HomebaseNoteRecord = Partial<NonNullable<SyncResult['notes']>[number]> &
  HomebaseExtFields;
export type HomebaseStatBookRecord = NonNullable<SyncResult['statBooks']>[number];
export type HomebaseStatPageRecord = NonNullable<SyncResult['statPages']>[number];

export interface HomebaseRejection {
  family: string;
  id: string;
  reason: string;
}

export interface HomebaseEnvelope {
  books?: HomebaseBookRecord[] | null;
  configs?: HomebaseConfigRecord[] | null;
  notes?: HomebaseNoteRecord[] | null;
  statBooks?: HomebaseStatBookRecord[] | null;
  statPages?: HomebaseStatPageRecord[] | null;
  server_time?: string;
  schema_version?: number;
  rejected?: HomebaseRejection[];
}

export type HomebaseRecord =
  | HomebaseBookRecord
  | HomebaseConfigRecord
  | HomebaseNoteRecord
  | HomebaseStatBookRecord
  | HomebaseStatPageRecord;

export const channelRecords = (
  envelope: HomebaseEnvelope,
  channel: HomebaseChannel,
): HomebaseRecord[] => (envelope[channel] ?? []) as HomebaseRecord[];
