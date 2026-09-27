import type {
  HalfState,
  PairState,
  RequestRecord,
  RequestWant,
  SearchResult,
} from '@/services/homebase/immersion/types';

export const halfLabel = (half: HalfState): string => {
  switch (half.state) {
    case 'have':
      return 'Available';
    case 'missing':
      return 'Not available';
    case 'requested':
      return 'Requested';
    case 'acquiring':
      return 'Getting it';
    case 'failed':
      return 'Couldn’t get it';
  }
};

export type ResultAction = {
  label: string;
  want?: RequestWant;
  pairId?: string;
  operation?: 'confirm' | 'realign';
};

export const actionsFor = (result: SearchResult): ResultAction[] => {
  const { ebook, audiobook, pair } = result;
  if (pair.state === 'candidate' && pair.pairId)
    return [{ label: 'Confirm match', pairId: pair.pairId, operation: 'confirm' }];
  if (pair.state === 'ready-to-swap' && pair.pairId)
    return [{ label: 'Use narrated edition', pairId: pair.pairId, operation: 'confirm' }];
  if (pair.state === 'failed' && pair.pairId)
    return [{ label: 'Retry alignment', pairId: pair.pairId, operation: 'realign' }];
  if (pair.state === 'queued' || pair.state === 'aligning' || pair.state === 'aligned') return [];
  const needEbook = ebook.state === 'missing' || ebook.state === 'failed';
  const needAudio = audiobook.state === 'missing' || audiobook.state === 'failed';
  if (needEbook && needAudio) return [{ label: 'Get both', want: 'pair' }];
  if (needEbook) return [{ label: 'Get ebook', want: 'ebook' }];
  if (needAudio) return [{ label: 'Get audiobook', want: 'audiobook' }];
  return [];
};

const percent = (progress: number | undefined, isBwEink: boolean) => {
  const value = Math.max(0, Math.min(100, Math.floor((progress ?? 0) * 100)));
  return isBwEink ? Math.floor(value / 5) * 5 : value;
};

export const chipFor = (
  pair: PairState | undefined,
  { isBwEink }: { isBwEink: boolean },
): { text: string; needsAction: boolean } | null => {
  if (!pair) return null;
  switch (pair.state) {
    case 'none':
    case 'aligned':
      return null;
    case 'candidate':
      return { text: 'Confirm match', needsAction: true };
    case 'queued':
      return { text: 'Queued', needsAction: false };
    case 'aligning':
      return { text: `Aligning ${percent(pair.progress, isBwEink)}%`, needsAction: false };
    case 'ready-to-swap':
      return { text: 'Use narrated edition', needsAction: true };
    case 'failed':
      return { text: 'Alignment failed', needsAction: true };
  }
};

export const statusLine = (record: RequestRecord, { isBwEink }: { isBwEink: boolean }): string => {
  switch (record.pair.state) {
    case 'candidate':
      return 'Confirm match';
    case 'queued':
      return 'Queued for alignment';
    case 'aligning':
      return `Aligning ${percent(record.pair.progress, isBwEink)}%`;
    case 'ready-to-swap':
      return 'Ready to use narrated edition';
    case 'aligned':
      return 'Narrated edition ready';
    case 'failed':
      return 'Alignment failed';
    case 'none':
      if (record.ebook.state === 'acquiring' || record.audiobook.state === 'acquiring')
        return 'Getting your book';
      if (record.ebook.state === 'failed' || record.audiobook.state === 'failed')
        return 'Couldn’t get your book';
      if (record.ebook.state === 'have' && record.audiobook.state === 'have')
        return 'Both editions available';
      return 'Requested';
  }
};
