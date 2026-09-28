/**
 * globals.css forces every button's text to base-content on e-ink. A button
 * that paints its own inverted pairing (base-content fill, base-100 label)
 * then showed base-content on base-content: the blank selected filter chip on
 * the BOOX Palma. The exception must stay narrow: a `text-base-100` label on
 * a light fill (the updater's `btn-warning`) keeps the dark e-ink ink, and an
 * e-ink-only `eink:bg-base-content eink:text-base-100` button on `bg-primary`
 * (Discover's request buttons) is repainted as paper with an ink label.
 *
 * Assert resolved colors against the resolved ink and paper, in the e-ink day
 * and true-black night themes the Palma runs.
 */

import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { page } from 'vitest/browser';

await import('@/styles/globals.css');

beforeAll(async () => {
  await page.viewport(800, 600);
});
afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-eink');
  document.documentElement.removeAttribute('data-theme');
});

const THEMES = ['contrast-light', 'contrast-dark'] as const;

const paint = (theme: string, className: string) => {
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.setAttribute('data-eink', 'true');
  const { getByRole } = render(
    <button type='button' className={className}>
      Fiction
    </button>,
  );
  const style = getComputedStyle(getByRole('button'));
  return { color: style.color, background: style.backgroundColor };
};

// The resolved e-ink ink and paper for a theme, read off plain elements.
const inkAndPaper = (theme: string) => {
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.setAttribute('data-eink', 'true');
  const { container } = render(
    <>
      <div data-testid='ink' className='text-base-content' />
      <div data-testid='paper' className='text-base-100' />
    </>,
  );
  const color = (id: string) =>
    getComputedStyle(container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!).color;
  const out = { ink: color('ink'), paper: color('paper') };
  cleanup();
  return out;
};

type Tone = 'ink' | 'paper';

// background null: a colored fill the e-ink CSS leaves alone.
const CASES: [string, string, { background: Tone | null; color: Tone }][] = [
  [
    'selected chip',
    'border-base-content bg-base-content text-base-100',
    { background: 'ink', color: 'paper' },
  ],
  [
    'e-ink-only inverted request button',
    'bg-primary text-primary-content eink:bg-base-content eink:text-base-100',
    { background: 'paper', color: 'ink' },
  ],
  [
    'light-fill text-base-100 button',
    'btn btn-warning text-base-100',
    { background: null, color: 'ink' },
  ],
];

describe.each(THEMES)('e-ink button labels (%s)', (theme) => {
  it.each(CASES)('%s', (_name, className, want) => {
    const tones = inkAndPaper(theme);
    const { color, background } = paint(theme, className);

    expect(color).toBe(tones[want.color]);
    expect(color).not.toBe(background);
    if (want.background) expect(background).toBe(tones[want.background]);
  });
});
