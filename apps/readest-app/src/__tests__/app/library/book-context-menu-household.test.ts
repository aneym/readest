import { describe, expect, it, vi } from 'vitest';

const { householdBuild } = vi.hoisted(() => ({ householdBuild: { value: false } }));
vi.mock('@/services/household', () => ({ isHouseholdBuild: () => householdBuild.value }));

import { getBookContextMenuItemIds } from '@/app/library/utils/libraryUtils';
import { transferAuthMessage } from '@/services/transferManager';
import { Book } from '@/types/book';

const book: Book = {
  hash: 'hash-1',
  format: 'EPUB',
  title: 'Test Book',
  author: 'Test Author',
  createdAt: 0,
  updatedAt: 0,
  downloadedAt: 1,
};

describe('household book affordances', () => {
  it('offers a share link only outside household builds', () => {
    householdBuild.value = false;
    expect(getBookContextMenuItemIds(book)).toContain('share');

    householdBuild.value = true;
    expect(getBookContextMenuItemIds(book)).not.toContain('share');
  });

  it('asks household devices to pair instead of logging in when transfers need authentication', () => {
    expect(transferAuthMessage(true)).toBe('Pair this device with Homebase to transfer books.');
    expect(transferAuthMessage(false)).toBe('Please log in to continue');
  });
});
