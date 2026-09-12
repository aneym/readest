#!/bin/zsh -f
# Household Android build for the Readest fork.
#
#   scripts/household-build.sh [ref]        # default: HEAD of this checkout
#
# Builds the signed aarch64 release APK from a CLEAN worktree of <ref> at
# $BUILD_ROOT, so in-progress edits by another agent in the main worktree can
# never leak into a shipped APK. Stamps NEXT_PUBLIC_HOMEBASE_BUILD_ID as
# "<version>+<sha>" (the diagnostics endpoint reports it), shares the warm
# cargo target dir, prints per-phase timings, and archives the APK as
# $ARCHIVE/readest-homebase-final-<sha>.apk. Install with:
#
#   adb -s 100.65.146.9:5555 install -r <apk> && adb -s 100.65.146.9:5555 shell pm enable com.bilingify.readest
#
# Measured 2026-09-12 (Mac Studio, warm caches): ~5 min end to end.
set -euo pipefail

REF="${1:-HEAD}"
ROOT="$(git rev-parse --show-toplevel)"
FULL="$(git -C "$ROOT" rev-parse "$REF")"
SHA="$(git -C "$ROOT" rev-parse --short "$FULL")"
VERSION="$(node -p "require('$ROOT/apps/readest-app/package.json').version")"
BUILD_ID="$VERSION+$SHA"
BUILD_ROOT="${HOMEBASE_BUILD_ROOT:-/Volumes/StudioExt/repos/personal/readest-homebase-build}"
ARCHIVE="${HOMEBASE_BUILD_ARCHIVE:-/Volumes/Media500/Services/readest-homebase/builds}"
APP="apps/readest-app"

T0=$(date +%s)
phase() { printf '[%s +%4ds] %s\n' "$(date +%H:%M:%S)" "$(( $(date +%s) - T0 ))" "$*"; }

phase "build $BUILD_ID from $FULL"

# --- clean worktree -----------------------------------------------------------
if [[ ! -d "$BUILD_ROOT/.git" && ! -f "$BUILD_ROOT/.git" ]]; then
  git -C "$ROOT" worktree add --detach "$BUILD_ROOT" "$FULL"
else
  git -C "$BUILD_ROOT" checkout --detach -q "$FULL"
  git -C "$BUILD_ROOT" reset -q --hard "$FULL"
fi
# Submodules (foliate-js, tauri forks, turso/webview-upgrade plugins) resolve
# from the shared .git/modules store, so this needs no network once the main
# worktree has them.
git -C "$BUILD_ROOT" submodule update --init --recursive --quiet
if [[ -n "$(git -C "$BUILD_ROOT" status --porcelain --untracked-files=no)" ]]; then
  echo "build worktree is dirty after checkout; refusing" >&2; exit 1
fi
phase "worktree at $BUILD_ROOT"

# Untracked build inputs the worktree cannot carry: the Tauri-generated Android
# project (gitignored gen/, minus outputs), the signing pointer and the baked
# runtime config.
rsync -a --delete \
  --exclude 'app/build' --exclude '.gradle' --exclude 'build/' --exclude '.kotlin' \
  "$ROOT/$APP/src-tauri/gen/android/" "$BUILD_ROOT/$APP/src-tauri/gen/android/"
# The tracked gen files (build.gradle.kts, strings.xml, ic_launcher.xml) must
# come from the ref, not from whatever the main worktree currently has.
git -C "$BUILD_ROOT" checkout -q -- "$APP/src-tauri/gen/android"
cp "$ROOT/$APP/.env.local" "$BUILD_ROOT/$APP/.env.local"
cp "$ROOT/$APP/.env.tauri" "$BUILD_ROOT/$APP/.env.tauri"
phase "generated android project + env synced"

# --- toolchain -----------------------------------------------------------------
# ~/.local/bin/cc is Claude Code on this host; cargo build scripts need the real compiler.
SHIM="$(mktemp -d)"; ln -s /usr/bin/cc "$SHIM/cc"; ln -s /usr/bin/c++ "$SHIM/c++"
export PATH="$SHIM:$HOME/.nvm/versions/node/v24.13.1/bin:$PATH"   # Node 24: vitest/jsdom break on 26
export JAVA_HOME="$(/usr/libexec/java_home)"
export ANDROID_HOME=/Volumes/StudioExt/android/sdk
export NDK_HOME="$ANDROID_HOME/ndk/28.2.13676358"
export CARGO_TARGET_DIR="$ROOT/target"            # share the warm 10 GB target
export CARGO_PROFILE_RELEASE_INCREMENTAL=true      # app crate rebuilds incrementally
export NEXT_PUBLIC_HOMEBASE_BUILD_ID="$BUILD_ID"
export HOMEBASE_BUILD_CPUS="${HOMEBASE_BUILD_CPUS:-8}"   # static export workers; 15 swaps the host
export NEXT_TELEMETRY_DISABLED=1

cd "$BUILD_ROOT"
pnpm install --frozen-lockfile --prefer-offline --silent
phase "deps installed"

cd "$BUILD_ROOT/$APP"
pnpm exec dotenv -v KEEP_SOURCEMAPS=1 -e .env.tauri -- pnpm tauri android build -t aarch64 -- --features devtools
phase "tauri android build done"

APK="$BUILD_ROOT/$APP/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk"
mkdir -p "$ARCHIVE"
OUT="$ARCHIVE/readest-homebase-final-$SHA.apk"
cp "$APK" "$OUT"
phase "archived $OUT ($(du -h "$OUT" | cut -f1), md5 $(md5 -q "$OUT"))"
echo "$OUT"
