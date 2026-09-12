import { describe, expect, test } from 'vitest';
import { deriveReadingStatus, AUTO_READING_MIN_FRACTION } from '@/utils/readingStatus';

describe('deriveReadingStatus', () => {
  test('crossing the threshold with no status marks the book reading', () => {
    expect(deriveReadingStatus(undefined, 5, AUTO_READING_MIN_FRACTION)).toBe('reading');
    expect(deriveReadingStatus(undefined, 1, 0.005)).toBeUndefined();
  });
  test('unread clears on the first move and becomes reading past the threshold', () => {
    expect(deriveReadingStatus('unread', 1, 0.005)).toBeUndefined();
    expect(deriveReadingStatus('unread', 10, 0.1)).toBe('reading');
  });
  test('explicit statuses are respected; the end still finishes', () => {
    expect(deriveReadingStatus('abandoned', 50, 0.5)).toBe('abandoned');
    expect(deriveReadingStatus('reading', 50, 0.5)).toBe('reading');
    expect(deriveReadingStatus('finished', 100, 1)).toBe('finished');
    expect(deriveReadingStatus('reading', 100, 1)).toBe('finished');
    expect(deriveReadingStatus(undefined, 100, 1)).toBe('finished');
  });
});
