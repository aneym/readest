# Readest on BOOX Palma 2 Pro Color: e-ink crispness and zoom workflow

Scope: fork checkout at `/Volumes/StudioExt/repos/personal/readest-homebase-landing-v1/apps/readest-app/`, read-only. Device: BOOX Palma 2 Pro Color, Android 15, BOOX firmware 4.1.1, 824x1648 @ 300dpi, Kaleido color e-ink. No code was changed and no device was touched during this research.

## 1. What the code already has, and whether it activates on BOOX

E-ink detection is automatic. It does not need a setting flipped.

- `src-tauri/src/android/eink.rs` reads Android system properties at startup (`ro.product.manufacturer`, `ro.product.brand`, `ro.product.model`, `ro.product.device`) through `__system_property_get`, and matches them against an allowlist that includes `"onyx"` and `"boox"`. It also falls back to `ro.eink.support` and `ro.onyx.devicename`. A Palma 2 Pro reports manufacturer/brand containing "onyx" and carries `ro.onyx.devicename`, so it matches on the first check.
- `src-tauri/src/lib.rs` (around line 580) calls `android::is_eink_device()` and injects the result into the WebView as `window.__READEST_IS_EINK = true` before the page loads.
- `src/services/nativeAppService.ts` line 575 reads that flag: `override isEink = Boolean(window.__READEST_IS_EINK)`.
- `src/services/settingsService.ts` spreads `DEFAULT_EINK_VIEW_SETTINGS` (from `src/services/constants.ts` lines 408-412: `{ isEink: true, animated: false, volumeKeysToFlip: true }`) into the default view settings whenever the context's `isEink` is true.
- `src/hooks/useEinkMode.ts` sets `document.documentElement.setAttribute('data-eink', isEink.toString())` and adds a `no-transitions` class to `<body>`.
- `tailwind.config.ts` (lines 32-39) defines `eink:`/`not-eink:` variants keyed on `html[data-eink="true"] &`.

What actually changes under e-ink mode, confirmed by reading the consuming code:

- All CSS transitions and animations are killed globally: `globals.css` line 765, `.no-transitions * { transition: none !important; animation: none !important; }`.
- `src/utils/style.ts` `getEinkSelectionStyles()` inverts text-selection colors for visibility on e-ink.
- `getColorStyles()` forces an opaque body background and underlines links when `isEink` is true (no transparency, no color-only affordances).
- `globals.css` lines 521-765 add e-ink-specific chrome styling (`.eink-bordered`, `.eink-inverted`, borders on buttons/modals/dropdowns/checkboxes/the TTS scrubber) so UI controls stay legible without relying on subtle shadows or color contrast.
- Volume keys are bound to page-flip by default (`volumeKeysToFlip: true`) instead of system volume.
- A native full-screen refresh path exists: `src-tauri/plugins/tauri-plugin-native-bridge/android/src/main/java/EinkRefreshController.kt` tries, in order, `View.refreshScreen` (Onyx/BOOX reflection call), `View.postInvalidateDelayed` (NTX/Tolino/Nook), and `View.requestEpdMode` (Rockchip/Boyue), each vendor-specific and reached via reflection. The comment in that file says this approach is adapted from KOReader's EPD controller pattern. It triggers a GC16-style full black/white refresh to clear ghosting, exposed to JS as `refreshEinkScreen()` in `src/utils/bridge.ts` and wired to a dedicated `refresh` page-turn action in `src/app/reader/hooks/usePagination.ts`.

What is not touched: no font-smoothing, antialiasing, or text-rendering CSS anywhere in the codebase for book content. The e-ink work covers animation suppression, contrast/borders for UI chrome, input rebinding, and ghost clearing. It does not touch how glyphs render inside the book iframe.

As of this checkout, PR readest/readest#5803 ("expose data-eink on the book document for per-device custom CSS"), merged 2026-08-20, mirrors the `data-eink` attribute from the top document onto the book content iframe's document (`applyEinkModeAttribute()` in `src/utils/style.ts`). This means a user's Custom Content CSS can now target `html[data-eink='true']` selectors that apply only on e-ink devices, without leaking to a synced LCD device on the same account. This is recent and directly relevant to section 3 below.

Sources: local code inspection, confirmed against `readest/readest#5803` via `gh pr view 5803 --repo readest/readest`.

## 2. Device-side settings to pin

No adb command or broadcast exists for setting BOOX per-app optimization values. This was checked directly and the answer is no, not "not found yet." Onyx's per-app refresh/DPI/contrast settings on firmware 4.x are proprietary and, per community research, moved to a binary MMKV-format config file (`/onyxconfig/mmkv/onyx_config`) that is not editable without root and is hard to edit even then. Rooting instructions exist for the Palma 2 specifically (see jdkruzr/BooxPalma2RootGuide on GitHub) but that is a different risk tier than a settings command and is out of scope for this research (no device interaction was performed).

Manual path, since firmware 4.1 the settings panel is renamed EinkWise (formerly E Ink Center):

1. Open the app drawer, long-press the Readest icon (or Readest Dev), select "Optimize."
2. Under the general tab: check "Use App Default DPI" (Readest already renders at the app's native resolution; letting BOOX override DPI adds another scaling pass on top of the WebView's own layout), check "Bold Font" if available at the OS level (separate from Readest's own font-weight, this is a system-wide stroke-boost), uncheck "Whiten Apps Background" (Readest already forces an opaque background under e-ink per section 1, so BOOX's own background bleach is redundant and can wash out cover art or color panels in the Kaleido display).
3. Under the Refresh tab: for a paginated reading app, "HD" or "Text" mode gives the sharpest per-page render since Readest already does discrete page turns rather than continuous scroll, so refresh speed matters less than glyph clarity. "Balanced" is the fallback if HD feels sluggish on page turns. "Speed"/"Fast"/"Ultrafast" modes trade ghosting for scroll smoothness and are built for continuous-scroll content (browsers, feeds), not a fixed-page reader.
4. Dark color enhancement (contrast boost) on, light color filter (background whitening) on if the paper-white background looks gray, off if it clips light-colored cover art.

This is a one-time manual setup per app (`com.bilingify.readest` and `com.bilingify.readest.dev` would need to be configured separately), not something scriptable today.

Sources: [EinkWise (E Ink Center) - BOOX Help Center](https://help.boox.com/hc/en-us/articles/10701257505044-E-Ink-Center), [BOOX Firmware V4.1 overview](https://shop.boox.com/blogs/news/boox-firmware-v4-1-overview-of-new-features-and-upgrades), [Per app eink "optimizations" - MobileRead](https://www.mobileread.com/forums/showthread.php?t=363318), [Optimizing Apps on BOOX eReader - BOOX Malaysia](https://booxmalaysia.com/optimizing-apps-on-boox-for-better-reading-experience/), [BooxPalma2RootGuide](https://github.com/jdkruzr/BooxPalma2RootGuide).

## 3. Fork-side changes, ranked by effort and payoff

Baseline note: the e-ink work in this codebase is upstream Readest, actively maintained, not something the fork added. Cross-checked fork commits against the `upstream` remote and confirmed the relevant PRs exist and are merged on `readest/readest` (#2887 initial e-ink detection, #4687 refresh controller, #5803 iframe data-eink mirroring). The right move for the fork is to track upstream rather than build parallel e-ink features.

Ranked:

1. **CSS only, via the Custom Content CSS setting (`src/components/settings/MiscPanel.tsx`, field key `settings.custom.contentCss`), no code change.** Now that #5803 mirrors `data-eink` onto the book iframe, a user can paste `html[data-eink='true'] { ... }` rules directly into Settings > Misc > "Custom Content CSS" and have them apply only on the BOOX device. This is the lowest-effort, zero-risk option and should be tried first: font-weight bump, `-webkit-text-stroke` for thicker glyph edges, and paragraph spacing adjustments can all go here without touching the repo. Readest's own maintainer (chrox, in issue #5795, see section 5) suggested exactly this pattern as the workaround for the CJK font-weight bug.

2. **CSS only, via the Custom Reader UI CSS field (`settings.custom.readerUiCss`).** Same mechanism, targets the reader chrome (toolbars, panels) rather than book content. Lower payoff for "crispness" specifically since chrome isn't what's read continuously, but useful if button/icon edges look soft.

3. **Code change: debounce the font-size slider.** `src/app/reader/components/footerbar/FontLayoutPanel.tsx` `handleFontSizeChange` calls `saveViewSettings` on every native `<input type="range">` tick with no debounce, and `saveViewSettings` (`src/helpers/settings.ts`) triggers a real `renderer.setStyles()` repaint each time. On an LCD this is invisible; on e-ink each tick is a partial refresh and a drag across the slider produces a burst of refreshes. A `useDeferredValue` or trailing-debounce (150-250ms) on the commit call, committing only on drag-end or after a pause, would cut repaints to one per adjustment. Small, contained change, single file plus its call site.

4. **Code change: pull upstream's e-ink work forward as new PRs land.** Given the fork already carries #2887/#4687/#5803, the ongoing-payoff move is watching `readest/readest` issues tagged eink/BOOX (see section 5) and merging forward rather than reinventing. Effort scales with how far the fork has drifted from upstream; not assessed here since that requires a git diff exercise the read-only scope of this task did not call for.

Deliberately not recommended: a repo-wide `-webkit-font-smoothing` change. That property only affects WebKit browsers on macOS/iOS; it has no effect on Android's WebView (Chromium-based, uses its own subpixel/grayscale AA logic controlled by the OS, not by this CSS property). Any writeup that cites it as an Android e-ink fix is wrong.

Sources: local code inspection, `readest/readest#5795` via `gh issue view`.

## 4. Zoom workflow today, and the fastest improvement

Two separate systems exist under the name "zoom." Do not conflate them:

- **Book-content zoom** (`zoomLevel`, `MIN_ZOOM_LEVEL`/`MAX_ZOOM_LEVEL`/`ZOOM_STEP` = 50/500/10 in `src/services/constants.ts`): triggered by ctrl+scroll-wheel or pinch gesture, handled in `src/app/reader/hooks/useIframeEvents.ts` and `useBookShortcuts.ts`.
- **Image/table viewer zoom** (`src/app/reader/components/ZoomControls.tsx`): a separate zoom-in/out/reset UI for viewing embedded images and tables full-screen, unrelated to reading-text size.

For reading text size specifically, the control is the Font Size slider in the Aa panel (`FontLayoutPanel.tsx`, range 8-30pt, default 16). As covered in section 3, every drag tick commits and repaints immediately with no debounce, so dragging from 16pt to 22pt on e-ink produces a visible flash per intermediate value rather than one clean jump.

By contrast, the pinch-zoom gesture for book content is already e-ink-appropriate: `useIframeEvents.ts` calls `renderer.pinchEnd?.()` and dispatches the `'pinch-zoom'` event only once, on `onTouchEnd`, not per pinch-frame. Ctrl+scroll-wheel zoom (`'zoom-in'`/`'zoom-out'` events per wheel tick) has the same continuous-repaint problem as the slider, but is desktop-only and not relevant to a phone.

Fastest improvement: debounce the font-size slider commit (section 3, item 3). This is the one place in the current zoom/text-size workflow that causes avoidable repeated e-ink repaints during a single user action, and the fix pattern (defer/debounce the commit, keep the visual slider position instant) already has a working precedent in the same codebase in how pinch-zoom is handled.

Hardware buttons: the Palma 2 Pro's physical scroll/page buttons map through `src/utils/keybinding.ts`, whose `PageTurnAction` type is a closed union: `'pagePrev' | 'pageNext' | 'sectionPrev' | 'sectionNext' | 'refresh'`. There is no action variant for zoom or font-size, so hardware buttons cannot be bound to them without adding a new `PageTurnAction` case and its handler. That is a real code change, not a config option.

## 5. Open questions

- Whether BOOX's binary `onyxconfig/mmkv/onyx_config` format (firmware 4.0+) could be edited by a rooted install to pin per-app refresh mode was not resolved. Community writeups describe the file existing and its format but not a working edit method for the current firmware. This would need direct experimentation on a rooted device, which this task's scope excluded.
- The exact glyph rendering pipeline BOOX's Kaleido panel controller applies on top of what Chromium's WebView outputs (dithering, grayscale reduction from the panel's own driver) was not found documented anywhere primary. This matters for judging how much a CSS font-weight/stroke change on the Readest side will actually be visible after the panel's own processing, versus how much is out of the app's control entirely.
- Issue readest/readest#2253 ("Ghosting when swiping pages on eINK devices") was still open as of the last comment, with the maintainer's workaround being "switch to Clicks to paginate" rather than a fix for swipe-triggered ghosting. Whether this remains open in the current upstream state, and whether the fork has since picked up a fix, was not checked (would require a fresh `gh issue view` at ship time, not research time).
- No primary BOOX source was found stating whether "HD" refresh mode on the Palma 2 Pro specifically (versus other BOOX models) meaningfully changes glyph sharpness for static text versus just refresh latency. The section 2 recommendation to use HD/Text mode is inferred from the documented speed/quality tradeoff, not confirmed against a BOOX benchmark for this exact device.
- The exact upstream drift between this fork and `readest/readest` HEAD (how many commits behind, whether any e-ink-adjacent PRs since #5803 haven't been pulled) was not measured. A `git log --oneline fork/main..upstream/main` on the actual checkout would answer this in a couple of minutes but was outside this task's question list.

Sources cited inline throughout; GitHub references verified via `gh issue view` / `gh pr view` / `gh search issues` against `readest/readest`, not by web search summary alone.
