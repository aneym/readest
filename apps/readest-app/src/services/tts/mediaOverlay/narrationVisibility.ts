// Whether the reader page is on screen, as recorded narration needs to know it.
//
// With the screen off (BOOX lock, phone locked, app in the background) the
// WebView stays alive but Chromium throttles its timers to once a second, and
// to once a minute after five minutes, and stops producing frames at all. The
// narration client uses this to stop depending on timers while hidden and to
// stop asking an e-ink panel nobody is looking at to repaint.
//
// Only 'hidden' counts as hidden: 'prerender' and a missing document (SSR,
// workers) read as visible so nothing changes off the reader.

const readHidden = (): boolean =>
  typeof document !== 'undefined' && document.visibilityState === 'hidden';

export const isNarrationHidden = (): boolean => readHidden();

// Calls `onChange` with the new state on each real hidden/visible transition.
// Repeated 'visibilitychange' events with no change in state are dropped, so a
// subscriber sees strictly alternating values. Returns the unsubscribe.
export const onNarrationVisibility = (onChange: (hidden: boolean) => void): (() => void) => {
  if (typeof document === 'undefined') return () => {};
  let last = readHidden();
  const handler = () => {
    const hidden = readHidden();
    if (hidden === last) return;
    last = hidden;
    onChange(hidden);
  };
  document.addEventListener('visibilitychange', handler);
  return () => document.removeEventListener('visibilitychange', handler);
};
