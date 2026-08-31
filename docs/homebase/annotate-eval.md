# Annotate-flow eval

A repeatable, machine-checkable eval for the mobile annotate UX. Run it on
EVERY build that touches the notebook, the sheet, keyboard handling, or
MainActivity insets. The runner is a QA agent driving the emulator with the
argent tools; a human never has to eyeball a regression that this file
catches. Update this file when a new failure class appears.

## Preconditions

- Emulator `readest-qa` (`emulator-5554`) booted, `com.bilingify.readest.dev`
  installed (verify `lastUpdateTime` matches the build under test).
- Docked keyboard: `adb shell settings put secure stylus_handwriting_enabled 0`
  once per AVD, then relaunch the app.
- A book open in PAGINATED mode, positioned mid-chapter (not cover, not TOC).
- CDP bridge for WebView discovery:
  `adb forward tcp:9222 localabstract:webview_devtools_remote_$(adb shell pidof com.bilingify.readest.dev | tr -d '\r')`
- Logcat cleared at start: `adb logcat -c`.

## The page-stability invariant (checked at EVERY step)

Capture the reader's position indicator (the footer page/progress label in the
reader DOM) and the first ~80 chars of visible section text before the flow
starts. At every checkpoint below, both must be IDENTICAL unless the step
explicitly turns a page. Any drift = FAIL "page turned under the flow".
This is the invariant that catches: taps leaking through the sheet/overlay to
the page-turn zones, and keyboard-driven WebView resizes repaginating the book
(the failure Alex spotted by eye on 2026-08-31).

## Viewport-stability invariant

`window.innerHeight` / `document.documentElement.clientHeight` must NOT change
at any point in the flow — keyboard up included. The IME inset reaches the
page via the `window.onNativeImeInset` bridge (logcat tag MainActivity
"IME inset bottom=N" shows the native side firing); only the sheet translates.
A viewport change means someone reintroduced a WebView resize → FAIL.

## Fixture and targeting notes (learned 2026-08-31)

- The Gutenberg Alice EPUB carries `a:hover { color: red }` in its own author
  CSS, and its chapter anchor (`a#chap01`) wraps whole chapters — a touch can
  leave that anchor stuck in `:hover` (classic mobile sticky-hover), turning
  every paragraph in the chapter red. This is the BOOK's CSS, not an app or
  device bug: log it when seen, do not fail the run on it, and clear it with
  a restart if it obscures a screenshot. Identified by a matched-rule trace
  (walk ancestors, `el.matches(sel)` against every stylesheet selector) via
  `debugger-evaluate`; note `debugger-inspect-element` is an RN/Metro-only
  tool and errors on this Tauri WebView app — don't reach for it here.
- Coordinate guard before EVERY reader tap/long-press: resolve the target via
  elementFromPoint at the exact screen coordinates you are about to use and
  confirm it returns the intended word's node. Foliate offsets section
  iframes horizontally, so iframe-local coordinates are not screen
  coordinates; a stale transform lands presses on the wrong element (the
  "collapsed selection at some heading" signature). No guard pass, no press.
- After any Cancel/dismiss, check `getSelection()` — the cancel path
  currently leaves the browser selection alive (known app bug, on the fix
  list); clear it with one plain tap on the page, never `removeAllRanges()`
  via CDP.
- Steps 1-2 note: the note textarea auto-focuses when the sheet opens, so the
  keyboard rises as part of step 1's action; treat the step 1/2 split as one
  observation window.

## Steps and expectations

| # | Action | PASS condition |
|---|---|---|
| 1 | Long-press a fresh word → tap Annotate (back-to-back, toolbar auto-dismisses) | Sheet opens at partial anchor: CDP frame top 0.45±0.02; page visible+dimmed above; page-stability holds |
| 2 | Tap the note field → docked keyboard rises | Logcat inset ~real keyboard height; viewport UNCHANGED; sheet top ≈ 0.45 − inset_css/viewportH (±0.03); textarea + Save above keyboard (native screenshot, not CDP); page-stability holds |
| 3 | Type 3+ chars, dismiss keyboard (back) | Sheet returns to 0.45 anchor; text retained; page-stability holds |
| 4 | Tap Save | Sheet closes itself; back on page; highlight/note mark on the word; NO notes list; page-stability holds |
| 5 | Annotate another word → tap Cancel | Notebook closes entirely to the page (no full-screen list); placeholder highlight removed; page-stability holds |
| 6 | Annotate → drag handle down a little (< halfway) → release | Sheet snaps back to 0.45 anchor, not full screen; page-stability holds |
| 7 | Annotate → fling/drag past halfway | Notebook closes to page; page-stability holds |
| 8 | Annotate → tap the dimmed page area above the sheet | Notebook closes to page; the tap does NOT turn the page |
| 9 | Open notebook from the reader header toggler (no annotation) | Full-screen notes list (unchanged upstream behavior); close works |
| 10 | Reopen the book page | Position identical to step-0 capture |

## Delivery

One video covering steps 1-9 (`annotate-eval-<sha>.mp4`), stills for steps 2
and 5, the logcat inset lines, the step-0 vs step-10 position captures, and a
PASS/FAIL per step with observed numbers. Any workaround used = report it,
don't absorb it. Artifacts to the session scratchpad; durable copies to
`/Volumes/Media500/Services/readest-homebase/demos/`.
