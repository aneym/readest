# Fork dev loop (Android)

How to go from a code edit to a build running on the emulator or the Palma, and
the traps that cost time the first time through. Update this file whenever a
loop iteration hits a new trap or finds a faster path; the goal is that each
session through this loop is faster than the last.

## Measured timings (Mac Studio, 2026-08-31)

| Step | Time |
| --- | --- |
| Full signed release build (`tauri android build -t aarch64`, warm target/) | ~12 min |
| Next static export portion of that build | ~2 min |
| adb install to emulator or Palma (tailnet) | seconds |
| Android 35 arm64 system image download (one-time) | ~15 min |
| AVD create + first boot (one-time; hot boots after) | ~3 min |

For UI iteration do not rebuild per tweak: `pnpm dev-android` variants exist,
and Tauri dev mode (`tauri android dev`) points the on-device WebView at the
Next dev server with HMR. Cut one APK at the end.

## The build

```bash
cd apps/readest-app
export JAVA_HOME=$(/usr/libexec/java_home)
export ANDROID_HOME=/Volumes/StudioExt/android/sdk NDK_HOME=$ANDROID_HOME/ndk/28.2.13676358
pnpm exec dotenv -v KEEP_SOURCEMAPS=1 -e .env.tauri -- pnpm tauri android build -t aarch64 -- --features devtools
# output: src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk (signed)
```

- `.env.local` bakes the Homebase runtime config (`NEXT_PUBLIC_HOMEBASE_API_BASE_URL`,
  `NEXT_PUBLIC_HOMEBASE_SYNC_ENABLED`, `NEXT_PUBLIC_DISABLE_UPDATER`). Dot-notation
  `process.env.NEXT_PUBLIC_*` access is load-bearing (Next inlining).
- Signing is automatic: `src-tauri/gen/android/keystore.properties` →
  `/Volumes/Media500/Services/readest-homebase/signing/readest-homebase.jks`.
- Archive every installed build to `/Volumes/Media500/Services/readest-homebase/builds/`
  named by fork commit.

### Trap: `cc` is Claude, not a compiler

On this machine `~/.local/bin/cc` launches Claude Code and shadows `/usr/bin/cc`,
so cargo's host build scripts die with `error: unknown option '-lSystem'`.
Fix before any cargo/native build:

```bash
SHIM=$(mktemp -d); ln -s /usr/bin/cc $SHIM/cc; ln -s /usr/bin/c++ $SHIM/c++
export PATH=$SHIM:$PATH
```

## Dev flavor (side-by-side install)

Branch commits labeled `chore(dev): dev-flavor ...` change
`applicationId = "com.bilingify.readest.dev"` (`src-tauri/gen/android/app/build.gradle.kts`)
and the launcher label to "Readest DEV" (`.../res/values/strings.xml`). This
installs NEXT TO the production fork app on the same device. Both files live
under gitignored `gen/`; they are tracked anyway — `git add -f` if needed.
**Drop the dev-flavor commit before landing on `homebase/landing-v1`.**
Note: both apps register `readest://auth-callback`; Android shows a chooser
during pairing on a device that has both.

## Emulator

- AVD `readest-qa` (Pixel 8, Android 35 google_apis arm64) at
  `ANDROID_AVD_HOME=/Volumes/StudioExt/android/avd`. Boot via argent
  `boot-device {avdName: "readest-qa"}` → `emulator-5554`.
- The Homebase base URL is a tailnet MagicDNS name; the emulator cannot resolve
  it, so sync/pairing is dead there. Fine for UI work; test sync on the Palma.
- Stage books with `adb push book.epub /sdcard/Download/`; the app's VIEW
  intent path is unreliable — import through Import Books → SAF picker.

### Driving the WebView

`uiautomator describe` may show Readest as one opaque node. The build ships
`--features devtools`, so bridge CDP instead:

```bash
adb -s emulator-5554 forward tcp:9222 localabstract:webview_devtools_remote_$(adb -s emulator-5554 shell pidof com.bilingify.readest.dev | tr -d '\r')
```

then argent `list-devices` shows a chromium device whose `describe` walks the
real DOM; tap through the Android device with those normalized coordinates.

### Driving traps (measured by the QA seat, 2026-08-31)

- Plain `describe` on the Android device shows one opaque WebView node. Set up
  the CDP forward FIRST for any Readest UI work; don't burn a retry finding out.
- Long-press text selection needs Down → intermediate Move → Up. A plain
  Down/delay/Up is not recognized as a long-press by the reader.
- The selection toolbar auto-dismisses after a few seconds. Discover
  coordinates and tap back-to-back with no detour in between, or the tap lands
  on the page underneath and navigates.
- Gboard's "Try out your stylus" onboarding dialog steals keystrokes on the
  first text-field focus of a fresh session. Expect it once; dismiss and retype.
- Cancelled note drafts persist (draft-save-on-blur upstream feature): a redo
  take can open with the previous text pre-filled.
- The app ignores `am start -a VIEW` file intents; import via
  Import Books → From Local File → SAF picker.
- Soft keyboard: injected text does not raise the IME. To see real keyboard
  behavior: `adb shell settings put secure show_ime_with_hard_keyboard 1`,
  then focus the field by tap; verify with `dumpsys input_method | grep mInputShown`.
- Wedged accessibility flag kills long-press selection (2026-08-31, 3h lost):
  if the argent uiautomator instrumentation crashes (DeadObjectException in
  logcat's crash buffer), it can leave `accessibility_enabled=1` with
  `enabled_accessibility_services` null. Chromium/WebView then switches into
  accessibility mode: long-press text selection dies on EVERY app and build,
  CDP can end up watching a different live renderer than the screen (frames
  that contradict a native screenshot), and computed styles can read
  impossible values (the "all paragraphs red" ghost). Symptom check FIRST when
  input behaves impossibly: `adb shell settings get secure accessibility_enabled`
  — if 1 with no service listed, `settings put secure accessibility_enabled 0`.
  If CDP and native screenshots still disagree afterwards, stop debugging and
  rebuild the AVD (`avdmanager delete avd -n readest-qa` + create, ~3 min) —
  a corrupted WebView/emulator is not worth archaeology.
- Second variant of the instrumentation wedge: a host-side poller in the
  argent transport session can keep invoking `uiautomator dump` every 10-30s;
  each hit crash-loops on "UiAutomationService already registered" (logcat
  `Calling main entry com.android.commands.uiautomator.Launcher` repeating
  with no agent activity) and the contention stops Blink promoting touch
  gestures into text selections — long-press AND double-tap yield a collapsed
  caret while `accessibility_enabled` reads a clean 0. Fix: reboot the
  emulator (clears the stuck registration), then argent
  `stop-simulator-server {udid}` to kill the poller; verify with
  `logcat -c; sleep 60; logcat -d | grep -c uiautomator.Launcher` → 0.
- Emulator selection QA on this host is UNRELIABLE after extended
  instrumentation (declared 2026-09-01 after a full evening): Blink stops
  promoting touch gestures into text selections even on a freshly recreated
  AVD once heavy CDP/uiautomator traffic has run — long-press AND double-tap
  yield `{rangeCount:1, text:"", type:"Caret"}` while contextmenu fires on
  time and CSS hover hit-testing works. Diagnostic signature:
  `caretRangeFromPoint()` degenerate across the viewport (fixed offset for
  the first ~9px of a line, then "beyond string end"). When this appears:
  STOP. Verify selection-dependent UX on the physical Palma instead; bank
  the selection-free checks (notebook toggler, position restore) which keep
  working.
- Emulator Gboard stylus mode presents an UNDOCKED keyboard: on a stylus-capable
  AVD (Pixel 8), field focus raises a 63px stylus toolbar, and the QWERTY opened
  from "Show on-screen keyboard" registers NO ime inset — window resize,
  visualViewport, VirtualKeyboard API, and native inset listeners all stay
  silent, which looks exactly like a broken fix. Disable it before keyboard
  tests: `adb shell settings put secure stylus_handwriting_enabled 0`, then
  relaunch the app. Real e-ink devices have no stylus mode.
- CDP frames vs gesture-tap space diverge if anything resizes the WebView:
  CDP `describe` normalizes against the WebView's own (possibly shrunk)
  viewport, while argent gesture-tap expects full-physical-screen fractions.
  On a build that resizes the WebView for the keyboard, CDP-derived taps with
  the keyboard up can land on the IME instead of the target. Retired by the
  inset-bridge mechanism (WebView never resizes now), but if a resize ever
  returns: back-press the keyboard away before trusting CDP numbers, or use a
  native screenshot for physical-space estimation.
- Edge-to-edge blinds the page to the keyboard: `enableEdgeToEdge()` in
  MainActivity means the window never resizes for the IME, so `visualViewport`
  resize events never fire and any JS keyboard-inset handling silently no-ops.
  FIXED and verified (2026-08-31, emulator, docked keyboard): IME inset applied
  as a bottom MARGIN on the WebView (padding does nothing — a WebView ignores
  its own padding for content layout). Evidence: logcat "IME inset bottom=883"
  while up / 0 after dismiss, viewport 915→578→915 in lockstep. The JS
  VirtualKeyboard-API fallback in Notebook.tsx remains unverified in isolation
  (the native margin makes it unnecessary on Android). Fast checks:
  `adb logcat -s MainActivity | grep "IME inset"` shows whether the listener
  fired and with what height; CDP frames normalize against the WebView's own
  (shrunk) viewport, so an unchanged sheet frame is NOT a fail signal under
  the margin mechanism — use a native screenshot for the visual truth.

## Palma

`adb connect 100.65.146.9:5555` (USB flaky; tailnet serial preferred). After
ANY install: check `pm list packages -d` — the BOOX optimizer freezes unused
apps and the frozen state survives reinstall; `pm enable <pkg>` fixes it.
