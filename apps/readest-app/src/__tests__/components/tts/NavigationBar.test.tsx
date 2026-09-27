import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const { bookData, readerState } = vi.hoisted(() => ({
  bookData: { hasNarration: false },
  readerState: { ttsEnabled: false, isEink: true, isColorEink: false },
}));
vi.mock('@/context/EnvContext', () => ({ useEnv: () => ({ appService: null }) }));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (key: string) => key }));
vi.mock('@/hooks/useResponsiveSize', () => ({ useResponsiveSize: (size: number) => size }));
vi.mock('@/store/readerStore', () => ({
  useReaderStore: () => ({
    getViewState: () => readerState,
    getViewSettings: () => readerState,
  }),
}));
vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: () => ({ getBookData: () => ({ book: bookData }) }),
}));
vi.mock('@/store/sidebarStore', () => ({
  useSidebarStore: () => ({ isSideBarVisible: false, isSideBarPinned: false }),
}));

import { NavigationBar } from '@/app/reader/components/footerbar/NavigationBar';

const renderBar = () =>
  render(
    <NavigationBar
      bookKey='book-1'
      actionTab=''
      gridInsets={{ top: 0, bottom: 0, left: 0, right: 0 }}
      forceMobileLayout={true}
      onSetActionTab={vi.fn()}
    />,
  );

describe('NavigationBar narration affordance', () => {
  afterEach(() => {
    cleanup();
    bookData.hasNarration = false;
    readerState.ttsEnabled = false;
  });

  it('keeps Speak when this book has no narration', () => {
    renderBar();
    expect(screen.getByRole('button', { name: 'Speak' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Listen' })).toBeNull();
  });

  it('shows Listen for a narrated book and inverts its active icon on B/W e-ink', () => {
    bookData.hasNarration = true;
    readerState.ttsEnabled = true;
    renderBar();
    const button = screen.getByRole('button', { name: 'Listen' });
    expect(screen.queryByRole('button', { name: 'Speak' })).toBeNull();
    expect(button.querySelector('.eink-inverted')).not.toBeNull();
  });
});
