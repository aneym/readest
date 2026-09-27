const pairedEvent = 'homebase:paired';

export const signalHomebasePaired = () => {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(pairedEvent));
};

export const subscribeHomebasePaired = (listener: () => void): (() => void) => {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener(pairedEvent, listener);
  return () => window.removeEventListener(pairedEvent, listener);
};
