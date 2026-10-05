import type { ViewSettings } from '@/types/book';
import { isHouseholdBuild } from '@/services/household';
import { footerInfoVisible } from './footerBand';
import { isForcedMobileLayout } from './mobileLayout';

// Card height of the TTS mini player (h-14). See getTTSMiniPlayerClearance for
// when the reader text reserves a band of this height.
export const TTS_MINI_PLAYER_HEIGHT = 56;

// Docked e-ink strip: 2px top rule + the h-14 row.
export const TTS_DOCKED_STRIP_HEIGHT = 58;

// 64px mobile nav bar / 52px desktop footer bar, plus an 8px gap.
const ABOVE_MOBILE_BAR = 72;
const ABOVE_DESKTOP_BAR = 60;
const PANEL_GAP = 8;
const BASE_OFFSET = 16;

/**
 * Bottom offset (px) of the TTS mini player, excluding the safe-area inset
 * (applied separately as margin-bottom). The card stacks above whatever
 * occupies the bottom edge:
 *   - the bottom bar while it is shown (hoveredBookKey === bookKey), or the
 *     expanded action panel above it (panelTopOffset: measured distance from
 *     the bottom edge to the open panel's top, safe-area margin excluded)
 *   - the footer info band / floating pills once the bar is dismissed
 *   - otherwise a 16px resting offset above the bottom edge
 */
export const getTTSMiniPlayerBottomOffset = (
  viewSettings: ViewSettings,
  { barVisible = false, usesMobileBar = false, panelTopOffset = 0 } = {},
): number => {
  if (barVisible) {
    const aboveBar = usesMobileBar ? ABOVE_MOBILE_BAR : ABOVE_DESKTOP_BAR;
    return Math.max(aboveBar, panelTopOffset + PANEL_GAP);
  }
  const footerAtBottom =
    viewSettings.showFooter &&
    !viewSettings.vertical &&
    (footerInfoVisible(viewSettings) || viewSettings.showStickyProgressBar);
  return footerAtBottom ? Math.max(viewSettings.marginBottomPx, BASE_OFFSET) : BASE_OFFSET;
};

/**
 * Household e-ink phone layout: the mini player is not a floating card but a
 * full-width strip docked on the thumb bar (or the footer band when the bar is
 * hidden). It stays up for the whole session, so the book text reserves room
 * for it. Reads the viewport at call time, like isForcedMobileLayout.
 */
export const isDockedMiniPlayer = (isEink: boolean | undefined, isMobileApp?: boolean): boolean =>
  !!isEink && isHouseholdBuild() && (isForcedMobileLayout(isMobileApp) || window.innerWidth < 640);

/**
 * Bottom offset (px, safe-area excluded) of the docked strip while the thumb
 * bar is hidden: flush on the footer info band when one renders at the bottom,
 * otherwise flush on the screen edge.
 */
export const getDockedStripBottomOffset = (viewSettings: ViewSettings): number => {
  const footerAtBottom =
    viewSettings.showFooter &&
    !viewSettings.vertical &&
    (footerInfoVisible(viewSettings) || viewSettings.showStickyProgressBar);
  return footerAtBottom ? viewSettings.marginBottomPx : 0;
};

/**
 * Band of book text (px) kept clear for the mini player while a TTS session is
 * active, measured at the card's resting position (bottom bar dismissed).
 * FoliateViewer consumes it via applyMarginAndGap.
 *
 * The docked e-ink strip always earns one (it never auto-hides). Otherwise
 * only the 'minimal' card earns one. The 'full' card follows the toolbar and
 * auto-hides with it (#5310), so a permanent reservation would cost a line of
 * text for a card that is off screen most of the session; it overlaps the text
 * during its brief visible window instead, exactly as the toolbars do.
 */
export const getTTSMiniPlayerClearance = (
  viewSettings: ViewSettings,
  safeAreaBottom: number,
  { docked = false } = {},
): number => {
  if (docked) {
    return getDockedStripBottomOffset(viewSettings) + TTS_DOCKED_STRIP_HEIGHT + safeAreaBottom;
  }
  if (viewSettings.ttsPlayerStyle !== 'minimal') return 0;
  return getTTSMiniPlayerBottomOffset(viewSettings) + TTS_MINI_PLAYER_HEIGHT + safeAreaBottom;
};
