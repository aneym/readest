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

No adb command or broadcast exists for setting BOOX per-app optimization values through any supported, public interface. This was checked directly and the answer is no, not "not found yet." Onyx's per-app refresh/DPI/contrast settings on firmware 4.x are proprietary and, per community research, moved to a binary MMKV-format config file that is not editable without root and is hard to edit even then.

Root-only fallback, unverified, for the record only (no device interaction was performed and this was not attempted): a MobileRead thread ([Per app eink "optimizations"](https://www.mobileread.com/forums/showthread.php?t=363318)) documents the on-device config location and a community tool for it. Pre-4.0 firmware keeps a JSON file at `/onyxconfig/eac_config`; 4.0+ (which the Palma 2 Pro runs) moved to a binary MMKV store at `/onyxconfig/mmkv/onyx_config`, with keys such as `globalActivityConfig/refreshConfig/updateMode` and `dpiConfig/dpi`. A community-built tool called `onyxcfg` (pushed via `adb push onyxcfg /data/local/tmp` while the relevant Onyx service is stopped, then restarted) can read/write these keys. This requires root, is unofficial, and no ready-made non-root ADB one-liner exists — do not present this as a supported path.

Manual GUI path — two entry points were found across sources and likely both work (firmware may have moved the menu between versions; check both on-device before writing docs):

1. **Settings → Apps & Notifications → App Refresh Mode → select the app** — set the mode directly. Since firmware 4.1 the underlying settings panel is also referred to as EinkWise (formerly E Ink Center).
2. **App drawer → long-press the Readest icon (or Readest Dev) → "Optimize"**, or the bottom e-ink quick-menu → "⋯" → app optimization. Under this panel:
   - General tab: check "Use App Default DPI" (Readest already renders at its native resolution; letting BOOX override DPI adds a second scaling pass on top of the WebView's own layout); uncheck "Whiten Apps Background" (Readest already forces an opaque background under e-ink per section 1, so BOOX's own background bleach is redundant and can wash out cover art or color panels on the Kaleido display); check "Bold Font"/"Eliminate font-aliasing" if present (a system-wide stroke-boost/anti-aliasing toggle, separate from and additive to any font-weight change made in Readest's own Custom CSS, section 3).
   - A separate **Color/Text Outline** slider (reported by community writeups, not confirmed on Palma 2 Pro specifically) — setting it to 3 is reported to sharpen glyph edges.
   - Refresh mode options are **HD, Balanced, Fast, Ultrafast**, plus a fifth **Regal** mode on BSR-equipped panels (Palma 2 Pro qualifies) described as "minimal ghosting, some flickering with dark backgrounds" — see the open question in section 5.

For a paginated reading app specifically: use **HD**. BOOX's own material describes HD as "designed for deep reading — incredibly sharp text with the least ghosting, just like reading printed books," and independent tips writeups recommend HD explicitly for e-reader apps (e.g. setting Kindle to HD). Balanced/Fast/Ultrafast trade sharpness for scroll/browse responsiveness, which is the wrong tradeoff for Readest's discrete full-page-turn model — those modes exist for continuous-scroll content (browsers, feeds).

Dark color enhancement (contrast boost): on. Light color filter (background whitening): on if the paper-white background looks gray, off if it clips light-colored cover art.

This is a one-time manual setup per app — `com.bilingify.readest` and `com.bilingify.readest.dev` need to be configured separately — not something scriptable today.

Sources: [EinkWise (E Ink Center) - BOOX Help Center](https://help.boox.com/hc/en-us/articles/10701257505044-E-Ink-Center), [BOOX Firmware V4.1 overview](https://shop.boox.com/blogs/news/boox-firmware-v4-1-overview-of-new-features-and-upgrades), [Per app eink "optimizations" - MobileRead](https://www.mobileread.com/forums/showthread.php?t=363318), [Optimizing Apps on BOOX eReader - BOOX Malaysia](https://booxmalaysia.com/optimizing-apps-on-boox-for-better-reading-experience/), [BOOX Super Refresh (BSR) Technology](https://shop.boox.com/blogs/news/boox-super-refresh-bsr-technology), [Boox Palma Tips and Tricks](https://tabletsage.com/boox-palma-tips-tricks/), [BooxPalma2RootGuide](https://github.com/jdkruzr/BooxPalma2RootGuide).

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

## Additional upstream GitHub issues (readest/readest)

A second research pass turned up four more issues in the same tracker, beyond the ones cited in sections 1 and 3 (#2887, #4687, #5795, #5803, #2253):

- [#5140](https://github.com/readest/readest/issues/5140) (closed, unresolved) — BOOX Note5+ user reports random horizontal-line refresh artifacts after the e-ink refresh action shipped. Maintainer could not reproduce on a Leaf5 and closed the issue pending video evidence. Worth watching on Palma 2 Pro since it's a different panel generation than either device in the thread.
- [#2311](https://github.com/readest/readest/issues/2311) (closed) — footer/progress-bar text too small and low-contrast (grey) to read on e-ink. No confirmed fix logged in the thread; possibly superseded by the broader contrast work in sections 1/2, not verified.
- [#2659](https://github.com/readest/readest/issues/2659) (closed) — general "plans to improve e-ink experience" roadmap ask. Maintainer confirmed ongoing intent, pointed at the existing Contrast theme as a partial answer, and asked for specific reports rather than committing to a scoped e-ink initiative. This is the seed thread most of the other e-ink issues trace back to.
- [#827](https://github.com/readest/readest/issues/827) (closed) → superseded by [#4142](https://github.com/readest/readest/pull/4142) (merged) — old request for an alternate/updatable WebView on e-ink devices whose system WebView is locked or stale; #4142 shipped an in-process WebView upgrade path that addresses it.

Net read: there is no dedicated "e-ink mode" roadmap beyond what's already in the code (section 1) plus the per-device custom-CSS hook from #5803. The maintainer's stated position (#5795, #2659) is that fixed values (a built-in stroke width, a built-in font-weight bump) are wrong for the range of panels/fonts in the wild, and the deliberate design choice is to expose the `data-eink` hook and let device-specific CSS live in user Custom CSS rather than in the app.

## 5. Open questions

- Whether BOOX's binary MMKV config format (firmware 4.0+, keys `globalActivityConfig/refreshConfig/updateMode`, `dpiConfig/dpi` per the MobileRead `onyxcfg` thread) could be edited on a rooted Palma 2 Pro to pin per-app refresh mode was not resolved beyond confirming the key names exist in community documentation. No working, current-firmware edit walkthrough was found. This would need direct experimentation on a rooted device, which this task's scope excluded.
- Whether "Regal" mode (BSR-equipped devices, Palma 2 Pro qualifies) is actually offered as an option for a WebView-based app like Readest, and whether it beats HD for static text specifically, is unconfirmed — the Palma-specific tips article that enumerates HD/Balanced/Fast/Ultrafast doesn't mention Regal at all, while the general BSR technology page does. Check the on-device Optimize panel for a Regal entry before recommending it over HD.
- The exact glyph rendering pipeline BOOX's Kaleido panel controller applies on top of what Chromium's WebView outputs (dithering, grayscale reduction from the panel's own driver) was not found documented anywhere primary. This matters for judging how much a CSS font-weight/stroke change on the Readest side will actually be visible after the panel's own processing, versus how much is out of the app's control entirely.
- Issue readest/readest#2253 ("Ghosting when swiping pages on eINK devices") was still open as of the last comment, with the maintainer's workaround being "switch to Clicks to paginate" rather than a fix for swipe-triggered ghosting. Whether this remains open in the current upstream state, and whether the fork has since picked up a fix, was not checked (would require a fresh `gh issue view` at ship time, not research time).
- No primary BOOX source was found stating whether "HD" refresh mode on the Palma 2 Pro specifically (versus other BOOX models) meaningfully changes glyph sharpness for static text versus just refresh latency. The section 2 recommendation to use HD is inferred from the documented speed/quality tradeoff plus general reader-app guidance, not confirmed against a BOOX benchmark for this exact device.
- The exact upstream drift between this fork and `readest/readest` HEAD (how many commits behind, whether any e-ink-adjacent PRs since #5803 haven't been pulled — including #5140, #2311, #2659, #4142 above) was not measured. A `git log --oneline fork/main..upstream/main` on the actual checkout would answer this in a couple of minutes but was outside this task's question list.
- No source was found confirming or denying whether Android/Chromium WebView applies subpixel vs grayscale antialiasing differently based on panel type (LCD vs e-ink), or whether `-webkit-font-smoothing` has any effect in Chromium at all (it is WebKit/Safari-specific; Chromium's font rendering is controlled by the OS/FreeType stack, not this CSS property) — flagged in section 3 as a myth to avoid propagating, but a citable Chromium source for "this property is a no-op here" was not located, only general web-platform knowledge that the property is non-standard and WebKit-only.

Sources cited inline throughout; GitHub references verified via `gh issue view` / `gh pr view` / `gh search issues` against `readest/readest`, not by web search summary alone.
