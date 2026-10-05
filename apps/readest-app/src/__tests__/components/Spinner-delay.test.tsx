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
  const { rerender } = render(<Spinner loading bookOpen />);
  act(() => vi.advanceTimersByTime(599));
  expect(screen.queryByRole('status')).toBeNull();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.getByRole('status').textContent).toContain('Loading');
  rerender(<Spinner loading={false} bookOpen />);
  expect(screen.queryByRole('status')).toBeNull();
  rerender(<Spinner loading bookOpen />);
  act(() => vi.advanceTimersByTime(300));
  rerender(<Spinner loading={false} bookOpen />);
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.queryByRole('status')).toBeNull();
  rerender(<Spinner loading bookOpen />);
  act(() => vi.advanceTimersByTime(599));
  expect(screen.queryByRole('status')).toBeNull();
});

it('keeps ordinary callers immediate and applies their className to the indicator', () => {
  render(<Spinner loading className='text-gray-900' />);
  const status = screen.getByRole('status');
  expect(status.classList.contains('text-gray-900')).toBe(false);
  expect(status.querySelector('.loading')?.classList.contains('text-gray-900')).toBe(true);
});

it('delays household e-ink loading without an animated indicator', () => {
  vi.stubEnv('NEXT_PUBLIC_HOUSEHOLD_BUILD', '1');
  document.documentElement.setAttribute('data-eink', 'true');
  render(<Spinner loading />);
  expect(screen.queryByRole('status')).toBeNull();
  act(() => vi.advanceTimersByTime(600));
  expect(screen.getByRole('status').textContent).toContain('Loading');
  expect(screen.getByRole('status').querySelector('.loading')).toBeNull();
  document.documentElement.removeAttribute('data-eink');
  vi.unstubAllEnvs();
});
