#!/usr/bin/env bash
# Emulator-only Readest frontend HMR. Keep this process running while editing.
# Usage: scripts/palma-live-dev.sh [emulator-5580]
# A prepared checkout needs pnpm install, public/vendor, and tauri android init.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERIAL="${1:-emulator-5580}"
case "$SERIAL" in emulator-*) ;; *) echo "Only Android emulator serials are accepted" >&2; exit 2 ;; esac
export ANDROID_HOME="${ANDROID_HOME:-/Volumes/StudioExt/android/sdk}"
export NDK_HOME="${NDK_HOME:-$ANDROID_HOME/ndk/28.2.13676358}"
export JAVA_HOME="${JAVA_HOME:-/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home}"
export NEXT_TELEMETRY_DISABLED=1
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-6}"
ADB="$ANDROID_HOME/platform-tools/adb"
"$ADB" -s "$SERIAL" get-state >/dev/null
AVD="$("$ADB" -s "$SERIAL" emu avd name | tr -d '\r' | head -1)"
if lsof -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port 3000 is occupied; stop this checkout's previous dev process first" >&2
  exit 2
fi
STATE="$ROOT/target/palma-live-dev"
mkdir -p "$STATE/toolchain"
# ~/.local/bin/cc is a chat CLI, not the C linker.
ln -sf /usr/bin/cc "$STATE/toolchain/cc"
ln -sf /usr/bin/c++ "$STATE/toolchain/c++"
export PATH="$STATE/toolchain:$HOME/.nvm/versions/node/v24.13.1/bin:$PATH"
if [[ ! -x "$ROOT/apps/readest-app/src-tauri/gen/android/gradlew" ]]; then
  echo "Run pnpm tauri android init in a prepared worktree first" >&2
  exit 2
fi
if [[ ! -f "$ROOT/apps/readest-app/public/vendor/pdfjs/pdf.min.mjs" || ! -f "$ROOT/apps/readest-app/public/vendor/simplecc/simplecc_wasm.js" ]]; then
  echo "Generate public/vendor with the app's setup-pdfjs/setup-simplecc/setup-jieba scripts first" >&2
  exit 2
fi
"$ADB" -s "$SERIAL" reverse tcp:3000 tcp:3000
# The supported config field makes the CLI generate AND launch the .dev id.
# Keep the namespace unchanged: JNI/Kotlin bindings use com.bilingify.readest.
CONFIG='{"build":{"devUrl":"http://127.0.0.1:3000","beforeDevCommand":"pnpm dev --hostname 127.0.0.1"},"bundle":{"android":{"debugApplicationIdSuffix":".dev"}}}'
printf 'Dev session started at %s; frontend edits need no APK rebuild.\n' "$(date -u +%FT%TZ)"
cd "$ROOT/apps/readest-app"
exec pnpm exec tauri android dev --no-watch --host 127.0.0.1 "$AVD" --config "$CONFIG"
