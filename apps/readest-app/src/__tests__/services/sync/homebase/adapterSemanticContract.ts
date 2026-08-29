import { describe, expect, test } from 'vitest';
import { HomebaseSyncError } from '@/services/sync/homebase/adapter';
import type { HomebaseSyncAdapter } from '@/services/sync/homebase/adapter';
import type {
  HomebaseBookRecord,
  HomebaseChannel,
  HomebaseRecord,
} from '@/services/sync/homebase/types';

/**
 * Transport-agnostic semantics every {@link HomebaseSyncAdapter} must honor.
 *
 * Same shape as `providerSemanticContract.ts`, and for the same reason that file
 * gives: a contract written against one implementation only documents that
 * implementation's wire quirks. The HTTP adapter is a pure transport (the server
 * does the filtering) while the memory adapter is a server (it filters itself),
 * so the situations below are ABSTRACT and each scenario stages them however its
 * backend must.
 *
 * The invariants worth this much ceremony are the ones a plausible Homebase
 * implementation gets wrong: dropping tombstones, throwing on an empty delta,
 * and marking an offline failure permanent so the outbox poisons a good write.
 */
export interface AdapterScenario {
  makeAdapter: () => HomebaseSyncAdapter;
  /** Make the next pull return exactly these rows on this channel. */
  stageRows: (channel: HomebaseChannel, rows: HomebaseRecord[]) => void;
  /** Make the next call fail with an auth failure (HTTP 401). */
  stageAuthFailure: () => void;
  /** Make the next call fail the way an offline device does. */
  stageNetworkFailure: () => void;
  /** Make the capabilities probe behave like a server that lacks it (404). */
  stageMissingCapabilities: () => void;
}

const book = (over: Partial<HomebaseBookRecord> = {}): HomebaseBookRecord => ({
  book_hash: 'hash-1',
  title: 'Piranesi',
  // Epoch ms, matching `BookDataRecord`. Stats are the only family whose
  // `updated_at` is ISO.
  updated_at: Date.parse('2026-08-01T00:00:00.000Z'),
  deleted_at: null,
  ...over,
});

export const runAdapterSemanticContract = (
  name: string,
  makeScenario: () => AdapterScenario,
): void => {
  describe(`${name} — HomebaseSyncAdapter semantic contract`, () => {
    test('exposes a non-empty endpointId', () => {
      expect(makeScenario().makeAdapter().endpointId).toBeTruthy();
    });

    test('pull resolves an envelope when there is nothing to return', async () => {
      const s = makeScenario();
      s.stageRows('books', []);
      const env = await s.makeAdapter().pull({ since: 0, channel: 'books' });
      expect(env.books ?? []).toEqual([]);
    });

    test('pull returns staged rows on the requested channel', async () => {
      const s = makeScenario();
      s.stageRows('books', [book()]);
      const env = await s.makeAdapter().pull({ since: 0, channel: 'books' });
      expect(env.books).toHaveLength(1);
      expect(env.books?.[0]?.book_hash).toBe('hash-1');
    });

    test('pull RETURNS tombstoned rows rather than filtering them', async () => {
      // A peer that never sees the delete keeps the row forever. This is the
      // single most common way a sync backend loses deletes, so it is asserted
      // against every transport rather than trusted.
      const s = makeScenario();
      const tombstone = Date.parse('2026-08-02T00:00:00.000Z');
      s.stageRows('books', [book({ deleted_at: tombstone })]);
      const env = await s.makeAdapter().pull({ since: 0, channel: 'books' });
      expect(env.books).toHaveLength(1);
      expect(env.books?.[0]?.deleted_at).toBe(tombstone);
    });

    test('pull maps an auth failure to HomebaseSyncError AUTH_FAILED, not retryable', async () => {
      const s = makeScenario();
      s.stageAuthFailure();
      const err = await s
        .makeAdapter()
        .pull({ since: 0 })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HomebaseSyncError);
      expect((err as HomebaseSyncError).code).toBe('AUTH_FAILED');
      // Retrying a revoked token forever is how an outbox wedges. Permanent.
      expect((err as HomebaseSyncError).retryable).toBe(false);
    });

    test('push maps an offline failure to a RETRYABLE error', async () => {
      const s = makeScenario();
      s.stageNetworkFailure();
      const err = await s
        .makeAdapter()
        .push({ books: [book()] })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HomebaseSyncError);
      // Not retryable here means the outbox poisons a perfectly good highlight.
      expect((err as HomebaseSyncError).retryable).toBe(true);
    });

    test('push echoes the resolved rows back', async () => {
      const s = makeScenario();
      s.stageRows('books', [book()]);
      const env = await s.makeAdapter().push({ books: [book()] });
      expect(env.books?.[0]?.book_hash).toBe('hash-1');
    });

    test('capabilities resolves null when the server lacks the probe', async () => {
      const s = makeScenario();
      s.stageMissingCapabilities();
      await expect(s.makeAdapter().capabilities()).resolves.toBeNull();
    });
  });
};
