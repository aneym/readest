import { describe, expect, test, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import ShelfFilterBar from '@/app/library/components/ShelfFilterBar';

vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (s: string) => s }));

describe('ShelfFilterBar', () => {
  test('renders six chips with counts and reports the tapped one', () => {
    const onChange = vi.fn();
    render(
      <ShelfFilterBar
        value='reading'
        counts={{ reading: 3, fiction: 50, nonfiction: 42, volumes: 9, all: 96, finished: 2 }}
        onChange={onChange}
      />,
    );
    const chips = screen.getAllByRole('radio');
    expect(chips).toHaveLength(6);
    expect(chips[0]!.getAttribute('aria-checked')).toBe('true');
    expect(chips[1]!.textContent).toContain('Fiction');
    expect(chips[1]!.textContent).toContain('50');
    fireEvent.click(chips[2]!);
    expect(onChange).toHaveBeenCalledWith('nonfiction');
    cleanup();
  });
});
