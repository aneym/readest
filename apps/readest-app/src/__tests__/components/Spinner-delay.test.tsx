import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Spinner from '@/components/Spinner';

// DOM integration: time is the only fake. Protects the visible loading indicator,
// including cancellation across quick opens; existing library tests only test routing.
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('shows nothing for quick loads, and shows a status only after 600 ms', () => {
  const { rerender } = render(<Spinner loading />);
  act(() => vi.advanceTimersByTime(599));
  expect(screen.queryByRole('status')).toBeNull();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.getByRole('status').textContent).toContain('Loading');
  rerender(<Spinner loading={false} />);
  expect(screen.queryByRole('status')).toBeNull();
  rerender(<Spinner loading />);
  act(() => vi.advanceTimersByTime(300));
  rerender(<Spinner loading={false} />);
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.queryByRole('status')).toBeNull();
  rerender(<Spinner loading />);
  act(() => vi.advanceTimersByTime(599));
  expect(screen.queryByRole('status')).toBeNull();
});
