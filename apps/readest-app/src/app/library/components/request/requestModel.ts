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
      return 'In library';
    case 'missing':
      return 'Not in library';
    case 'requested':
      return 'Requested';
    case 'acquiring':
      return 'Downloading';
    case 'failed':
      return `Failed: ${half.detail ?? ''}`.trimEnd();
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
  if (needEbook && needAudio)
    return [
      { label: 'Get both', want: 'pair' },
      { label: ebook.state === 'failed' ? 'Retry ebook' : 'Ebook only', want: 'ebook' },
      { label: audiobook.state === 'failed' ? 'Retry audiobook' : 'Audio only', want: 'audiobook' },
    ];
  if (needEbook)
    return [{ label: ebook.state === 'failed' ? 'Retry ebook' : 'Get ebook', want: 'ebook' }];
  if (needAudio)
    return [
      {
        label: audiobook.state === 'failed' ? 'Retry audiobook' : 'Get audiobook',
        want: 'audiobook',
      },
    ];
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
      return { text: 'Check', needsAction: true };
    case 'queued':
      return { text: 'Queued', needsAction: false };
    case 'aligning':
      return { text: `${percent(pair.progress, isBwEink)}%`, needsAction: false };
    case 'ready-to-swap':
      return { text: 'Ready', needsAction: true };
    case 'failed':
      return { text: 'Failed', needsAction: true };
  }
};

export const statusLine = (record: RequestRecord, { isBwEink }: { isBwEink: boolean }): string => {
  switch (record.pair.state) {
    case 'candidate':
      return 'Check the match';
    case 'queued':
      return 'Waiting to align';
    case 'aligning':
      return `Aligning ${percent(record.pair.progress, isBwEink)}%`;
    case 'ready-to-swap':
      return 'Narration ready';
    case 'aligned':
      return 'Narrated';
    case 'failed':
      return 'Alignment failed';
    case 'none':
      if (record.ebook.state === 'acquiring' || record.audiobook.state === 'acquiring')
        return 'Downloading';
      if (record.ebook.state === 'failed' || record.audiobook.state === 'failed') return 'Failed';
      return 'Requested';
  }
};

export const listLine = (pair: PairState, { isBwEink }: { isBwEink: boolean }): string => {
  switch (pair.state) {
    case 'none':
    case 'aligned':
      return '';
    case 'candidate':
      return 'Narration: check the match';
    case 'queued':
      return 'Narration: waiting to align';
    case 'aligning':
      return `Narration: aligning ${percent(pair.progress, isBwEink)}%`;
    case 'ready-to-swap':
      return 'Narration: ready';
    case 'failed':
      return 'Narration: alignment failed';
  }
};
