import { useRef } from 'react';

import { impactFeedback } from '@tauri-apps/plugin-haptics';
import { useEnv } from '@/context/EnvContext';
import { useDrag } from '@/hooks/useDrag';

const VELOCITY_THRESHOLD = 0.5;

export const useSwipeToDismiss = (
  onDismiss: () => void,
  onDragMove?: (data: { clientY: number }) => void,
  // Where a below-threshold release should settle, as a 0-1 fraction of the
  // screen the panel's top rests at. Defaults to 0 (full height) — the
  // annotate bottom sheet passes its partial anchor so a small drag snaps
  // back to the sheet instead of promoting it to full screen.
  restingTop?: () => number,
) => {
  const { appService } = useEnv();

  const panelRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const panelHeight = useRef(1.0);

  const handleVerticalDragMove = (data: { clientY: number }) => {
    const heightFraction = data.clientY / window.innerHeight;
    const newTop = Math.max(0.0, Math.min(1, heightFraction));
    panelHeight.current = newTop;

    const panel = panelRef.current;
    const overlay = overlayRef.current;

    if (panel && overlay) {
      panel.style.transition = 'none';
      panel.style.transform = `translateY(${newTop * 100}%)`;
      overlay.style.opacity = `${1 - heightFraction}`;
    }

    onDragMove?.(data);
  };

  const handleVerticalDragEnd = (data: { velocity: number; clientY: number }) => {
    const panel = panelRef.current;
    const overlay = overlayRef.current;

    if (!panel || !overlay) return;

    if (
      data.velocity > VELOCITY_THRESHOLD ||
      (data.velocity >= 0 && data.clientY >= window.innerHeight * 0.5)
    ) {
      const transitionDuration = 0.15 / Math.max(data.velocity, 0.5);
      panel.style.transition = `transform ${transitionDuration}s ease-out`;
      panel.style.transform = 'translateY(100%)';
      overlay.style.transition = `opacity ${transitionDuration}s ease-out`;
      overlay.style.opacity = '0';
      setTimeout(() => onDismiss(), 300);
      if (appService?.hasHaptics) {
        impactFeedback('medium');
      }
    } else {
      const top = Math.max(0, Math.min(1, restingTop?.() ?? 0));
      panel.style.transition = 'transform 0.3s ease-out';
      panel.style.transform = `translateY(${top * 100}%)`;
      overlay.style.transition = 'opacity 0.3s ease-out';
      overlay.style.opacity = top > 0 ? `${1 - top}` : '0.8';
      onDragMove?.({ clientY: top * window.innerHeight });
      if (appService?.hasHaptics) {
        impactFeedback('medium');
      }
    }
  };

  const handleVerticalDragKeyDown = () => {};

  const { handleDragStart: handleVerticalDragStart } = useDrag(
    handleVerticalDragMove,
    handleVerticalDragKeyDown,
    handleVerticalDragEnd,
    'row-resize',
  );

  return { panelRef, overlayRef, panelHeight, handleVerticalDragStart };
};
