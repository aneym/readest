# Palma offline proof harness

`scripts/homebase-offline-proof.mjs` proves the reader-sync lane acceptance on the real Palma BOOX. In airplane mode it reads and listens, kills the app, reboots and reconnects. Then it checks that the offline position and highlight reached Homebase. Node 24 or later, no dependencies.

## Run

```sh
# Pure logic only, no device. Run this after any edit.
node scripts/homebase-offline-proof.mjs --self-test

# Device run. Take the lock first (below).
node scripts/homebase-offline-proof.mjs \
  --serial 82d5c0a8 \
  --server https://studio.tailf266ac.ts.net:3148/api/readest \
  --book <fileHash> \
  [--package com.bilingify.readest] [--pin-source none|keychain] \
  [--out <dir>] [--listen readaloud|tts|skip] [--pages 12]

# Side-by-side dev flavor (take the Palma lock before running):
node scripts/homebase-offline-proof.mjs \
  --serial 82d5c0a8 \
  --package com.bilingify.readest.dev \
  --server https://studio.tailf266ac.ts.net:3163/api/readest \
  --book <fileHash>
```

- `--serial` must be the USB serial. Airplane mode turns off Wi-Fi, which drops tailnet adb (`100.65.146.9:5555`), so preflight refuses a `host:port` serial.
- `--server` is the Homebase reader base, the same value the fork uses as `homebaseApiBaseUrl`. The harness calls `<server>/reader/sync`. Preflight must prove it is the device's own sync target. It reads the base URL from three sources: `window.__READEST_RUNTIME_CONFIG`, the app's own `/reader/sync` requests in resource timing, and the literal the bundler inlined next to `homebaseApiBaseUrl`. The sources that answer must agree and must equal `--server`. If none answers, `preflight.base_url` fails. Harness fetches carry an `offline-proof-probe` marker so they never count as the app's.
- `--book` is the Readest file hash of a book already downloaded on the Palma.
- `--package` selects the installed Android app (default `com.bilingify.readest`); the dev flavor is `com.bilingify.readest.dev`. Only letters, digits, dots and underscores are allowed.
- `--pin-source none` is the default: the harness never enters a PIN. If a secure keyguard is encountered, the blocked checks are SKIP and the verdict is PARTIAL (exit 3), not PASS, so a full proof needs Alex present to unlock. Agents may not enter Alex's Palma PIN (lead guard, 2026-09-27 23:50Z): pass `--pin-source keychain` only with Alex's explicit yes for that run. It reads the PIN from the macOS keychain generic-password item `homebase.PALMA_PIN` after confirming the Palma lock owner, before any adb call. A missing item fails `preflight.pin_available`; the PIN stays in memory and is registered with the log guard before any adb call. Never repeatedly run this with a wrong PIN: the harness retries at most once per unlock and stops after at most two entries that did not unlock across the run, to avoid a device lockout timer. Successful entries do not consume that failure limit (preflight, screen-off and post-reboot may each require an unlock).
- `--listen readaloud` uses media overlays when the book has them and a Read Aloud button exists. Otherwise it falls back to native TTS (the `t` shortcut) and logs `readaloud_unavailable`. `skip` marks the three listen checks SKIP.
- `--lock-owner` (default `reader-sync`) is the lane name the lock's `owner` file must hold. A lock held by any other lane is a refusal.
- `--out` defaults to `./offline-proof-<timestamp>`. It gets `proof.jsonl` (one timestamped line per step and observation), numbered screenshots from `adb exec-out screencap -p`, and `summary.json` with each check marked PASS, FAIL or SKIP.
- Exit 0 only when every check ran and passed (verdict PASS). Any SKIP, such as `--listen skip`, makes the verdict PARTIAL with exit 3: useful evidence, but not the acceptance proof. Exit 1 on any FAIL, 2 on a usage error or a missing lock.

A full run takes about 8 to 10 minutes: 60 s of play, 120 s with the screen off, a reboot, and up to 120 s for the drain. The run budget is 13 minutes, enforced inside each step as well as between steps. A step still running when the budget ends is aborted: its adb children are killed, its waits stop and the CDP socket closes, so it cannot keep driving the Palma. Restore then runs with 15 s timeouts per adb call, which keeps the whole hold under the lock's 15 minutes. Restore and `summary.json` happen however the run ended (a step error, the budget cut, or restore itself failing); a cut run fails `run.within_budget`.

## What it needs from the device

- WebView debugging enabled in the installed build. Preflight looks for the `webview_devtools_remote_<pid>` socket and fails with that message if the socket is missing.
- A paired fork: `localStorage.token` and `readest-homebase-client-id` present. The harness holds the token in memory only, for the server readback. Every jsonl line, `summary.json` and console line passes a guard that refuses any text containing the token or PIN, in raw, URL-encoded or JSON-escaped form. A refusal fails `safety.no_token_leak`. Any logged adb argv must replace the PIN argument with `<pin>`.
- With a secure keyguard, the harness wakes, swipes, enters the PIN as an adb `execFile` argument (never a shell string), presses Enter, and waits up to 20 seconds for unlock. It never types the PIN if the keyguard is not showing. After reboot it waits for `sys.boot_completed=1`, unlocks, then waits for credential-encrypted user storage to unlock before launching the app. Each unlock observation records the keyguard field and the credential-storage observation records its signal.
- The pending count comes from `window.__homebaseSyncStatus.getState().pending` if the fork exposes it. Today it does not, so the harness reads the durable outbox the way the app does: `Readest/homebase/outbox.json` under AppData through a raw `plugin:fs|read_text_file` invoke, merged with any legacy `readest-homebase-outbox` localStorage rows. A file that exists but cannot be read or parsed gives pending `null`, which fails, never 0. `summary.json` names the source.
- Raw fs invokes return bytes on the installed plugin-fs 2.5.1 and a string on older builds. `decodeFsText` accepts both, and `--self-test` runs the page snippets against a fake Tauri bridge in each shape.
- Position and highlights persisted locally are read from `Readest/Books/<hash>/config.json`. The live reader CFI comes from `foliate-view.lastLocation.cfi`.
- The highlight is made by selecting four words inside the book iframe and clicking the popup's `Highlight` button. If the popup does not appear within 6 s, the harness prints a manual step and waits up to 5 minutes for Enter on stdin.

## Checks

- Preflight: adb state, USB serial, app installed, PIN available, CDP, paired, base URL, device route. Each unlock attempt adds `unlock.ok` (FAIL if still locked after 20 seconds, SKIP when PIN entry is disabled).
- Baseline readback. Airplane on with no route.
- Read: pages turned. Annotate: highlight created.
- Listen: started; the screen actually went off; the CFI advanced between the moment before the power key and the moment after wake. Progress made before the screen went off does not count.
- Offline: the persisted CFI equals the live reader CFI and is not behind the last observed position (after wake, or end of reading with `--listen skip`).
- After kill and after reboot: CFI persisted, highlight persisted, pending >= 1, and `queue_intact`: every outbox key captured just before the kill is still queued (a row lost in either step fails here, even if the rest drains). After reboot also boot completed, credential storage unlocked (`reboot.user_unlocked`), and airplane still on. The drain's queued list is the union of every offline snapshot, so a lost row also fails the server readback.
- Drain: pending reaches 0 within 120 s, and every row queued before the drain has left the outbox.
- Server readback: location equals the offline CFI; highlight present with a receipt newer than the baseline; every queued row delivered. Right before turning airplane mode off, the harness reads the server rows for every queued book from the host (the device is still offline, so nothing it queued can have arrived). A queued configs, notes or books row counts only when the server row for that identity exists after the drain and its `synced_at` receipt is newer than in that pre-drain read, or the identity did not exist before. An old row that did not change is not proof. A queued note deletion must arrive as a tombstone. If the pre-drain read failed, the check fails. statBooks and statPages have no readback (the server's GET `type=stats` returns empty), so they count only when the post-drain outbox no longer holds them, which the outbox allows only after a 2xx ack of that revision. A queued row of any other channel fails the check.
- Run: every step finished inside the budget and none stopped the run early.
- Restore (airplane off, screen on) and the token guard.

## Palma lock protocol

The Palma is shared across lanes. Hold it at most 15 minutes.

```sh
L=/Volumes/StudioExt/repos/homebase-worktrees/_program/palma.lock
until mkdir "$L" 2>/dev/null; do sleep 30; done   # retry every 30 s while another lane holds it
echo reader-sync > "$L/owner"
node scripts/homebase-offline-proof.mjs --serial 82d5c0a8 --server <base> --book <hash>
rm -rf "$L"
```

The harness refuses a device run unless `$L/owner` exists and holds the `--lock-owner` name (default `reader-sync`). It checks this before any adb call. `--skip-lock-check` bypasses it, only for a device that is not the shared Palma.

## Rollback

The harness changes no code on the device and never clears app data (`pm clear` is never called). It leaves behind:

- One new highlight in the test book, synced to Homebase. Delete it in Readest's notebook if unwanted; the deletion syncs as a tombstone.
- The book's reading position moved forward by the run.

If a run dies before its restore step (for example, the host process was killed):

```sh
adb -s 82d5c0a8 shell cmd connectivity airplane-mode disable
adb -s 82d5c0a8 shell input keyevent 224          # wake
adb -s 82d5c0a8 forward --remove-all
adb -s 82d5c0a8 tcpip 5555 && adb connect 100.65.146.9:5555   # tailnet adb, after a reboot
rm -rf /Volumes/StudioExt/repos/homebase-worktrees/_program/palma.lock
```

To remove the harness itself, delete `scripts/homebase-offline-proof.mjs` and this file.
