import { describe, expect, it, vi } from 'vitest';
// Optional platform WASM is not built in this worktree; no Chinese conversion is exercised.
vi.mock('@/utils/simplecc', () => ({
  initSimpleCC: async () => {},
  runSimpleCC: (text: string) => text,
}));
import {
  deriveNarrationState,
  narrationStageLine,
} from '@/app/reader/hooks/useNarrationAvailability';

// Pure state precedence and stage rounding have combinatorial edge cases;
// these tables check real inputs, including absent ownership and stale failures.
const translate = (s: string, options?: Record<string, unknown>) =>
  Object.entries(options ?? {}).reduce(
    (text, [key, value]) => text.replace(`{{${key}}}`, String(value)),
    s,
  );

describe('narration availability', () => {
  it.each([
    ['queued', 'queued'],
    ['aligning', 'aligning'],
    ['candidate', 'needs-check'],
    ['ready-to-swap', 'swap-ready'],
    ['aligned', 'fetching-edition'],
    ['failed', 'failed'],
  ])('maps %s to %s and preserves actionable details', (pairState, expected) => {
    expect(
      deriveNarrationState({
        narratable: false,
        pair: {
          state: pairState!,
          stage: 'syncing',
          progress: 0.43,
          error: 'No match',
          pairId: 'pair-1',
        },
      }),
    ).toEqual({
      state: expected,
      stage: 'syncing',
      progress: 0.43,
      error: 'No match',
      pairId: 'pair-1',
    });
  });
  it('narration wins over a failed pair', () => {
    expect(
      deriveNarrationState({ narratable: true, pair: { state: 'failed', error: 'stale' } }),
    ).toEqual({ state: 'narrated' });
  });
  it.each([
    true,
    false,
    null,
    undefined,
  ])('uses ownership %s when there is no pair', (ownsAudiobook) => {
    const expected = ownsAudiobook == null ? 'unknown' : ownsAudiobook ? 'can-align' : 'none';
    for (const pair of [null, undefined, { state: 'none' }]) {
      expect(deriveNarrationState({ narratable: false, pair, ownsAudiobook })).toEqual({
        state: expected,
      });
    }
  });
  it.each([
    ['staging', 1, 'preparing the files'],
    ['importing', 1, 'preparing the files'],
    ['transcribing', 2, 'transcribing the audio'],
    ['syncing', 3, 'matching audio to text'],
    ['downloading', 4, 'checking the result'],
    ['validating', 4, 'checking the result'],
    ['swapping', 5, 'finishing up'],
    ['done', 5, 'finishing up'],
  ])('words stage %s, with optional progress and B&W rounding', (stage, n, words) => {
    expect(
      narrationStageLine(
        translate,
        { state: 'aligning', stage: String(stage), progress: 0.479 },
        false,
      ),
    ).toBe(`Step ${n} of 5: ${words}, 47%`);
    expect(
      narrationStageLine(
        translate,
        { state: 'aligning', stage: String(stage), progress: 0.479 },
        true,
      ),
    ).toBe(`Step ${n} of 5: ${words}, 45%`);
    expect(narrationStageLine(translate, { state: 'aligning', stage: String(stage) }, true)).toBe(
      `Step ${n} of 5: ${words}`,
    );
  });
  it.each([
    [-0.1, 0],
    [1.2, 100],
    [0, 0],
    [1, 100],
  ])('clamps progress %s', (progress, expected) => {
    expect(
      narrationStageLine(translate, { state: 'aligning', stage: 'syncing', progress }, true),
    ).toBe(`Step 3 of 5: matching audio to text, ${expected}%`);
  });
});
