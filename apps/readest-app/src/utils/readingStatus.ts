import type { ReadingStatus } from '@/types/book';

/**
 * Fraction of a book that has to be read before the shelf treats it as
 * "currently reading" on its own. Opening a book and closing it on the cover
 * (0–1%) is sampling, not reading; the household analytics showed eleven such
 * books cluttering the recent list while six books at 8–80% were the real
 * reading set.
 */
export const AUTO_READING_MIN_FRACTION = 0.03;

/**
 * Reading status the reader should persist after a progress event.
 *
 * - `unread` is cleared as soon as the reader moves (upstream behaviour).
 * - Reaching the end marks the book finished (upstream behaviour).
 * - New: crossing {@link AUTO_READING_MIN_FRACTION} with no explicit status
 *   marks the book `reading`, so the shelf's Reading filter and other devices
 *   see it without the user touching the status menu. An explicit
 *   finished/abandoned/reading status is never overridden here.
 */
export const deriveReadingStatus = (
  existing: ReadingStatus | undefined,
  progressPercentage: number,
  fraction: number,
): ReadingStatus | undefined => {
  let next = existing;
  if (existing === 'unread') next = undefined;
  if (progressPercentage >= 100 && existing !== 'finished') return 'finished';
  if (next === undefined && fraction >= AUTO_READING_MIN_FRACTION) return 'reading';
  return next;
};
