import { describe, expect, test } from 'vitest';
import {
  actionsFor,
  chipFor,
  halfLabel,
  statusLine,
} from '@/app/library/components/request/requestModel';
import type {
  HalfStateName,
  PairStateName,
  RequestRecord,
  SearchResult,
} from '@/services/homebase/immersion/types';

const result = (
  ebook: HalfStateName,
  audiobook: HalfStateName,
  state: PairStateName = 'none',
): SearchResult => ({
  key: 'title|author',
  title: 'Title',
  author: 'Author',
  ebook: { state: ebook },
  audiobook: { state: audiobook },
  pair: { state, pairId: 'pair-1' },
});
const record = (state: PairStateName): RequestRecord => ({
  id: 'request-1',
  profileId: 'p',
  deviceId: 'd',
  title: 'Title',
  author: 'Author',
  want: 'pair',
  ebook: { state: 'requested' },
  audiobook: { state: 'requested' },
  pair: { state, progress: 0.43 },
  createdAt: 1,
  updatedAt: 1,
});

describe('request action matrix', () => {
  test.each([
    ['missing', 'missing', 'none', 'Get both', 'pair'],
    ['missing', 'have', 'none', 'Get ebook', 'ebook'],
    ['have', 'missing', 'none', 'Get audiobook', 'audiobook'],
    ['failed', 'failed', 'none', 'Get both', 'pair'],
    ['have', 'have', 'candidate', 'Confirm match', undefined],
    ['have', 'have', 'ready-to-swap', 'Use narrated edition', undefined],
    ['have', 'have', 'failed', 'Retry alignment', undefined],
    ['have', 'have', 'queued', undefined, undefined],
    ['have', 'have', 'aligning', undefined, undefined],
    ['have', 'have', 'aligned', undefined, undefined],
    ['have', 'have', 'none', undefined, undefined],
  ] as const)('%s ebook / %s audio / %s pair exposes %s', (ebook, audio, pair, label, want) => {
    const actions = actionsFor(result(ebook, audio, pair));
    expect(actions.map((action) => [action.label, action.want])).toEqual(
      label ? [[label, want]] : [],
    );
  });

  test('half labels narrate every acquisition state', () => {
    expect(
      (['have', 'missing', 'requested', 'acquiring', 'failed'] as const).map((state) =>
        halfLabel({ state }),
      ),
    ).toEqual(['Available', 'Not available', 'Requested', 'Getting it', 'Couldn’t get it']);
  });
});

describe('pair status narration', () => {
  test.each([
    ['none', 'Requested'],
    ['candidate', 'Confirm match'],
    ['queued', 'Queued for alignment'],
    ['aligning', 'Aligning 43%'],
    ['ready-to-swap', 'Ready to use narrated edition'],
    ['aligned', 'Narrated edition ready'],
    ['failed', 'Alignment failed'],
  ] as const)('%s reads %s', (state, expected) => {
    expect(statusLine(record(state), { isBwEink: false })).toBe(expected);
  });
  test('B/W e-ink floors alignment to five-percent steps, color retains integer', () => {
    expect(statusLine(record('aligning'), { isBwEink: true })).toBe('Aligning 40%');
    expect(chipFor({ state: 'aligning', progress: 0.43 }, { isBwEink: true })?.text).toBe(
      'Aligning 40%',
    );
    expect(chipFor({ state: 'aligning', progress: 0.43 }, { isBwEink: false })?.text).toBe(
      'Aligning 43%',
    );
  });
  test('none and aligned never render shelf chips', () => {
    expect(chipFor(undefined, { isBwEink: false })).toBeNull();
    expect(chipFor({ state: 'none' }, { isBwEink: false })).toBeNull();
    expect(chipFor({ state: 'aligned' }, { isBwEink: false })).toBeNull();
  });
});
