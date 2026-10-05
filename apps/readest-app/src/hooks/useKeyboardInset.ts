import { useEffect, useState } from 'react';

/** Match Notebook's viewport, VirtualKeyboard and Android native IME sources. */
export function useKeyboardInset(enabled: boolean) {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    if (!enabled) {
      setInset(0);
      return;
    }
    let nativeInset = 0;
    const viewport = window.visualViewport;
    const keyboard = (
      navigator as unknown as {
        virtualKeyboard?: {
          overlaysContent: boolean;
          boundingRect: { height: number };
          addEventListener: (type: string, listener: () => void) => void;
          removeEventListener: (type: string, listener: () => void) => void;
        };
      }
    ).virtualKeyboard;
    if (keyboard) {
      try {
        keyboard.overlaysContent = true;
      } catch {
        // Older WebViews still emit geometry events if the setter is rejected.
      }
    }
    const apply = () => {
      const layoutHeight = document.documentElement.clientHeight || window.innerHeight;
      const viewportInset = viewport
        ? Math.max(0, layoutHeight - viewport.height - viewport.offsetTop)
        : 0;
      setInset(Math.max(viewportInset, keyboard?.boundingRect.height ?? 0, nativeInset));
    };
    const nativeWindow = window as unknown as {
      onNativeImeInset?: (bottomDevicePx: number) => void;
    };
    const previous = nativeWindow.onNativeImeInset;
    const onNativeInset = (bottomDevicePx: number) => {
      previous?.(bottomDevicePx);
      nativeInset = Math.max(0, bottomDevicePx) / (window.devicePixelRatio || 1);
      apply();
    };
    nativeWindow.onNativeImeInset = onNativeInset;
    apply();
    viewport?.addEventListener('resize', apply);
    viewport?.addEventListener('scroll', apply);
    keyboard?.addEventListener('geometrychange', apply);
    return () => {
      viewport?.removeEventListener('resize', apply);
      viewport?.removeEventListener('scroll', apply);
      keyboard?.removeEventListener('geometrychange', apply);
      if (nativeWindow.onNativeImeInset === onNativeInset) {
        nativeWindow.onNativeImeInset = previous;
      }
    };
  }, [enabled]);
  return enabled ? inset : 0;
}
