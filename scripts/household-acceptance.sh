#!/usr/bin/env bash
# Household Readest acceptance run on a real BOOX (the Palma).
#
#   scripts/household-acceptance.sh --serial <adb-serial> [--out DIR]
#       [--homebase-host HOST] [--homebase-ip IP]... [--only 1,2,5]
#       [--lock-wait MINUTES]
#
# Prints PASS / FAIL / SKIP per item and exits non-zero on any FAIL:
#   1 cold start makes no upstream-cloud requests: every socket the app's uid
#     opens (native tauriFetch and WebView alike, sampled from /proc/net on the
#     device) goes to the Homebase host, plus CDP Network and logcat; the
#     window includes a Discover visit so the native discover client runs
#   2 no sign-in UI on /library or in the library menu
#   3 night mode: true-black page and white text measured inside the reader's
#     own text-line rectangles, again after 10 page turns
#   4 TTS settings tab and the household audio row are in the DOM
#   5 palma-readest://open deep link opens a local book at its saved place,
#     and a second start does not move it
#   6 the launcher sync-status ContentProvider returns a row
#   7 offline: quiet library, Discover offline panel with cached shelves, one
#     request made by tapping "Get ebook" in a cached work's sheet waits in
#     the queue, then flushes when the network comes back
#
# Item 7 sends one real request to Homebase when the network returns. It
# only ever picks an unowned work first published in 1928 or earlier (public
# domain), cancels the resulting job, and FAILs rather than request anything
# newer. Tell the books-discovery lane before a run that includes item 7.
#
# Needs: adb, curl, Node 22+ (global WebSocket; override with NODE=), and
# python3 with Pillow. The build must be a household build with WebView
# debugging on (scripts/household-build.sh passes --features devtools).
#
# Device safety: never clears app data. It always takes the shared Palma lock
# itself with mkdir (an existing lock, even one naming this lane, means wait;
# default wait 15 min), holds it at most 15 min (items that would overrun it
# are not started, and a watchdog stops the run at the limit), and removes it
# on exit. It restores themeMode, turns the 10 test pages back, and always
# turns airplane mode off again. Item 7 over a tailnet serial runs from a
# detached on-device script because airplane mode drops TCP adb.
set -uo pipefail

PKG=com.bilingify.readest
PROVIDER_URI=content://com.bilingify.readest.household/sync-status
LOCK_DIR=/Volumes/StudioExt/repos/homebase-worktrees/_program/palma.lock
LANE=readest-fork
PORT=9333
FORBIDDEN_RE='readest\.com|posthog|supabase|googleapis|jsdelivr|cdnjs|onlinewebfonts'
LOCAL_HOSTS_RE='^(tauri\.localhost|asset\.localhost|ipc\.localhost|rangefile\.localhost|localhost|127\.0\.0\.1)$'

SERIAL=""
OUT=""
HOMEBASE_HOST="studio.tailf266ac.ts.net"
HOMEBASE_IPS_EXTRA=""
ONLY=""
LOCK_WAIT_MIN=15
HOLD_LIMIT=$((15 * 60))

while [[ $# -gt 0 ]]; do
  case "$1" in
    --serial) SERIAL="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --homebase-host) HOMEBASE_HOST="$2"; shift 2 ;;
    --only) ONLY=",$2,"; shift 2 ;;
    --lock-wait) LOCK_WAIT_MIN="$2"; shift 2 ;;
    --homebase-ip) HOMEBASE_IPS_EXTRA="$HOMEBASE_IPS_EXTRA $2"; shift 2 ;;
    -h|--help) sed -n '2,39p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$SERIAL" ]] || { echo "usage: $0 --serial <adb-serial>" >&2; exit 2; }
[[ "$LOCK_WAIT_MIN" =~ ^[0-9]+$ ]] || { echo "--lock-wait takes whole minutes" >&2; exit 2; }

NODE="${NODE:-}"
if [[ -z "$NODE" ]]; then
  for c in "$HOME/.nvm/versions/node/v24.13.1/bin/node" "$(command -v node || true)"; do
    [[ -n "$c" && -x "$c" ]] && { NODE="$c"; break; }
  done
fi
[[ -n "$NODE" ]] || { echo "node not found (set NODE=)" >&2; exit 2; }
python3 -c 'import PIL' 2>/dev/null || { echo "python3 with Pillow is required" >&2; exit 2; }

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${OUT:-${TMPDIR:-/tmp}/household-acceptance-$STAMP}"
mkdir -p "$OUT"
WORK="$(mktemp -d)"
IS_TCP=0; [[ "$SERIAL" == *:* ]] && IS_TCP=1

adbs() { adb -s "$SERIAL" "$@"; }
sh_dev() { adb -s "$SERIAL" shell "$@" | tr -d '\r'; }
log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
want() { [[ -z "$ONLY" || "$ONLY" == *",$1,"* ]]; }

declare -a RESULT
declare -a DETAIL
record() { # item status detail
  RESULT[$1]="$2"; DETAIL[$1]="$3"
  printf '%-4s item %s: %s\n' "$2" "$1" "$3"
}

# --- helpers written at runtime ----------------------------------------------

cat > "$WORK/cdp.mjs" <<'NODE'
// node cdp.mjs <port> eval   (body on stdin, runs as an async function; ARGS from env CDP_ARGS)
// node cdp.mjs <port> net <seconds> <reload-seconds>   (request URLs seen by the page)
const [port, cmd, arg, arg2] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readStdin = async () => { let s = ''; for await (const c of process.stdin) s += c; return s; };
// Hard stop: a stalled devtools socket must never hang the run (the hold
// watchdog can only act between foreground commands).
const budget = cmd === 'net' ? (Number(arg) + Number(arg2 || 20) + 45) * 1000 : 60000;
setTimeout(() => { console.error(`cdp ${cmd} gave up after ${budget / 1000}s`); process.exit(4); }, budget);
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(8000) })).json();
const page =
  list.find((t) => t.type === 'page' && /^https?:\/\/tauri\.localhost|^tauri:/.test(t.url)) ||
  list.find((t) => t.type === 'page' && !t.url.startsWith('devtools:'));
if (!page) { console.error('no page target'); process.exit(3); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = () => rej(new Error('websocket error'));
  setTimeout(() => rej(new Error('websocket timeout')), 10000);
});
let seq = 0;
const pending = new Map();
const listeners = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  else if (msg.method) listeners.forEach((l) => l(msg));
};
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = ++seq;
  pending.set(id, (msg) => (msg.error ? rej(new Error(`${method}: ${msg.error.message}`)) : res(msg.result)));
  ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(`${method} timeout`)); } }, 45000);
});
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  }
  return r.result.value;
};
try {
  if (cmd === 'eval') {
    const body = await readStdin();
    const args = process.env.CDP_ARGS || '{}';
    const expr = `(async () => { const ARGS = ${args}; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));\n${body}\n})()`;
    console.log(JSON.stringify(await evaluate(expr) ?? null));
  } else if (cmd === 'net') {
    // The devtools socket only exists once the app process runs. Phase 1 keeps
    // the Network domain on from attach to the end of the window, then reads
    // Resource Timing, which holds every fetch since navigation start (so the
    // requests before attach too). Phase 2 reloads with the Network domain (page
    // and workers) on before the first request, for what Resource Timing never
    // lists (WebSockets, worker requests).
    const timing =
      `({ entries: performance.getEntriesByType('navigation').concat(performance.getEntriesByType('resource')).map((e) => e.name),` +
      ` resources: performance.getEntriesByType('resource').length, href: location.href })`;
    const captured = new Set();
    let documentSeen = false;
    let workers = 0;
    let phase = 1;
    let firstBootNetwork = 0;
    let reloadNetwork = 0;
    listeners.push((m) => {
      if (m.method === 'Network.requestWillBeSent') {
        captured.add(m.params.request.url);
        if (phase === 1) firstBootNetwork++; else reloadNetwork++;
        if (phase === 2 && m.params.type === 'Document' && !m.sessionId) documentSeen = true;
      }
      if (m.method === 'Network.webSocketCreated') captured.add(m.params.url);
      if (m.method === 'Target.attachedToTarget') {
        workers++;
        const sid = m.params.sessionId;
        send('Network.enable', {}, sid)
          .catch(() => {})
          .finally(() => send('Runtime.runIfWaitingForDebugger', {}, sid).catch(() => {}));
      }
    });
    await send('Network.enable');
    await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }).catch(() => {});
    await sleep(Number(arg) * 1000);
    const firstBoot = await evaluate(timing);
    phase = 2;
    await send('Network.setCacheDisabled', { cacheDisabled: true });
    await send('Page.enable');
    await send('Page.reload', { ignoreCache: true });
    await sleep(Number(arg2 || 20) * 1000);
    const reloaded = await evaluate(timing);
    await send('Network.setCacheDisabled', { cacheDisabled: false }).catch(() => {});
    // Only network schemes; data: and blob: URLs can be megabytes long.
    const network = (u) => /^(https?|wss?):/i.test(u);
    console.log(JSON.stringify({
      urls: [...new Set([...firstBoot.entries, firstBoot.href, ...captured, ...reloaded.entries])]
        .filter(network)
        .map((u) => u.slice(0, 400)),
      firstBoot: firstBoot.entries.length,
      firstBootNetwork,
      reloadNetwork,
      captured: captured.size,
      documentSeen,
      workers,
      // Chromium keeps 250 resource entries by default; a full buffer means the
      // first-boot list may be missing requests.
      bufferFull: firstBoot.resources >= 250 || reloaded.resources >= 250,
    }));
  } else {
    throw new Error(`unknown command ${cmd}`);
  }
  ws.close();
  process.exit(0);
} catch (e) {
  console.error(String(e?.message || e));
  process.exit(1);
}
NODE

cat > "$WORK/px.py" <<'PY'
# python3 px.py stats <png>             -> whole-page colours (context only)
# python3 px.py text <png> <geom.json>  -> page background and text colour,
#     measured only inside the reader's own text-line rectangles
# python3 px.py diff <a> <b>            -> share of pixels that differ
import json, sys
from collections import Counter
from PIL import Image

def body(path):
    im = Image.open(path).convert('RGB')
    w, h = im.size
    # Skip the Onyx status bar and the bottom edge; they are not the page.
    return im.crop((0, int(h * 0.06), w, int(h * 0.97)))

if sys.argv[1] == 'text':
    # geom: {rects: [[l,t,w,h] CSS px], page: [l,t,w,h], box: {x0,y0,scale}}.
    # The rectangles come from Range.getClientRects() over the book's text
    # nodes, so a UI control that is not book text is never inside them.
    im = Image.open(sys.argv[2]).convert('RGB')
    g = json.load(open(sys.argv[3]))
    box = g['box']
    W, H = im.size
    def dev(r, inset=0):
        l = int(round(box['x0'] + r[0] * box['scale'])) + inset
        t = int(round(box['y0'] + r[1] * box['scale'])) + inset
        rr = int(round(box['x0'] + (r[0] + r[2]) * box['scale'])) - inset
        b = int(round(box['y0'] + (r[1] + r[3]) * box['scale'])) - inset
        return max(0, l), max(0, t), min(W, rr), min(H, b)
    pl, pt, pr, pb = dev(g['page'])
    page = Counter(im.crop((pl, pt, pr, pb)).getdata()) if pr > pl and pb > pt else Counter()
    bg, bgn = page.most_common(1)[0] if page else ((-1, -1, -1), 0)
    nonbg = Counter()
    rects_white = 0
    rects_used = 0
    for r in g['rects']:
        l, t, rr, b = dev(r, 1)
        if rr - l < 4 or b - t < 4:
            continue
        rects_used += 1
        c = Counter(im.crop((l, t, rr, b)).getdata())
        if c.get((255, 255, 255), 0) >= 3:
            rects_white += 1
        for p, n in c.items():
            if p != (0, 0, 0):
                nonbg[p] += n
    total = sum(nonbg.values())
    chroma = sum(n for p, n in nonbg.items() if max(p) - min(p) > 16)
    top = nonbg.most_common(1)[0][0] if nonbg else None
    white = nonbg.get((255, 255, 255), 0)
    ok_text = (
        rects_used >= 6
        and top == (255, 255, 255)
        and white >= 100
        and rects_white * 2 >= rects_used   # white in most lines, not one spot
        and chroma * 100 <= max(total, 1)   # no coloured ink in the lines
    )
    print(json.dumps({
        'background': list(bg),
        'backgroundShare': round(bgn / max(sum(page.values()), 1), 3),
        'text': list(top) if top else None,
        'textOk': bool(ok_text),
        'rects': rects_used,
        'rectsWithWhite': rects_white,
        'white255': white,
        'inkPixels': total,
        'chromaShare': round(chroma / max(total, 1), 4),
    }))
elif sys.argv[1] == 'stats':
    px = list(body(sys.argv[2]).getdata())
    counts = Counter(px)
    mode, n = counts.most_common(1)[0]
    bright = Counter(p for p in px if min(p) >= 250)
    top_bright = bright.most_common(1)
    print(json.dumps({
        'background': list(mode),
        'backgroundShare': round(n / len(px), 3),
        'brightPixels': sum(bright.values()),
        'text': list(top_bright[0][0]) if top_bright else None,
        'white255': counts.get((255, 255, 255), 0),
    }))
else:
    a = list(body(sys.argv[2]).getdata())
    b = list(body(sys.argv[3]).getdata())
    diff = sum(1 for x, y in zip(a, b) if x != y)
    print(json.dumps({'changed': round(diff / max(len(a), 1), 4)}))
PY

cat > "$WORK/uix.py" <<'PY'
# python3 uix.py <uiautomator.xml> <queued title> <cached shelf titles JSON>
# Reads the offline Discover screen dump: the offline panel, the queued title
# inside "Waiting to send", and which cached shelf headings are on screen.
import json, sys
import xml.etree.ElementTree as ET
try:
    root = ET.parse(sys.argv[1]).getroot()
except Exception as e:
    print(json.dumps({'error': 'no readable screen dump: %s' % e})); sys.exit(0)
title, shelves = sys.argv[2], json.loads(sys.argv[3])
texts = []
for n in root.iter('node'):
    for k in ('text', 'content-desc'):
        v = (n.get(k) or '').strip()
        if v: texts.append(v)
offline = any(t.startswith('You are offline') for t in texts)
idx = next((i for i, t in enumerate(texts) if t == 'Waiting to send'), -1)
# Pre-order walk: the list items follow the heading (and its note) closely.
waiting = idx >= 0 and any(title and title in t for t in texts[idx + 1: idx + 12])
shown = [s for s in shelves if any(t == s or t.startswith(s) for t in texts)]
print(json.dumps({'offlinePanel': offline, 'waitingListsIt': waiting, 'cachedShown': shown, 'nodes': len(texts)}))
PY

cat > "$WORK/sock.py" <<'PY'
# python3 sock.py <samples.txt> <allowed-ips JSON> <labels JSON> <native-from> <native-to>
# Reads the on-device /proc/net samples (only lines owned by the app's uid)
# and lists every remote endpoint the app connected to.
import ipaddress, json, sys
path, allowed, labels = sys.argv[1], set(json.loads(sys.argv[2])), json.loads(sys.argv[3])
nat_from, nat_to = int(sys.argv[4]), int(sys.argv[5])

def addr(h):
    ip, port = h.split(':')
    port = int(port, 16)
    b = bytes.fromhex(ip)
    if len(b) == 4:
        return str(ipaddress.IPv4Address(b[::-1])), port
    words = b''.join(b[i:i + 4][::-1] for i in range(0, 16, 4))
    a = ipaddress.IPv6Address(words)
    return str(a.ipv4_mapped or a), port

samples, now, seen = 0, 0, {}
for line in open(path, errors='replace'):
    f = line.split()
    if not f:
        continue
    if f[0] == 'T':
        samples += 1; now = int(f[1]); continue
    if len(f) < 5 or ':' not in f[2]:
        continue
    proto = 'udp' if 'udp' in f[0] else 'tcp'
    try:
        lip, lport = addr(f[2]); rip, rport = addr(f[3])
    except Exception:
        continue
    if rport == 0 or ipaddress.ip_address(rip).is_unspecified:
        continue  # listening or unconnected
    key = (proto, rip, rport, lport)
    if key not in seen:
        seen[key] = {'proto': proto, 'remote': rip, 'port': rport, 'localPort': lport,
                     'state': f[4], 'first': now}

bad, dns, homebase, native_new = [], [], 0, 0
for s in seen.values():
    ip = ipaddress.ip_address(s['remote'])
    if ip.is_loopback:
        continue
    if s['remote'] in allowed:
        homebase += 1
        if nat_from <= s['first'] <= nat_to:
            native_new += 1
        continue
    if s['port'] == 53:
        dns.append(s); continue
    s['label'] = labels.get(s['remote'], 'unknown host')
    bad.append(s)
print(json.dumps({'samples': samples, 'last': now, 'endpoints': len(seen), 'homebase': homebase,
                  'homebaseDuringDiscover': native_new, 'bad': bad, 'dns': dns}))
PY

# On-device helpers. ha-sock.sh samples the app uid's sockets until told to
# stop; ha-ui.sh finds on-screen nodes by their exact accessible label through
# uiautomator and taps them as a finger would (real input, no coordinates
# guessed from the DOM).
cat > "$WORK/ha-sock.sh" <<'SH'
#!/system/bin/sh
# ha-sock.sh <uid> <max-seconds> <out-file>
U=$1; END=$(( $(date +%s) + $2 )); OUTF=$3; STOP=/data/local/tmp/ha-sock.stop
rm -f "$STOP" "$OUTF"
while [ "$(date +%s)" -lt "$END" ] && [ ! -f "$STOP" ]; do
  echo "T $(date +%s)" >> "$OUTF"
  awk -v u="$U" '$8 == u { print FILENAME, $0 }' /proc/net/tcp /proc/net/tcp6 /proc/net/udp /proc/net/udp6 >> "$OUTF"
  sleep 0.2
done
echo "T $(date +%s)" >> "$OUTF"
SH

cat > "$WORK/ha-ui.sh" <<'SH'
#!/system/bin/sh
# ha-ui.sh tap <label> [scroll]  tap the centre of the first on-screen node whose
#                                text or content-desc is exactly <label>; with
#                                "scroll", swipe the page up between tries
# ha-ui.sh has <text>            exit 0 when some node's label contains <text>
# ha-ui.sh wvbox                 print the WebView's screen bounds: x1 y1 x2 y2
# ha-ui.sh dump <file>           save the screen dump
D=/data/local/tmp/ha-ui; mkdir -p $D
SIZE=$(wm size | tail -1 | sed -E 's/.*: *([0-9]+)x([0-9]+).*/\1 \2/')
SW=${SIZE% *}; SH=${SIZE#* }
dump() {
  for _ in 1 2; do
    rm -f $D/cur.xml
    uiautomator dump $D/cur.xml >/dev/null 2>&1
    [ -s $D/cur.xml ] && return 0
    sleep 1
  done
  return 1
}
on_screen() { # reads "x1 y1 x2 y2" lines, prints the smallest fully on-screen
  # one (a sheet's full-screen backdrop shares the "Close" label with its X)
  best=""; area=0
  while read -r x1 y1 x2 y2; do
    if [ "$x2" -gt "$x1" ] && [ "$y2" -gt "$y1" ] && [ "$x1" -ge 0 ] && [ "$y1" -ge 0 ] \
       && [ "$x2" -le "$SW" ] && [ "$y2" -le "$SH" ]; then
      a=$(( (x2 - x1) * (y2 - y1) ))
      if [ -z "$best" ] || [ "$a" -lt "$area" ]; then best="$x1 $y1 $x2 $y2"; area=$a; fi
    fi
  done
  [ -n "$best" ] && echo "$best"
}
nodes() { tr '>' '\n' < $D/cur.xml | grep '<node '; }
bounds() { sed -nE 's/.*bounds="\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]".*/\1 \2 \3 \4/p'; }
case "$1" in
  tap)
    for _ in 1 2 3 4; do
      if dump; then
        b=$(nodes | grep -F -e "text=\"$2\"" -e "content-desc=\"$2\"" | bounds | on_screen)
        if [ -n "$b" ]; then
          set -- $b
          x=$(( ($1 + $3) / 2 )); y=$(( ($2 + $4) / 2 ))
          input tap "$x" "$y"; echo "tapped $x,$y"; exit 0
        fi
      fi
      [ "$3" = scroll ] && input swipe $((SW / 2)) $((SH * 3 / 4)) $((SW / 2)) $((SH / 3)) 500
      sleep 2
    done
    echo "not on screen"; exit 1 ;;
  has) dump && grep -qF -- "$2" $D/cur.xml ;;
  wvbox) dump && nodes | grep -F 'class="android.webkit.WebView"' | bounds | head -1 ;;
  dump) dump && cp $D/cur.xml "$2" ;;
  *) echo "unknown: $1"; exit 2 ;;
esac
SH

cdp_eval() { # cdp_eval '<json args>'  (JS body on stdin)
  local args="${1:-}"
  [[ -n "$args" ]] || args='{}'
  CDP_ARGS="$args" "$NODE" "$WORK/cdp.mjs" "$PORT" eval
}
jget() { # jget '<json>' '<js expression on v>'
  "$NODE" -e 'const v = JSON.parse(process.argv[1]); const r = eval(process.argv[2]); console.log(typeof r === "string" ? r : JSON.stringify(r));' "$1" "$2"
}

# --- device lock, cleanup ------------------------------------------------------

LOCK_TAKEN=0
LOCK_T0=0
WATCHDOG_PID=""
SOCK_PID=""
THEME_ORIGINAL=""
THEME_CHANGED=0
AIRPLANE_ON=0

cleanup() {
  if [[ $AIRPLANE_ON == 1 ]]; then
    sh_dev cmd connectivity airplane-mode disable >/dev/null 2>&1 || true
  fi
  if [[ $THEME_CHANGED == 1 && -n "$THEME_ORIGINAL" ]]; then
    cdp_eval "{\"mode\":\"$THEME_ORIGINAL\"}" >/dev/null 2>&1 <<'JS' || true
localStorage.setItem('themeMode', ARGS.mode); location.reload(); return true;
JS
  fi
  if [[ -n "$SOCK_PID" ]]; then
    adb -s "$SERIAL" shell touch /data/local/tmp/ha-sock.stop >/dev/null 2>&1
    kill "$SOCK_PID" 2>/dev/null
  fi
  if [[ $LOCK_TAKEN == 1 ]]; then
    adb -s "$SERIAL" shell rm -rf /data/local/tmp/ha-ui.sh /data/local/tmp/ha-ui \
      /data/local/tmp/ha-sock.sh /data/local/tmp/ha-sock.txt /data/local/tmp/ha-sock.stop >/dev/null 2>&1
  fi
  adb -s "$SERIAL" forward --remove "tcp:$PORT" >/dev/null 2>&1 || true
  if [[ -n "$WATCHDOG_PID" ]]; then
    pkill -P "$WATCHDOG_PID" 2>/dev/null; kill "$WATCHDOG_PID" 2>/dev/null
  fi
  if [[ $LOCK_TAKEN == 1 ]]; then
    rm -rf "$LOCK_DIR"
    log "palma lock released after $((SECONDS - LOCK_T0))s"
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# Fail fast, without holding the lock, when the device is not attached.
adbs get-state >/dev/null 2>&1 || { echo "adb device $SERIAL not found" >&2; exit 5; }

# The lock is exclusive: mkdir must succeed for this run. An existing lock is
# never reused, whoever it names, including this lane (another run of it).
tries=$(( LOCK_WAIT_MIN * 2 + 1 ))
for ((i = 1; i <= tries; i++)); do
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    LOCK_TAKEN=1; LOCK_T0=$SECONDS
    echo "$LANE" > "$LOCK_DIR/owner"
    date -u +%Y-%m-%dT%H:%M:%SZ > "$LOCK_DIR/acquiredAt"
    break
  fi
  (( i == tries )) && break
  log "palma lock held by $(cat "$LOCK_DIR/owner" 2>/dev/null || echo unknown) since $(cat "$LOCK_DIR/acquiredAt" 2>/dev/null || echo '?'); retry in 30s"
  sleep 30
done
[[ $LOCK_TAKEN == 1 ]] || { echo "could not take $LOCK_DIR within $LOCK_WAIT_MIN min" >&2; exit 4; }
log "palma lock taken (hold limit $((HOLD_LIMIT / 60)) min)"
# Hard stop: TERM runs the cleanup (network back on, theme restored, lock
# removed) even if an item is still going. Bash handles it once the current
# foreground command returns; each is bounded (cdp.mjs gives up after 60 s,
# or the capture window plus 45 s; ha-ui.sh taps after about 2 min), hence
# MARGIN seconds early.
MARGIN=180
( sleep $(( HOLD_LIMIT - MARGIN )); kill -TERM $$ 2>/dev/null ) &
WATCHDOG_PID=$!
disown "$WATCHDOG_PID" 2>/dev/null

# hold_ok <item> <seconds>: start an item only if it fits in the hold limit.
hold_ok() {
  local left=$(( HOLD_LIMIT - MARGIN - (SECONDS - LOCK_T0) ))
  (( left >= $2 )) && return 0
  record "$1" FAIL "not started: needs ~$2s, ${left}s left of the $((HOLD_LIMIT / 60)) min palma.lock hold"
  return 1
}
ACTIVITY="$(sh_dev cmd package resolve-activity --brief "$PKG" | tail -1)"
[[ "$ACTIVITY" == */* ]] || { echo "$PKG has no launcher activity" >&2; exit 5; }
read -r SCREEN_W SCREEN_H < <(sh_dev wm size | tail -1 | sed -E 's/.*: *([0-9]+)x([0-9]+).*/\1 \2/')
VERSION="$(sh_dev dumpsys package "$PKG" | sed -n 's/^ *versionName=//p' | head -1)"
APP_UID="$(sh_dev dumpsys package "$PKG" | sed -nE 's/^ *(appId|userId)=([0-9]+).*/\2/p' | head -1)"
log "device $SERIAL  app $VERSION (uid ${APP_UID:-?})  screen ${SCREEN_W}x${SCREEN_H}  evidence $OUT"
adbs push "$WORK/ha-ui.sh" /data/local/tmp/ha-ui.sh >/dev/null && sh_dev chmod 755 /data/local/tmp/ha-ui.sh
adbs push "$WORK/ha-sock.sh" /data/local/tmp/ha-sock.sh >/dev/null && sh_dev chmod 755 /data/local/tmp/ha-sock.sh
ui() { sh_dev sh /data/local/tmp/ha-ui.sh "$@"; }

# attach: wait for the app process and its WebView devtools socket, forward it.
attach() {
  local deadline=$((SECONDS + 30)) sock=""
  PID=""
  while (( SECONDS < deadline )); do
    PID="$(sh_dev pidof "$PKG" | awk '{print $1}')"
    if [[ -n "$PID" ]]; then
      sock="$(sh_dev cat /proc/net/unix | awk -v n="@webview_devtools_remote_$PID" '$NF == n { print substr($NF, 2) }' | head -1)"
      [[ -n "$sock" ]] && break
    fi
    sleep 1
  done
  [[ -n "$sock" ]] || return 1
  adb -s "$SERIAL" forward "tcp:$PORT" "localabstract:$sock" >/dev/null || return 1
  while (( SECONDS < deadline + 15 )); do
    curl -s -m 5 "http://127.0.0.1:$PORT/json/list" | grep -q '"type": *"page"' && return 0
    sleep 1
  done
  return 1
}

cold_start() {
  sh_dev am force-stop "$PKG" >/dev/null
  sh_dev am start -W -n "$ACTIVITY" >/dev/null
  attach
}

# wait_path <prefix> [seconds]: page loaded and on a route starting with prefix.
wait_path() {
  local prefix="$1" deadline=$((SECONDS + ${2:-25})) r
  while (( SECONDS < deadline )); do
    r="$(cdp_eval "{\"p\":\"$prefix\"}" 2>/dev/null <<'JS'
return document.readyState === 'complete' && location.pathname.startsWith(ARGS.p) ? location.pathname + location.search : '';
JS
)"
    [[ -n "$r" && "$r" != '""' ]] && { echo "$r"; return 0; }
    sleep 1
  done
  return 1
}

goto() { # goto /path
  cdp_eval "{\"p\":\"$1\"}" >/dev/null 2>&1 <<'JS'
location.assign(ARGS.p); return true;
JS
  sleep 2
  wait_path "${1%%\?*}" 30 >/dev/null
}

# discover_rendered: the Discover page itself rendered (its header's back
# button), not a missing-route page that merely kept the /discover path.
discover_rendered() {
  [[ "$(cdp_eval '{}' 2>/dev/null <<'JS'
for (let i = 0; i < 20; i++) {
  if (location.pathname.startsWith('/discover') && document.querySelector('button[aria-label="Back to library"]')) return true;
  await sleep(1000);
}
return false;
JS
)" == true ]]
}

# The keyguard and a dark panel make screenshots and input meaningless.
screen_ready() {
  local w k
  w="$(sh_dev dumpsys power | sed -n 's/.*mWakefulness=//p' | head -1)"
  k="$(sh_dev dumpsys window | grep -o 'isKeyguardShowing=[a-z]*' | head -1)"
  [[ "$w" == Awake* && "$k" != *true ]]
}
px() { python3 -W ignore "$WORK/px.py" "$@"; }

screencap() { # screencap <name>
  sh_dev screencap -p "/sdcard/ha-$1.png" >/dev/null
  adbs pull "/sdcard/ha-$1.png" "$OUT/$1.png" >/dev/null 2>&1
  sh_dev rm -f "/sdcard/ha-$1.png" >/dev/null
  echo "$OUT/$1.png"
}

# Library rows straight from the app's own library.json and book config.
read_library() {
  cdp_eval '{}' <<'JS'
const inv = window.__TAURI_INTERNALS__.invoke;
const text = async (path) => {
  const r = await inv('plugin:fs|read_text_file', { path, options: { baseDir: 14 } });
  return new TextDecoder().decode(r instanceof ArrayBuffer ? r : Uint8Array.from(r));
};
const books = JSON.parse(await text('Readest/Books/library.json'));
const local = [];
for (const b of books) {
  if (b.deletedAt || b.format !== 'EPUB' || !b.progress) continue;
  let entries = [];
  try { entries = await inv('plugin:fs|read_dir', { path: `Readest/Books/${b.hash}`, options: { baseDir: 14 } }); } catch { continue; }
  if (!entries.some((e) => /\.epub$/i.test(e.name))) continue;
  local.push({ hash: b.hash, calibreId: b.calibreId || null, title: b.title, author: b.author || '', updatedAt: b.updatedAt || 0 });
}
// Rows that already carry a Calibre id first (the deep link needs one), newest first.
local.sort((a, b) => Number(!!b.calibreId) - Number(!!a.calibreId) || b.updatedAt - a.updatedAt);
return { total: books.length, local: local.slice(0, 5) };
JS
}

read_position() { # read_position <hash> -> {"progress":[..],"location":"..."}
  cdp_eval "{\"hash\":\"$1\"}" <<'JS'
const inv = window.__TAURI_INTERNALS__.invoke;
const text = async (path) => {
  const r = await inv('plugin:fs|read_text_file', { path, options: { baseDir: 14 } });
  return new TextDecoder().decode(r instanceof ArrayBuffer ? r : Uint8Array.from(r));
};
const books = JSON.parse(await text('Readest/Books/library.json'));
const row = books.find((b) => b.hash === ARGS.hash) || {};
let cfg = {};
try { cfg = JSON.parse(await text(`Readest/Books/${ARGS.hash}/config.json`)); } catch {}
return { libraryProgress: row.progress || null, progress: cfg.progress || null, location: cfg.location || null };
JS
}

# read_displayed <saved-cfi>: what the reader actually shows. Takes the
# visible foliate-view's own relocate state (lastLocation: section index, page
# range, page numbers) and checks that the saved CFI's start lies inside the
# page on screen, in the same section. Stored progress alone can stay the same
# while the reader shows another book or page.
read_displayed() {
  local cfi_json
  cfi_json="$("$NODE" -e 'console.log(JSON.stringify({cfi: process.argv[1]}))' "$1")"
  cdp_eval "$cfi_json" <<'JS'
const view = [...document.querySelectorAll('foliate-view')].find((v) => v.getBoundingClientRect().width > 0);
if (!view) return { error: 'no visible foliate-view' };
const ll = view.lastLocation;
if (!ll?.range) return { error: 'reader has not relocated yet' };
const t = view.book?.metadata?.title;
const title = typeof t === 'string' ? t : t && typeof t === 'object' ? Object.values(t)[0] ?? null : null;
const out = { path: location.pathname + location.search, title, cfi: ll.cfi, index: ll.section?.current ?? null,
  page: ll.location ? [ll.location.current + 1, ll.location.total] : null };
if (!ARGS.cfi) return { ...out, error: 'no saved CFI to compare' };
let nav;
try { nav = view.resolveNavigation(ARGS.cfi); } catch (e) { return { ...out, error: `saved CFI does not resolve: ${e}` }; }
out.savedIndex = nav?.index ?? null;
if (nav?.index !== out.index) return { ...out, onPage: false };
const doc = ll.range.startContainer.ownerDocument;
let target = typeof nav.anchor === 'function' ? nav.anchor(doc) : null;
if (target && !(target instanceof doc.defaultView.Range)) { const r = doc.createRange(); r.selectNode(target); target = r; }
if (!target) return { ...out, error: 'saved CFI has no anchor in the shown section' };
out.onPage = ll.range.compareBoundaryPoints(Range.START_TO_START, target) <= 0
  && ll.range.compareBoundaryPoints(Range.END_TO_START, target) >= 0;
return out;
JS
}

# A locked or dark panel hides the WebView (innerWidth 0, virtualized shelves
# render nothing, timers throttle), so UI items need an unlocked screen.
SCREEN_OK=1
if ! screen_ready; then
  SCREEN_OK=0
  log "screen is off or the keyguard is up: items 2, 3, 4, 5 and 7 need the Palma unlocked; no input is sent into the lock screen"
fi
ui_item() { # ui_item <n> <seconds>: item n is wanted, the screen allows it, and it fits the hold
  want "$1" || return 1
  if [[ $SCREEN_OK == 0 ]]; then
    record "$1" FAIL "needs an unlocked, awake screen (keyguard up or panel asleep)"
    return 1
  fi
  hold_ok "$1" "$2"
}

# --- 6. provider ---------------------------------------------------------------
if want 6 && hold_ok 6 15; then
  out="$(sh_dev content query --uri "$PROVIDER_URI" 2>&1)"
  echo "$out" > "$OUT/6-provider.txt"
  if grep -q '^Row: 0' <<<"$out"; then
    record 6 PASS "provider row: $(grep '^Row: 0' <<<"$out" | head -1 | cut -c1-160)"
  else
    record 6 FAIL "no row: $(head -2 <<<"$out" | tr '\n' ' ' | cut -c1-200)"
  fi
fi

# --- 1. cold start network ------------------------------------------------------
# allowed_ips: the Homebase host's addresses (resolved here; the tailnet gives
# the Palma the same MagicDNS answer) plus any --homebase-ip.
allowed_ips() {
  python3 - "$HOMEBASE_HOST" "$HOMEBASE_IPS_EXTRA" <<'PY'
import json, socket, sys
ips = set(sys.argv[2].split())
try:
    ips |= {a[4][0] for a in socket.getaddrinfo(sys.argv[1], 443)}
except OSError:
    pass
print(json.dumps(sorted(ips)))
PY
}
# forbidden_labels: best-effort names for addresses of the forbidden services,
# so a FAIL says which one it was. Any address outside allowed_ips fails
# whether or not it has a label.
forbidden_labels() {
  python3 - <<'PY'
import json, socket
names = ['readest.com', 'www.readest.com', 'web.readest.com', 'api.readest.com',
         'us.i.posthog.com', 'us-assets.i.posthog.com', 'app.posthog.com', 'eu.i.posthog.com',
         'fonts.googleapis.com', 'www.googleapis.com', 'safebrowsing.googleapis.com',
         'fonts.gstatic.com', 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'db.onlinewebfonts.com']
out = {}
for n in names:
    try:
        for a in socket.getaddrinfo(n, 443):
            out.setdefault(a[4][0], n)
    except OSError:
        pass
print(json.dumps(out))
PY
}

if want 1 || want 2 || want 3 || want 4 || want 5; then
  sh_dev am force-stop "$PKG" >/dev/null
  adbs logcat -c
  if want 1 && [[ -n "$APP_UID" ]]; then
    # Every socket of the app's uid, native (Rust tauriFetch, reqwest) and
    # WebView alike, sampled 5 times a second from the kernel tables. Started
    # before the app so the first connection is inside the window.
    adbs shell sh /data/local/tmp/ha-sock.sh "$APP_UID" 300 /data/local/tmp/ha-sock.txt >/dev/null 2>&1 &
    SOCK_PID=$!
    sleep 1
  fi
  T0=$SECONDS
  sh_dev am start -W -n "$ACTIVITY" >/dev/null
  if ! attach; then
    record 1 FAIL "no WebView devtools socket for $PKG (is this a --features devtools build?)"
    echo; echo "cannot continue without CDP"; exit 1
  fi
  if want 1; then
    # 30 s of first boot (Network from attach, Resource Timing back to
    # navigation start), then 20 s of a reload captured from its first request.
    remaining=$(( 30 - (SECONDS - T0) )); (( remaining < 10 )) && remaining=10
    cap_ok=1
    net="$("$NODE" "$WORK/cdp.mjs" "$PORT" net "$remaining" 20 2>"$OUT/1-cdp.err")" || cap_ok=0
    # Then Discover for 15 s: its client fetches through native tauriFetch,
    # which CDP never sees; only the socket sampler covers it.
    NAT_FROM="$(sh_dev date +%s)"
    disc_open=0; goto /discover && discover_rendered && disc_open=1
    sleep 15
    NAT_TO="$(sh_dev date +%s)"
    goto /library
    sleep 2
    adbs logcat -d --pid="$PID" > "$OUT/1-logcat.txt" 2>/dev/null || adbs logcat -d > "$OUT/1-logcat.txt"
    echo "${net:-}" > "$OUT/1-network.json"
    sock='{"error":"no app uid, sampler not run"}'
    if [[ -n "$SOCK_PID" ]]; then
      sh_dev touch /data/local/tmp/ha-sock.stop >/dev/null
      wait "$SOCK_PID" 2>/dev/null; SOCK_PID=""
      adbs pull /data/local/tmp/ha-sock.txt "$OUT/1-sockets.txt" >/dev/null 2>&1
      ALLOWED="$(allowed_ips)"
      if [[ "$ALLOWED" == '[]' ]]; then
        sock='{"error":"could not resolve the Homebase host"}'
      elif [[ -s "$OUT/1-sockets.txt" ]]; then
        sock="$(python3 "$WORK/sock.py" "$OUT/1-sockets.txt" "$ALLOWED" "$(forbidden_labels)" "${NAT_FROM:-0}" "${NAT_TO:-0}" 2>&1)"
      else
        sock='{"error":"no socket samples came back"}'
      fi
    fi
    echo "$sock" > "$OUT/1-sockets.json"
    # The sampler must have run through the window and seen the app talk to
    # Homebase at least once, or a clean list proves nothing.
    sock_ok=0
    [[ "$sock" == \{* && "$(jget "$sock" "!v.error && v.samples >= 100 && v.homebase > 0 && v.last >= ${NAT_TO:-0}")" == true ]] && sock_ok=1
    sockbad=""
    [[ $sock_ok == 1 ]] && sockbad="$(jget "$sock" 'v.bad.map(s=>`${s.remote}:${s.port}/${s.proto}(${s.label})`).join(" ")')"
    if [[ $cap_ok == 1 && "$net" == \{* ]] \
       && [[ "$(jget "$net" 'v.documentSeen && v.reloadNetwork > 0 && v.firstBoot > 0 && !v.bufferFull')" != true ]]; then
      cap_ok=0
      echo "capture incomplete: $(jget "$net" '({documentSeen:v.documentSeen,reloadNetwork:v.reloadNetwork,firstBoot:v.firstBoot,bufferFull:v.bufferFull})')" >> "$OUT/1-cdp.err"
    fi
    [[ "$net" == \{* ]] || cap_ok=0
    logbad="$(grep -Eoi "[a-z0-9.-]*($FORBIDDEN_RE)[a-z0-9.-]*" "$OUT/1-logcat.txt" | sort -u | tr '\n' ' ')"
    if [[ $disc_open == 0 ]]; then
      # The native discover client runs only on /discover.
      record 1 FAIL "Discover did not open, so the native discover client was not exercised (sockets: $(cut -c1-160 <<<"$sock"))"
    elif [[ $sock_ok == 0 ]]; then
      # Without the kernel view, native requests are unproven: never pass.
      record 1 FAIL "socket sampler gave no usable view of the app's connections: $(cut -c1-200 <<<"$sock")"
    elif [[ -n "$sockbad" ]]; then
      record 1 FAIL "app uid connected outside Homebase: $sockbad"
    elif [[ $cap_ok == 0 ]]; then
      # No capture is not a clean network: never pass on an empty list.
      record 1 FAIL "CDP network capture failed or saw nothing ($(tail -1 "$OUT/1-cdp.err" 2>/dev/null | cut -c1-200)); logcat:${logbad:-clean}"
    else
      hosts="$(jget "$net" 'v.urls.filter(u=>/^(https?|wss?):/.test(u)).map(u=>new URL(u).hostname).filter((h,i,a)=>a.indexOf(h)===i).join(" ")')"
      bad=""; other=""
      for h in $hosts; do
        if grep -Eqi "$FORBIDDEN_RE" <<<"$h"; then bad="$bad $h"
        elif [[ "$h" != "$HOMEBASE_HOST" ]] && ! grep -Eq "$LOCAL_HOSTS_RE" <<<"$h"; then other="$other $h"; fi
      done
      n="$(jget "$net" '`${v.urls.length} urls (first boot: ${v.firstBoot} Resource Timing + ${v.firstBootNetwork} Network; reload: ${v.reloadNetwork} Network; ${v.workers} workers)`')"
      sn="$(jget "$sock" '`${v.endpoints} app sockets in ${v.samples} samples, ${v.homebase} to Homebase (${v.homebaseDuringDiscover} opened during Discover), ${v.dns.length} DNS`')"
      if [[ -z "$bad$other" && -z "$logbad" ]]; then
        record 1 PASS "30s cold start, a captured reload and 15s of Discover: kernel sockets $sn, none elsewhere; CDP $n, hosts: ${hosts:-none}; logcat clean"
      else
        record 1 FAIL "forbidden:${bad:- none} other:${other:- none} logcat:${logbad:-none}"
      fi
    fi
  fi
  wait_path / 20 >/dev/null
fi

# --- 2. no sign-in UI ---------------------------------------------------------
if ui_item 2 30; then
  goto /library
  sleep 3
  r="$(cdp_eval '{}' 2>&1 <<'JS'
const books = [...document.querySelectorAll('[data-book-hash],[data-group-name]')].map((e) => e.innerText).filter(Boolean);
const visible = () => {
  let t = document.body.innerText || '';
  for (const b of books) t = t.split(b).join(' ');
  return t;
};
const re = /\b(sign in|log in|account)\b/gi;
const hits = (t) => [...t.matchAll(re)].map((m) => t.slice(Math.max(0, m.index - 30), m.index + 40).replace(/\s+/g, ' '));
const page = hits(visible());
const toggle = document.querySelector('[aria-label="Settings Menu"]');
if (!toggle) return { error: 'no Settings Menu button', page };
toggle.click();
await sleep(1200);
const items = [...document.querySelectorAll('[role="menuitem"]')].map((e) => (e.innerText || e.getAttribute('aria-label') || '').trim()).filter(Boolean);
const menu = hits(visible());
document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
toggle.click();
return { page, menu, items: items.slice(0, 40), path: location.pathname };
JS
)"
  echo "$r" > "$OUT/2-signin.json"
  if [[ "$r" == \{* ]] && [[ "$(jget "$r" '!v.error && v.page.length===0 && v.menu.length===0')" == true ]]; then
    record 2 PASS "no Sign In / Log in / Account on /library or in its menu (menu items: $(jget "$r" 'v.items.slice(0,12).join(", ")'))"
  else
    record 2 FAIL "$(cut -c1-300 <<<"$r")"
  fi
fi

# --- pick a local book for 3, 4, 5 -----------------------------------------
BOOK_HASH=""; BOOK_ID=""; BOOK_TITLE=""
if want 3 || want 4 || want 5; then
  lib="$(read_library 2>&1)"
  echo "$lib" > "$OUT/library-pick.json"
  if [[ "$lib" == \{* ]] && [[ "$(jget "$lib" 'v.local.length')" != 0 ]]; then
    BOOK_HASH="$(jget "$lib" 'v.local[0].hash')"
    BOOK_ID="$(jget "$lib" 'v.local[0].calibreId')"
    BOOK_TITLE="$(jget "$lib" 'v.local[0].title')"
    log "book: \"$BOOK_TITLE\" calibreId=$BOOK_ID hash=$BOOK_HASH"
  else
    log "no downloaded EPUB with saved progress: $(cut -c1-200 <<<"$lib")"
  fi
fi

# --- 4. TTS tab and household audio row ------------------------------------------
if ui_item 4 45; then
  goto /library
  sleep 2
  r="$(cdp_eval "{\"hash\":\"$BOOK_HASH\"}" 2>&1 <<'JS'
const out = {};
const byText = (sel, text) => [...document.querySelectorAll(sel)].find((e) => (e.innerText || '').trim() === text);
const toggle = document.querySelector('[aria-label="Settings Menu"]');
toggle?.click();
await sleep(1000);
const settings = byText('[role="menuitem"]', 'Settings') || document.querySelector('[role="menuitem"][aria-label^="Settings"]');
settings?.click();
await sleep(2000);
const tab = document.querySelector('button[data-tab="TTS"]');
out.ttsTab = !!tab;
if (tab) {
  tab.click();
  await sleep(1200);
  out.ttsActive = tab.classList.contains('btn-active');
  out.ttsPanelText = (tab.closest('[role="dialog"], .modal-box, dialog')?.innerText || '').slice(0, 300);
}
const dialog = tab?.closest('[role="dialog"], dialog, .modal-box, .modal');
const closers = dialog ? dialog.querySelectorAll('[aria-label="Close"]') : document.querySelectorAll('[aria-label="Close"]');
closers.forEach((e) => e.click());
await sleep(800);
{
  // Any shelf book has the audio row; prefer the picked one if it is rendered.
  const cell = (ARGS.hash && document.querySelector(`[data-book-hash="${ARGS.hash}"]`)) || document.querySelector('[data-book-hash]');
  out.bookCell = cell ? cell.getAttribute('data-book-hash') : null;
  if (cell) {
    cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    await sleep(1200);
    const details = byText('button', 'Details');
    out.detailsButton = !!details;
    details?.click();
    await sleep(2500);
    const row = document.querySelector('section[aria-label="Audio"]');
    out.audioRow = !!row;
    out.audioRowText = row ? row.innerText.replace(/\s+/g, ' ').slice(0, 200) : null;
    out.audioRowIcons = row ? row.querySelectorAll('svg').length : 0;
    document.querySelector('[aria-label="Close"]')?.click();
    await sleep(800);
    byText('button', 'Cancel')?.click();
  }
}
return out;
JS
)"
  echo "$r" > "$OUT/4-audio.json"
  screencap 4-library >/dev/null
  if [[ "$r" == \{* ]] && [[ "$(jget "$r" 'v.ttsTab && v.ttsActive && v.audioRow && v.audioRowIcons > 0')" == true ]]; then
    record 4 PASS "TTS tab opens; household audio row: \"$(jget "$r" 'v.audioRowText')\" ($(jget "$r" 'v.audioRowIcons') icons)"
  else
    record 4 FAIL "$(cut -c1-300 <<<"$r")"
  fi
fi

# --- 5. deep link ----------------------------------------------------------------
if ui_item 5 75; then
  if [[ -z "$BOOK_HASH" ]]; then
    record 5 FAIL "no downloaded book with saved progress to open"
  elif [[ "$BOOK_ID" == null ]]; then
    record 5 FAIL "no downloaded book carries a calibreId in library.json yet (Homebase sync has not written calibre_id), so a launcher link cannot name one"
  else
    before="$(read_position "$BOOK_HASH" 2>&1)"
    saved_cfi="$(jget "$before" 'v.location || ""' 2>/dev/null)"
    link="palma-readest://open?calibreId=$BOOK_ID&hash=$BOOK_HASH"
    sh_dev am force-stop "$PKG" >/dev/null
    sh_dev "am start -W -a android.intent.action.VIEW -d '$link'" > "$OUT/5-am-start-1.txt"
    attach
    p1="$(wait_path /reader 40)"; sleep 8
    first="$(read_position "$BOOK_HASH" 2>&1)"
    shown1="$(read_displayed "$saved_cfi" 2>&1)"
    screencap 5-deeplink-cold >/dev/null
    sh_dev "am start -W -a android.intent.action.VIEW -d '$link'" > "$OUT/5-am-start-2.txt"
    sleep 8
    p2="$(wait_path /reader 10)"
    second="$(read_position "$BOOK_HASH" 2>&1)"
    shown2="$(read_displayed "$saved_cfi" 2>&1)"
    screencap 5-deeplink-warm >/dev/null
    printf 'before %s\nafter-cold %s\nafter-warm %s\nshown-cold %s\nshown-warm %s\npaths %s | %s\n' \
      "$before" "$first" "$second" "$shown1" "$shown2" "$p1" "$p2" > "$OUT/5-positions.txt"
    same() { [[ "$(jget "$1" 'JSON.stringify([v.location,v.progress])')" == "$(jget "$2" 'JSON.stringify([v.location,v.progress])')" ]]; }
    on_page() { [[ "$1" == \{* && "$(jget "$1" 'v.onPage === true && !v.error')" == true ]]; }
    title_ok() { local t; t="$(jget "$1" 'v.title || ""' 2>/dev/null)"; [[ -z "$t" || "$t" == "$BOOK_TITLE" ]]; }
    if [[ -z "$saved_cfi" ]]; then
      record 5 FAIL "book $BOOK_HASH has no saved location CFI to open at"
    elif [[ "$p1" == *"$BOOK_HASH"* && "$p2" == *"$BOOK_HASH"* ]] && same "$before" "$first" && same "$first" "$second" \
      && on_page "$shown1" && on_page "$shown2" && title_ok "$shown1" \
      && [[ "$(jget "$shown1" 'v.cfi')" == "$(jget "$shown2" 'v.cfi')" ]]; then
      record 5 PASS "reader shows \"$BOOK_TITLE\" ($BOOK_HASH) with the saved CFI on screen, page $(jget "$shown1" 'JSON.stringify(v.page)'); second start kept the same page"
    else
      record 5 FAIL "paths [$p1] [$p2]; shown cold $(cut -c1-160 <<<"$shown1"); shown warm $(cut -c1-160 <<<"$shown2"); stored before $(jget "$before" 'JSON.stringify(v.progress)') cold $(jget "$first" 'JSON.stringify(v.progress)') warm $(jget "$second" 'JSON.stringify(v.progress)')"
    fi
  fi
fi

# --- 3. night mode -----------------------------------------------------------
# reader_geom <name>: the visible book text-line rectangles (CSS px, from
# Range.getClientRects over the section's text nodes), the page area, and the
# WebView's screen box from uiautomator, so px.py measures only book text.
reader_geom() {
  local g box f="$OUT/3-$1-geom.json"
  g="$(cdp_eval '{}' 2>&1 <<'JS'
const view = [...document.querySelectorAll('foliate-view')].find((v) => v.getBoundingClientRect().width > 0);
if (!view?.renderer?.getContents) return { error: 'no visible foliate-view' };
const host = view.renderer.getBoundingClientRect();
const vis = { l: Math.max(0, host.left), t: Math.max(0, host.top), r: Math.min(innerWidth, host.right), b: Math.min(innerHeight, host.bottom) };
const rects = [];
for (const { doc } of view.renderer.getContents()) {
  const frame = doc?.defaultView?.frameElement;
  if (!frame || !doc.body) continue;
  const f = frame.getBoundingClientRect();
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const range = doc.createRange();
  for (let n = walker.nextNode(); n && rects.length < 60; n = walker.nextNode()) {
    if (!/\S{3,}/.test(n.data) || !n.parentElement) continue;
    const cs = doc.defaultView.getComputedStyle(n.parentElement);
    if (cs.visibility !== 'visible' || Number(cs.opacity) === 0) continue;
    range.selectNodeContents(n);
    for (const r of range.getClientRects()) {
      const l = f.left + r.left, t = f.top + r.top;
      if (r.width < 24 || r.height < 8) continue;
      if (l < vis.l || t < vis.t || l + r.width > vis.r || t + r.height > vis.b) continue;
      rects.push([l, t, r.width, r.height]);
    }
  }
}
return { rects, page: [vis.l, vis.t, vis.r - vis.l, vis.b - vis.t], iw: innerWidth, ih: innerHeight };
JS
)"
  [[ "$g" == \{* ]] || g="{\"error\":\"no reader geometry from CDP\"}"
  box="$(ui wvbox 2>/dev/null | tail -1)"
  "$NODE" -e '
    const [g, box, sw, sh] = process.argv.slice(1);
    const v = JSON.parse(g);
    if (v.error) { console.log(JSON.stringify(v)); process.exit(0); }
    const b = box.trim().split(/\s+/).map(Number);
    let out;
    if (b.length === 4 && b.every(Number.isFinite) && b[2] > b[0]) {
      out = { x0: b[0], y0: b[1], scale: (b[2] - b[0]) / v.iw, from: "uiautomator" };
    } else {
      const s = Number(sw) / v.iw;
      out = { x0: 0, y0: Number(sh) - v.ih * s, scale: s, from: "screen size" };
    }
    console.log(JSON.stringify({ ...v, box: out }));
  ' "$g" "$box" "$SCREEN_W" "$SCREEN_H" > "$f" 2>/dev/null || echo '{"error":"geometry"}' > "$f"
  echo "$f"
}

if ui_item 3 170; then
  if [[ -z "$BOOK_HASH" ]]; then
    record 3 FAIL "no downloaded book to open"
  elif ! screen_ready; then
    record 3 FAIL "screen is off or the keyguard is up; unlock the Palma first (no input is sent into the lock screen)"
  else
    [[ "$(wait_path /reader 3)" == *"$BOOK_HASH"* ]] || goto "/reader?ids=$BOOK_HASH"
    THEME_ORIGINAL="$(cdp_eval '{}' <<'JS' | tr -d '"'
return localStorage.getItem('themeMode') || 'schedule';
JS
)"
    start_pos="$(read_position "$BOOK_HASH" 2>&1)"
    THEME_CHANGED=1
    cdp_eval '{}' >/dev/null 2>&1 <<'JS'
localStorage.setItem('themeMode', 'dark'); location.reload(); return true;
JS
    sleep 3; wait_path /reader 40 >/dev/null; sleep 8
    a="$(screencap 3-dark-turn00)"
    ga="$(reader_geom turn00)"
    sa="$(px text "$a" "$ga" 2>&1)"
    wa="$(px stats "$a")"
    progress_of() { jget "$(read_position "$BOOK_HASH" 2>/dev/null || echo '{}')" 'JSON.stringify(v.progress)'; }
    p0="$(progress_of)"
    # DPAD_RIGHT reaches the WebView as ArrowRight; if the first one does not
    # move the page, use edge taps instead.
    turn_next() { sh_dev input keyevent 22 >/dev/null; }
    turn_prev() { sh_dev input keyevent 21 >/dev/null; }
    METHOD=keyevent
    turn_next; sleep 3
    if [[ "$(progress_of)" == "$p0" ]]; then
      turn_next() { sh_dev input tap $((SCREEN_W * 92 / 100)) $((SCREEN_H / 2)) >/dev/null; }
      turn_prev() { sh_dev input tap $((SCREEN_W * 8 / 100)) $((SCREEN_H / 2)) >/dev/null; }
      METHOD=tap
      turn_next; sleep 3
    fi
    for _ in $(seq 2 10); do turn_next; sleep 2; done
    sleep 3
    b="$(screencap 3-dark-turn10)"
    gb="$(reader_geom turn10)"
    sb="$(px text "$b" "$gb" 2>&1)"
    wb="$(px stats "$b")"
    changed="$(jget "$(px diff "$a" "$b")" 'v.changed')"
    p10="$(progress_of)"
    for _ in $(seq 1 10); do turn_prev; sleep 2; done
    sleep 3
    pback="$(progress_of)"
    cdp_eval "{\"mode\":\"$THEME_ORIGINAL\"}" >/dev/null 2>&1 <<'JS'
localStorage.setItem('themeMode', ARGS.mode); location.reload(); return true;
JS
    THEME_CHANGED=0
    sleep 3; wait_path /reader 40 >/dev/null
    printf 'turn00 text-rects %s\nturn00 whole-page %s\nturn10 text-rects %s\nturn10 whole-page %s\nmethod %s screen-changed %s\nprogress start %s after-10 %s after-back %s\nstart position %s\ntheme restored to %s\ngeometry %s %s\n' \
      "$sa" "$wa" "$sb" "$wb" "$METHOD" "$changed" "$p0" "$p10" "$pback" "$start_pos" "$THEME_ORIGINAL" "$ga" "$gb" > "$OUT/3-night.txt"
    # Page background from the reader's page area; text colour only from the
    # pixels inside book text-line rectangles, white in most of the lines.
    ok() { [[ "$1" == \{* && "$(jget "$1" 'v.background.join(",")==="0,0,0" && v.textOk === true')" == true ]]; }
    tdesc() { jget "$1" '`bg ${v.background.join(",")} text ${v.text ? v.text.join(",") : "none"} (${v.rectsWithWhite}/${v.rects} lines white, chroma ${v.chromaShare})`'; }
    if ok "$sa" && ok "$sb" && [[ "$p10" != "$p0" ]]; then
      record 3 PASS "$(tdesc "$sa"); after 10 $METHOD turns ($p0 -> $p10) $(tdesc "$sb"); themeMode back to $THEME_ORIGINAL"
    else
      record 3 FAIL "turn00 $(cut -c1-220 <<<"$sa") turn10 $(cut -c1-220 <<<"$sb") progress $p0 -> $p10 method=$METHOD"
    fi
    if [[ "$pback" != "$p0" ]]; then
      log "WARN: reading position is $pback after turning back (started at $p0); the start position is in $OUT/3-night.txt"
    fi
  fi
fi

# --- 7. offline --------------------------------------------------------------
# discover_setup: open Discover online so it saves its shelves, and pick the
# work to request offline: unowned, first published in 1928 or earlier (a
# public-domain request is the only kind this script sends), among the first
# four cards of a cached shelf (on screen without expanding it), a plain-text
# label uiautomator can match, and not already queued or being fetched.
discover_setup() {
  goto /discover
  cdp_eval '{}' 2>&1 <<'JS'
for (let i = 0; i < 30; i++) {
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem('household.discover.browse') || 'null'); } catch {}
  const shelves = (cached?.data?.shelves || []).filter((s) => s.works?.length > 0);
  if (shelves.length > 0) {
    const queue = JSON.parse(localStorage.getItem('household.discover.queue') || '[]');
    const queued = new Set(queue.map((e) => (e.body?.title || '').toLowerCase()));
    const plain = /^[A-Za-z0-9 .,:-]+$/;
    let pick = null;
    for (const s of shelves) {
      for (const w of s.works.slice(0, 4)) {
        const author = w.authors?.[0] || '';
        if (pick || w.owned?.ebook || w.owned?.audiobook) continue;
        if (!w.year || w.year > 1928 || (w.activeJobIds || []).length > 0) continue;
        if (!plain.test(w.title) || (author && !plain.test(author))) continue;
        if (queued.has(w.title.toLowerCase())) continue;
        pick = { title: w.title, author, year: w.year, shelf: s.title, label: [w.title, author].filter(Boolean).join(', ') };
      }
    }
    return { shelves: shelves.map((s) => s.title), pick, queueBefore: queue.length };
  }
  await sleep(1000);
}
return { shelves: [], pick: null };
JS
}

title_args() { "$NODE" -e 'console.log(JSON.stringify({t: process.argv[1]}))' "$1"; }

# queue_state <title>: where the requested ebook of <title> is in the app's
# own queue, rejected list and jobs strip.
queue_state() {
  cdp_eval "$(title_args "$1")" 2>/dev/null <<'JS'
const q = JSON.parse(localStorage.getItem('household.discover.queue') || '[]');
const rej = JSON.parse(localStorage.getItem('household.discover.rejected') || '[]');
const mine = q.filter((e) => e.body?.title === ARGS.t && e.body?.want === 'ebook');
const job = [...document.querySelectorAll('[data-testid="discover-job"]')].find((e) => (e.innerText || '').includes(ARGS.t));
return {
  queued: mine.length,
  requestId: mine[0]?.requestId || null,
  rejected: rej.some((e) => e.title === ARGS.t),
  job: !!job,
  queueLength: q.length,
  path: location.pathname,
  online: navigator.onLine,
};
JS
}

# cancel_job <title>: the request is only a proof, so cancel the job it made.
cancel_job() {
  cdp_eval "$(title_args "$1")" 2>/dev/null <<'JS'
for (let i = 0; i < 20; i++) {
  const job = [...document.querySelectorAll('[data-testid="discover-job"]')].find((e) => (e.innerText || '').includes(ARGS.t));
  const cancel = job && [...job.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === 'Cancel' && !b.disabled);
  if (cancel) { cancel.click(); await sleep(2000); return 'job cancelled'; }
  await sleep(1000);
}
return 'no cancellable job shown';
JS
}

# flush_wait <title>: after reconnect, wait (up to 2 min) until the queue no
# longer holds the request.
flush_wait() {
  local r='{"queued":1}'
  for _ in $(seq 1 24); do
    r="$(queue_state "$1")" && [[ "$r" == \{* && "$(jget "$r" 'v.queued === 0')" == true ]] && break
    sleep 5
  done
  echo "$r"
}

if ui_item 7 $(( IS_TCP == 1 ? 480 : 300 )); then
  setup="$(discover_setup)"; [[ "$setup" == \{* ]] || setup='{"shelves":[],"pick":null}'
  echo "$setup" > "$OUT/7-setup.json"
  SHELVES="$(jget "$setup" 'v.shelves')"
  PICK_TITLE="$(jget "$setup" 'v.pick ? v.pick.title : ""')"
  PICK_LABEL="$(jget "$setup" 'v.pick ? v.pick.label : ""')"
  # Leave Discover: while it is mounted it would send the request at once.
  goto /library
  if [[ "$(jget "$SHELVES" 'v.length')" == 0 ]]; then
    record 7 FAIL "Discover saved no shelves while online, so offline has nothing cached to show (airplane mode not touched)"
  elif [[ -z "$PICK_TITLE" ]]; then
    record 7 FAIL "no unowned work first published in 1928 or earlier among the first cards of the cached shelves, so no request is made (airplane mode not touched)"
  elif ! screen_ready; then
    record 7 FAIL "screen is off or the keyguard is up; unlock the Palma first (airplane mode is not touched)"
  elif [[ $IS_TCP == 0 ]]; then
    # USB: airplane mode leaves adb up. Every step is a real tap on a node
    # found by its accessible label; CDP only reads what the app did.
    log "item 7 will request the ebook of \"$PICK_TITLE\" ($(jget "$setup" 'v.pick.year')) through its sheet"
    sh_dev cmd connectivity airplane-mode enable >/dev/null; AIRPLANE_ON=1
    sleep 4
    cold_start || true
    wait_path /library 40 >/dev/null
    r1="$(cdp_eval '{}' 2>&1 <<'JS'
const seen = new Set();
const busy = () => [...document.querySelectorAll('.loading, .toast')].filter((e) => e.offsetParent !== null);
for (let i = 0; i < 16; i++) {
  busy().forEach((e) => seen.add((e.className + ' ' + (e.innerText || '')).trim().slice(0, 120)));
  await sleep(500);
}
return { path: location.pathname, busy: [...seen], books: document.querySelectorAll('[data-book-hash]').length };
JS
)"
    screencap 7-offline-library >/dev/null
    t_disc="$(ui tap Discover)"
    wait_path /discover 20 >/dev/null; sleep 4
    discover_rendered || true
    r2="$(cdp_eval "{\"titles\":$SHELVES}" 2>&1 <<'JS'
const panel = !!document.querySelector('[data-testid="discover-offline"]');
const headings = [...document.querySelectorAll('section[aria-labelledby] h2')].map((h) => (h.innerText || '').trim());
return { panel, cachedShown: ARGS.titles.filter((t) => headings.includes(t)), path: location.pathname };
JS
)"
    t_card="$(ui tap "$PICK_LABEL" scroll)"; sleep 3
    t_get="$(ui tap 'Get ebook')"; sleep 3
    sheet="$(cdp_eval '{}' 2>&1 <<'JS'
const d = document.querySelector('[role="dialog"]');
return { open: !!d, status: (d?.querySelector('[role="status"]')?.innerText || '').trim(), title: (d?.querySelector('h2')?.innerText || '').trim() };
JS
)"
    screencap 7-offline-sheet >/dev/null
    sleep 3   # past the 3 s mark: an offline entry must still be waiting
    q1="$(queue_state "$PICK_TITLE")"
    ui tap Close >/dev/null; sleep 2
    waiting="$(cdp_eval "$(title_args "$PICK_TITLE")" 2>&1 <<'JS'
const w = document.querySelector('section[aria-label="Waiting to send"]');
return !!w && (w.innerText || '').includes(ARGS.t);
JS
)"
    screencap 7-offline-discover >/dev/null
    sh_dev cmd connectivity airplane-mode disable >/dev/null; AIRPLANE_ON=0
    r3="$(flush_wait "$PICK_TITLE")"
    screencap 7-back-online >/dev/null
    cancelled="$(cancel_job "$PICK_TITLE")"
    printf 'setup %s\nlibrary %s\ntaps discover[%s] card[%s] get[%s]\ndiscover %s\nsheet %s\nqueue-offline %s\nwaiting-lists-it %s\nflush %s\ncancel %s\n' \
      "$setup" "$r1" "$t_disc" "$t_card" "$t_get" "$r2" "$sheet" "$q1" "$waiting" "$r3" "$cancelled" > "$OUT/7-offline.txt"
    if [[ "$(jget "$r1" 'v.path.startsWith("/library") && v.busy.length===0')" == true \
       && "$t_disc|$t_card|$t_get" == tapped*"|tapped"*"|tapped"* \
       && "$(jget "$r2" 'v.panel && v.cachedShown.length>0')" == true \
       && "$(jget "$sheet" 'v.open && v.status.startsWith("Saved.")')" == true \
       && "$(jget "$q1" 'v.queued === 1 && !v.rejected')" == true && "$waiting" == true \
       && "$(jget "$r3" 'v.queued === 0 && !v.rejected')" == true ]]; then
      record 7 PASS "offline library quiet ($(jget "$r1" 'v.books') books); offline panel with cached shelves [$(jget "$r2" 'v.cachedShown.join(", ")')]; tapped Get ebook on \"$PICK_TITLE\": \"$(jget "$sheet" 'v.status')\", waiting in the queue and under Waiting to send, then flushed after reconnect (job shown: $(jget "$r3" 'v.job'); $cancelled)"
    else
      record 7 FAIL "library $r1 | taps [$t_disc] [$t_card] [$t_get] | discover $r2 | sheet $sheet | queue $q1 waiting=$waiting | flush $r3"
    fi
  else
    # Tailnet adb drops in airplane mode, so the offline steps run from a
    # detached on-device script that taps by accessible label (ha-ui.sh) and
    # saves screens and dumps; the flush is read over CDP once Wi-Fi returns.
    log "item 7 will request the ebook of \"$PICK_TITLE\" ($(jget "$setup" 'v.pick.year')) through its sheet"
    cat > "$WORK/offline.sh" <<EOF
#!/system/bin/sh
D=/sdcard/ha-offline; rm -rf \$D; mkdir -p \$D
UI="sh /data/local/tmp/ha-ui.sh"
# Watchdog: the network comes back even if a step below hangs.
(sleep 200; cmd connectivity airplane-mode disable) &
am force-stop $PKG
cmd connectivity airplane-mode enable
sleep 6
am start -W -n $ACTIVITY > \$D/start.txt
sleep 14
screencap -p \$D/library.png
\$UI dump \$D/library.xml
\$UI tap Discover > \$D/tap-discover.txt 2>&1
sleep 10
\$UI tap '$PICK_LABEL' scroll > \$D/tap-card.txt 2>&1
sleep 5
\$UI tap 'Get ebook' > \$D/tap-get.txt 2>&1
sleep 5
screencap -p \$D/sheet.png
\$UI dump \$D/sheet.xml
\$UI tap Close > \$D/tap-close.txt 2>&1
sleep 4
screencap -p \$D/discover.png
\$UI dump \$D/discover.xml
cmd connectivity airplane-mode disable
echo done > \$D/finished
EOF
    adbs push "$WORK/offline.sh" /data/local/tmp/ha-offline.sh >/dev/null
    sh_dev "chmod 755 /data/local/tmp/ha-offline.sh; nohup /data/local/tmp/ha-offline.sh >/dev/null 2>&1 &"
    AIRPLANE_ON=1
    log "offline run detached on the device; waiting for adb to come back"
    sleep 60
    back=0
    for _ in $(seq 1 48); do
      adb connect "$SERIAL" >/dev/null 2>&1
      if adbs shell test -f /sdcard/ha-offline/finished 2>/dev/null; then back=1; break; fi
      sleep 5
    done
    if [[ $back == 0 ]]; then
      record 7 FAIL "device did not come back on $SERIAL within 5 min; airplane mode may need turning off by hand"
    else
      AIRPLANE_ON=0
      for f in library.png sheet.png discover.png library.xml sheet.xml discover.xml start.txt tap-discover.txt tap-card.txt tap-get.txt tap-close.txt; do
        adbs pull "/sdcard/ha-offline/$f" "$OUT/7-offline-$f" >/dev/null 2>&1
      done
      sh_dev rm -rf /sdcard/ha-offline /data/local/tmp/ha-offline.sh >/dev/null
      lib_bad="$(grep -Eoi 'text="[^"]*(sync failed|failed to|error|sign in|loading)[^"]*"' "$OUT/7-offline-library.xml" 2>/dev/null | head -3 | tr '\n' ' ')"
      [[ -s "$OUT/7-offline-library.xml" ]] || lib_bad="no library screen dump"
      taps="$(for f in discover card get; do printf '%s:%s ' "$f" "$(head -1 "$OUT/7-offline-tap-$f.txt" 2>/dev/null)"; done)"
      saved=no; grep -qF 'Saved. It sends when Homebase is back.' "$OUT/7-offline-sheet.xml" 2>/dev/null && saved=yes
      disc="$(python3 "$WORK/uix.py" "$OUT/7-offline-discover.xml" "$PICK_TITLE" "$SHELVES")"
      attach || true
      r3="$(flush_wait "$PICK_TITLE")"
      cancelled="$(cancel_job "$PICK_TITLE")"
      printf 'setup %s\nlibrary-bad %s\ntaps %s\nsheet-saved %s\ndiscover %s\nflush %s\ncancel %s\n' \
        "$setup" "$lib_bad" "$taps" "$saved" "$disc" "$r3" "$cancelled" > "$OUT/7-offline.txt"
      if [[ -z "$lib_bad" && "$taps" == "discover:tapped"*"card:tapped"*"get:tapped"* && "$saved" == yes \
         && "$(jget "$disc" '!v.error && v.offlinePanel && v.cachedShown.length>0 && v.waitingListsIt')" == true \
         && "$(jget "$r3" 'v.queued === 0 && !v.rejected')" == true ]]; then
        record 7 PASS "offline library quiet; offline panel with cached shelves [$(jget "$disc" 'v.cachedShown.join(", ")')]; tapped Get ebook on \"$PICK_TITLE\" offline: saved and listed under Waiting to send, then flushed after reconnect (job shown: $(jget "$r3" 'v.job'); $cancelled; screens 7-offline-*.png)"
      else
        record 7 FAIL "library-bad [${lib_bad}] taps [$taps] sheet-saved=$saved discover $disc flush $r3"
      fi
    fi
  fi
fi

# --- summary -----------------------------------------------------------------
echo
echo "== household acceptance $STAMP  $SERIAL  $VERSION"
fails=0
for i in 1 2 3 4 5 6 7; do
  if [[ -n "${RESULT[$i]:-}" ]]; then
    printf '%-4s %s  %s\n' "${RESULT[$i]}" "$i" "${DETAIL[$i]}"
    [[ "${RESULT[$i]}" == FAIL ]] && fails=$((fails + 1))
  elif want "$i"; then
    printf '%-4s %s  %s\n' SKIP "$i" "not run"
  fi
done
echo "evidence: $OUT"
exit $(( fails > 0 ? 1 : 0 ))
