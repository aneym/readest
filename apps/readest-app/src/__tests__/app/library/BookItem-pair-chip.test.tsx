import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Book } from '@/types/book';
import type { PairState } from '@/services/homebase/immersion/types';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ user: { id: 'p' } }) }));
vi.mock('@/context/EnvContext', () => ({ useEnv: () => ({ appService: { isMobile: true } }) }));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (key: string) => key }));
vi.mock('@/hooks/useResponsiveSize', () => ({ useResponsiveSize: () => 15 }));
vi.mock('@/components/BookCover', () => ({ default: () => <div aria-label='cover' /> }));
vi.mock('@/app/library/components/ReadingProgress', () => ({ default: () => null }));

import BookItem from '@/app/library/components/BookItem';
import { useSettingsStore } from '@/store/settingsStore';
import { useImmersionStore } from '@/store/immersionStore';

const book: Book = {
  hash: 'b',
  format: 'EPUB',
  title: 'Shelf title',
  author: 'Author',
  createdAt: 1,
  updatedAt: 1,
};
const props = {
  book,
  mode: 'grid' as const,
  coverFit: 'crop' as const,
  isSelectMode: false,
  bookSelected: false,
  transferProgress: null,
  handleBookUpload: vi.fn(),
  handleBookDownload: vi.fn(),
  showBookDetailsModal: vi.fn(),
  showTimeRemaining: false,
};
const show = (pair: PairState, mode: 'grid' | 'list' = 'grid') => {
  useImmersionStore.getState().setPairs({ b: pair });
  return render(<BookItem {...props} mode={mode} />);
};
beforeEach(() => {
  useImmersionStore.setState({ pairByHash: {}, sheet: { open: false, tab: 'find', query: '' } });
  useSettingsStore.setState({
    settings: { globalViewSettings: { isEink: true, isColorEink: false } } as never,
  });
});
afterEach(cleanup);

describe('shelf pair chips', () => {
  test.each([
    ['candidate', 'Confirm match', true],
    ['queued', 'Queued', false],
    ['aligning', 'Aligning 40%', false],
    ['ready-to-swap', 'Use narrated edition', true],
    ['failed', 'Alignment failed', true],
  ] as const)('%s exposes %s with action inversion %s', (state, label, needsAction) => {
    show({ state, progress: 0.43 });
    const chip = screen.getByRole('button', { name: label });
    expect(chip.className.includes('eink-inverted')).toBe(needsAction);
    expect((chip as HTMLButtonElement).disabled).toBe(!needsAction);
    if (needsAction) {
      fireEvent.click(chip);
      expect(useImmersionStore.getState().sheet.tab).toBe('requests');
    }
  });
  test.each(['none', 'aligned'] as const)('%s leaves cover without a chip', (state) => {
    show({ state });
    expect(
      screen.queryByRole('button', {
        name: /Confirm match|Queued|Aligning|Use narrated edition|Alignment failed/,
      }),
    ).toBeNull();
  });
  test('list mode announces the pair state as a text line', () => {
    show({ state: 'queued' }, 'list');
    expect(screen.getByText('Queued')).toBeTruthy();
  });
});
