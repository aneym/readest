#!/usr/bin/env node
// Palma airplane-mode offline proof for the Readest fork's Homebase sync.
//
//   node scripts/homebase-offline-proof.mjs --serial <adb serial> --server <homebase base url>
//     --book <fileHash> [--out <dir>] [--listen readaloud|tts|skip] [--pages 12]
//   node scripts/homebase-offline-proof.mjs --self-test
//
// The device run reads and listens in airplane mode, kills the app, reboots,
// reconnects, and proves the offline position and highlight reach Homebase.
// Every observation goes to <out>/proof.jsonl; every judgment is made by the
// pure evaluateRun() below, which --self-test exercises against canned
// transcripts with no device attached. Usage notes and the palma.lock protocol
// are in scripts/homebase-offline-proof.md.
//
// Node 24+, built-ins only. CDP uses the global WebSocket.

import { execFile as execFileCb } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

export const PACKAGE = 'com.bilingify.readest';
export const LOCK_DIR = '/Volumes/StudioExt/repos/homebase-worktrees/_program/palma.lock';
export const DEFAULT_LOCK_OWNER = 'reader-sync';

/**
 * Null when this run may touch the Palma, else the refusal. The lock must
 * exist and name this run's lane: another lane's lock is a stop, not a pass.
 */
export function lockRefusal(ownerText, lockOwner) {
  if (ownerText == null) return `${LOCK_DIR}/owner does not exist. Take the lock first (see scripts/homebase-offline-proof.md).`;
  const owner = String(ownerText).trim();
  if (owner !== lockOwner) return `the Palma lock is held by "${owner || '(empty)'}", not "${lockOwner}". Wait for it to be released.`;
  return null;
}
const RUN_BUDGET_MS = 13 * 60_000; // the lock allows 15 min; restore's worst case is under 2
const DRAIN_TIMEOUT_MS = 120_000;
const LISTEN_PLAY_MS = 60_000;
const LISTEN_SCREEN_OFF_MS = 120_000;
const HARNESS_CLIENT_ID = 'offline-proof-harness';
const TAURI_APPDATA = 14; // @tauri-apps/api BaseDirectory.AppData
const DATA_PREFIX = 'Readest'; // src/services/constants.ts DATA_SUBDIR
const LISTEN_MODES = ['readaloud', 'tts', 'skip'];

// ---------------------------------------------------------------------------
// Pure: argument parsing
// ---------------------------------------------------------------------------

export class UsageError extends Error {}

export function parseArgs(argv) {
  const opts = { listen: 'readaloud', pages: 12, selfTest: false, skipLockCheck: false, lockOwner: DEFAULT_LOCK_OWNER };
  const takesValue = new Set(['--serial', '--server', '--book', '--out', '--listen', '--pages', '--lock-owner']);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--self-test') { opts.selfTest = true; continue; }
    if (arg === '--skip-lock-check') { opts.skipLockCheck = true; continue; }
    if (arg === '--help' || arg === '-h') { opts.help = true; continue; }
    if (!takesValue.has(arg)) throw new UsageError(`unknown argument: ${arg}`);
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} needs a value`);
    const key = arg === '--lock-owner' ? 'lockOwner' : arg.slice(2);
    opts[key] = value;
  }
  if (opts.help || opts.selfTest) return opts;
  for (const required of ['serial', 'server', 'book']) {
    if (!opts[required]) throw new UsageError(`--${required} is required`);
  }
  if (!/^https?:\/\/[^\s]+$/.test(opts.server)) throw new UsageError('--server must be an http(s) URL');
  opts.server = opts.server.replace(/\/+$/, '');
  if (!/^[A-Za-z0-9._-]+$/.test(opts.book)) throw new UsageError('--book must be a file hash');
  if (!LISTEN_MODES.includes(opts.listen)) throw new UsageError(`--listen must be one of ${LISTEN_MODES.join('|')}`);
  const pages = typeof opts.pages === 'number' ? opts.pages : Number(opts.pages);
  if (!Number.isInteger(pages) || pages < 1 || pages > 200) throw new UsageError('--pages must be an integer from 1 to 200');
  opts.pages = pages;
  opts.out ??= `offline-proof-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  opts.out = resolve(opts.out);
  return opts;
}

// ---------------------------------------------------------------------------
// Pure: redaction guard and jsonl writer
// ---------------------------------------------------------------------------

/** Every form a secret could take once serialized into a JSON line. */
function secretForms(secret) {
  const forms = new Set([secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]);
  return [...forms].filter((form) => form.length > 0);
}

/**
 * Returns true when `text` contains any registered secret. Empty secrets are
 * ignored so an unpaired device cannot make every line match.
 */
export function containsSecret(text, secrets) {
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length === 0) continue;
    for (const form of secretForms(secret)) if (text.includes(form)) return true;
  }
  return false;
}

/**
 * Append-only JSON-lines writer that refuses to write any line containing a
 * registered secret. A refused line is replaced by a `redaction_refused`
 * marker naming only the step and event, and the refusal is counted: a run
 * with any refusal fails `safety.no_token_leak`.
 */
export function createJsonlWriter(path, { now = () => new Date() } = {}) {
  const secrets = new Set();
  let refusals = 0;
  const guardText = (text) => !containsSecret(text, secrets);
  return {
    path,
    addSecret(secret) { if (typeof secret === 'string' && secret.length > 0) secrets.add(secret); },
    get refusals() { return refusals; },
    guardText,
    write(step, event, data = {}) {
      const line = JSON.stringify({ ts: now().toISOString(), step, event, ...data });
      if (!guardText(line)) {
        refusals++;
        const marker = JSON.stringify({ ts: now().toISOString(), step, event: 'redaction_refused', refusedEvent: String(event) });
        // The marker is built from harness-owned strings, but check it anyway.
        if (guardText(marker)) appendFileSync(path, `${marker}\n`);
        return false;
      }
      appendFileSync(path, `${line}\n`);
      return true;
    },
    /** Write a whole JSON file through the same guard. */
    writeJson(filePath, value) {
      const text = `${JSON.stringify(value, null, 2)}\n`;
      if (!guardText(text)) { refusals++; return false; }
      writeFileSync(filePath, text);
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// Pure: EPUB CFI ordering
// ---------------------------------------------------------------------------

/** Parse an epubcfi() into a comparable integer path; ranges use their start. */
export function parseCfi(cfi) {
  if (typeof cfi !== 'string') return null;
  const match = cfi.trim().match(/^epubcfi\((.*)\)$/s);
  if (!match) return null;
  // Drop id assertions ([...], with ^ escapes), then spatial/temporal offsets.
  let body = match[1].replace(/\[(?:\^.|[^\]])*\]/g, '').replace(/[~@][0-9.:]+/g, '');
  const parts = body.split(',');
  if (parts.length === 3) body = parts[0] + parts[1];
  else if (parts.length !== 1) return null;
  const nums = body.split(/[/!:]/).filter((s) => s !== '');
  if (nums.length === 0 || !nums.every((s) => /^\d+$/.test(s))) return null;
  return nums.map(Number);
}

/** -1, 0 or 1; null when either side is not a parseable CFI. */
export function compareCfi(a, b) {
  const pa = parseCfi(a);
  const pb = parseCfi(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return pa.length === pb.length ? 0 : pa.length < pb.length ? -1 : 1;
}

// ---------------------------------------------------------------------------
// Pure: page-side helpers. Each is self-contained so its source can be
// embedded into a CDP snippet with Function.prototype.toString and still be
// exercised directly by --self-test.
// ---------------------------------------------------------------------------

/**
 * Text out of a raw `plugin:fs|read_text_file` invoke. The installed
 * @tauri-apps/plugin-fs (2.5.1) returns bytes (ArrayBuffer or a number array)
 * and decodes them in its JS wrapper; older plugin builds and the app's own
 * `readFile(..., 'text')` hand back a string. Accept every shape and refuse
 * anything else rather than decoding garbage.
 */
export function decodeFsText(value) {
  if (typeof value === 'string') return value;
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) return new TextDecoder().decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  if (Array.isArray(value) && value.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) return new TextDecoder().decode(Uint8Array.from(value));
  throw new TypeError(`unexpected read_text_file result: ${value === null ? 'null' : Array.isArray(value) ? 'non-byte array' : typeof value}`);
}

/** Same "file is missing" test the fork's createTauriOutboxFs uses. */
export const MISSING_FILE_RE = /not found|no such file|ENOENT|os error [23]|cannot find the path/i;

/** Marker on every harness-issued device fetch, so resource timing can skip them. */
export const PROBE_MARKER = 'offline-proof-probe';

/**
 * Homebase base URLs the app itself requested, from resource-timing entry
 * names. Harness probes carry PROBE_MARKER and are skipped, so the harness
 * can never confirm its own --server.
 */
export function baseUrlsFromResources(names, syncPath = '/reader/sync', marker = 'offline-proof-probe') {
  const found = new Set();
  for (const name of names ?? []) {
    if (typeof name !== 'string' || name.includes(marker)) continue;
    const at = name.indexOf(`${syncPath}`);
    if (at <= 0) continue;
    const rest = name.slice(at + syncPath.length);
    if (rest !== '' && !/^[/?#]/.test(rest)) continue;
    const base = name.slice(0, at).replace(/\/+$/, '');
    if (/^https?:\/\/[^\s]+$/.test(base)) found.add(base);
  }
  return [...found];
}

/**
 * Base URL literals the bundler inlined next to `homebaseApiBaseUrl`
 * (getHomebaseBaseUrl reads runtime config, then the NEXT_PUBLIC_ value).
 */
export function extractBundleBaseUrls(text) {
  const found = new Set();
  if (typeof text !== 'string') return [];
  const re = /homebaseApiBaseUrl/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const lit = text.slice(m.index, m.index + 400).match(/["'`](https?:\/\/[^"'`\s]+)["'`]/);
    if (lit) found.add(lit[1].replace(/\/+$/, ''));
  }
  return [...found];
}

/**
 * Settle the device's sync target from every source that reported one. It
 * resolves only when at least one source reported and all of them agree.
 */
export function resolveDeviceBaseUrl(candidates) {
  const list = (candidates ?? []).filter((c) => c && typeof c.url === 'string' && c.url.length > 0)
    .map((c) => ({ source: c.source, url: c.url.replace(/\/+$/, '') }));
  const distinct = [...new Set(list.map((c) => c.url))];
  const sources = [...new Set(list.map((c) => c.source))];
  if (distinct.length === 1) return { baseUrl: distinct[0], sources, conflict: null };
  return { baseUrl: null, sources, conflict: distinct.length > 1 ? distinct : null };
}

// ---------------------------------------------------------------------------
// Pure: server readback diff
// ---------------------------------------------------------------------------

const bookHashOf = (rec) => rec?.book_hash ?? rec?.bookHash ?? rec?.hash ?? null;
const isDeleted = (rec) => Boolean(rec?.deleted_at ?? rec?.deletedAt);

/** Server receipt time in ms: `synced_at` (ISO or ms), else `updated_at_ms`. */
export function receiptMs(rec) {
  const raw = rec?.synced_at ?? rec?.updated_at_ms ?? null;
  if (raw == null) return null;
  const ms = typeof raw === 'number' ? raw : Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

export function maxReceiptMs(rows) {
  let max = 0;
  for (const row of rows ?? []) max = Math.max(max, receiptMs(row) ?? 0);
  return max;
}

/** Pick a queued outbox entry's identity out of its record. */
export function summarizeOutboxEntry(entry) {
  const rec = entry?.record ?? {};
  return {
    key: entry?.key ?? null,
    channel: entry?.channel ?? null,
    bookHash: bookHashOf(rec),
    id: rec.id ?? null,
    deleted: isDeleted(rec),
    poisoned: Boolean(entry?.poisoned),
  };
}

/**
 * The server-side identity a queued row lands on: one config and one book
 * row per book hash, one note row per note id.
 */
export function rowIdentity(channel, bookHash, id) {
  if (!bookHash) return null;
  if (channel === 'notes') return id ? `notes:${bookHash}:${id}` : null;
  if (channel === 'configs' || channel === 'books') return `${channel}:${bookHash}`;
  return null;
}

/**
 * Receipts per row identity from one server read ({ configs, notes, books }).
 * Used for the pre-drain snapshot: a row counts as delivered only when its
 * receipt moved past what the server held while the device was still offline.
 */
export function receiptIndex(server) {
  const index = new Map();
  for (const channel of ['configs', 'notes', 'books']) {
    for (const row of server?.[channel] ?? []) {
      const identity = rowIdentity(channel, bookHashOf(row), row?.id ?? null);
      if (identity) index.set(identity, Math.max(index.get(identity) ?? 0, receiptMs(row) ?? 0));
    }
  }
  return index;
}

/** Channels the server stores but GET cannot return (type=stats answers empty by contract). */
const ACK_ONLY_CHANNELS = new Set(['statBooks', 'statPages']);

/**
 * Compare what the device queued offline with what the server now holds.
 * `server` is { configs, notes, books } rows for every book hash involved.
 * `preDrain` is the same read taken from the host while the device was still
 * in airplane mode, just before the drain, plus the `hashes` it covered.
 * `afterDrain` is the device outbox read after the drain (null if unread).
 * A configs, notes or books row counts only when the server row for that
 * identity exists, has a receipt, and that receipt is newer than the pre-drain
 * snapshot's (or the identity did not exist before the drain). A row that was
 * already on the server and did not change is stale, not proof. statBooks and
 * statPages have no readback, so they count as present only when the
 * post-drain outbox no longer holds them, which the outbox does only after a
 * 2xx ack of that exact revision. Any other channel is missing: the harness
 * cannot prove it arrived.
 */
export function diffServerReadback({ baseline, offline, queued, afterDrain, server, preDrain }) {
  const checks = [];
  const add = (id, pass, detail) => checks.push({ id, status: pass ? 'PASS' : 'FAIL', detail });
  if (!server?.ok) {
    for (const id of ['server.location_matches', 'server.highlight_present', 'server.highlight_receipt_advanced', 'server.queued_all_present']) {
      add(id, false, server ? `server readback failed: ${server.error ?? 'unknown error'}` : 'not reached');
    }
    return checks;
  }
  const configs = server.configs ?? [];
  const notes = server.notes ?? [];
  const books = server.books ?? [];

  const config = configs.find((row) => bookHashOf(row) === offline?.bookHash);
  const location = config?.location ?? null;
  add('server.location_matches', Boolean(offline?.cfi) && location === offline.cfi,
    `server location ${location ?? 'missing'}; offline CFI ${offline?.cfi ?? 'missing'}`);

  const note = notes.find((row) => row.id === offline?.highlightId && bookHashOf(row) === offline?.bookHash);
  add('server.highlight_present', Boolean(note) && !isDeleted(note),
    note ? (isDeleted(note) ? `highlight ${note.id} is deleted on the server` : `highlight ${note.id} present`) : `highlight ${offline?.highlightId ?? '(none)'} missing`);

  const noteReceipt = note ? receiptMs(note) : null;
  const baseReceipt = baseline?.maxReceiptMs ?? null;
  add('server.highlight_receipt_advanced', noteReceipt != null && baseReceipt != null && noteReceipt > baseReceipt,
    `highlight receipt ${noteReceipt ?? 'missing'}; baseline max receipt ${baseReceipt ?? 'missing'}`);

  const stillQueued = new Set(Array.isArray(afterDrain) ? afterDrain.map((e) => e?.key) : []);
  const before = preDrain?.ok === true ? receiptIndex(preDrain) : null;
  const beforeHashes = new Set(preDrain?.hashes ?? []);
  const after = receiptIndex(server);
  const missing = [];
  let ackOnly = 0;
  for (const entry of queued ?? []) {
    if (entry.poisoned) { missing.push(`${entry.key} (poisoned on device)`); continue; }
    if (entry.channel === 'notes' || entry.channel === 'configs' || entry.channel === 'books') {
      const identity = rowIdentity(entry.channel, entry.bookHash, entry.id);
      const rows = entry.channel === 'notes' ? notes : entry.channel === 'configs' ? configs : books;
      const row = identity && rows.find((r) => rowIdentity(entry.channel, bookHashOf(r), r?.id ?? null) === identity);
      const wantDeleted = entry.channel === 'notes' && entry.deleted === true;
      if (!identity) missing.push(`${entry.key} (no row identity)`);
      else if (!row) missing.push(entry.key);
      else if (entry.channel === 'notes' && isDeleted(row) !== wantDeleted) missing.push(`${entry.key} (server row ${isDeleted(row) ? 'is deleted' : 'is not deleted'})`);
      else if (!before) missing.push(`${entry.key} (no pre-drain server snapshot to prove the row changed)`);
      else if (!beforeHashes.has(entry.bookHash)) missing.push(`${entry.key} (book not in the pre-drain snapshot)`);
      else {
        const was = before.get(identity) ?? null;
        const now = after.get(identity) || null;
        if (now == null) missing.push(`${entry.key} (server row has no receipt)`);
        else if (was != null && now <= was) missing.push(`${entry.key} (unchanged since before the drain, receipt ${new Date(now).toISOString()})`);
      }
    } else if (ACK_ONLY_CHANNELS.has(entry.channel)) {
      if (!Array.isArray(afterDrain)) missing.push(`${entry.key} (no post-drain outbox to prove the ack)`);
      else if (stillQueued.has(entry.key)) missing.push(`${entry.key} (still queued after the drain)`);
      else ackOnly++;
    } else {
      missing.push(`${entry.key} (channel ${entry.channel ?? 'unknown'} has no readback)`);
    }
  }
  const queuedCount = (queued ?? []).length;
  const ackNote = ackOnly ? `; ${ackOnly} stats row(s) proven by ack only (server GET returns no stats)` : '';
  add('server.queued_all_present', Array.isArray(queued) && queuedCount >= 1 && missing.length === 0,
    queuedCount === 0 ? 'no queued rows were captured before the drain' :
      missing.length ? `missing: ${missing.join(', ')}` : `${queuedCount} queued rows present and newer than the pre-drain snapshot${ackNote}`);
  return checks;
}

// ---------------------------------------------------------------------------
// Pure: assertion engine
// ---------------------------------------------------------------------------

const norm = (url) => (typeof url === 'string' ? url.replace(/\/+$/, '') : url);

/**
 * Judge a run from its observations. Missing observations mean the step was
 * never reached, which fails its checks. Returns { verdict, checks }.
 */
export function evaluateRun(obs, { listen = 'readaloud', drainTimeoutMs = DRAIN_TIMEOUT_MS } = {}) {
  const checks = [];
  const add = (id, pass, detail) => checks.push({ id, status: pass ? 'PASS' : 'FAIL', detail });
  const skip = (id, detail) => checks.push({ id, status: 'SKIP', detail });
  const nr = 'not reached';

  const p = obs.preflight ?? {};
  add('preflight.adb_state', p.adbState === 'device', `adb get-state: ${p.adbState ?? nr}`);
  add('preflight.usb_serial', typeof p.serial === 'string' && !p.serial.includes(':'),
    p.serial ? (p.serial.includes(':') ? `${p.serial} is a network serial; airplane mode would drop it` : `${p.serial} (USB)`) : nr);
  add('preflight.app_installed', p.packageInstalled === true, p.packageInstalled == null ? nr : `${PACKAGE} installed: ${p.packageInstalled}`);
  add('preflight.cdp', p.cdpConnected === true, p.cdpConnected == null ? nr : p.cdpDetail ?? `connected: ${p.cdpConnected}`);
  add('preflight.paired', p.tokenPresent === true && p.clientIdPresent === true,
    p.tokenPresent == null ? nr : `token present: ${p.tokenPresent}; client id present: ${p.clientIdPresent}`);
  // --server must be proven to be the device's own sync target; an unknown
  // device base URL fails rather than trusting the argument.
  const deviceBase = norm(p.deviceBaseUrl ?? null);
  const baseSources = (p.deviceBaseSources ?? []).join(', ') || 'none';
  add('preflight.base_url', Boolean(p.serverArg) && deviceBase != null && deviceBase === norm(p.serverArg),
    !p.serverArg ? nr
      : deviceBase != null ? `device ${deviceBase} (from ${baseSources}); --server ${norm(p.serverArg)}`
        : p.deviceBaseConflict ? `device sources disagree: ${p.deviceBaseConflict.join(' vs ')}; --server ${norm(p.serverArg)}`
          : `device base URL not found (runtime config, resource timing and bundle all empty); cannot confirm --server ${norm(p.serverArg)}`);
  add('preflight.device_route', p.deviceRouteOk === true, p.deviceRouteOk == null ? nr : `device reached server: ${p.deviceRouteOk}`);

  const b = obs.baseline;
  add('baseline.server_readable', b?.ok === true, b ? (b.ok ? `location ${b.location ?? 'none'}; ${b.noteIds?.length ?? 0} notes; max receipt ${b.maxReceiptMs}` : `failed: ${b.error}`) : nr);

  const a = obs.airplane;
  add('airplane.enabled', a?.enabled === true, a ? `airplane_mode_on: ${a.enabled}` : nr);
  add('airplane.no_route', a?.fetchFailed === true, a ? (a.fetchFailed ? 'device fetch to server failed' : 'device still reached the server') : nr);

  const r = obs.read;
  add('read.opened', r?.opened === true, r ? `opened via ${r.via ?? 'unknown'}` : nr);
  add('read.pages_turned', compareCfi(r?.endCfi, r?.startCfi) === 1, r ? `${r.startCfi ?? 'none'} -> ${r.endCfi ?? 'none'} after ${r.pagesTurned ?? 0} pages` : nr);

  const an = obs.annotate;
  const highlightId = an?.highlightId ?? null;
  const baselineIds = new Set(b?.noteIds ?? []);
  add('annotate.highlight_created', typeof highlightId === 'string' && highlightId.length > 0 && !baselineIds.has(highlightId),
    an ? (highlightId ? `highlight ${highlightId} via ${an.mode}` : `no highlight: ${an.error ?? 'unknown'}`) : nr);

  // The advance that counts is the one made while the screen was off:
  // screenOffCfi is read right before the power key, afterCfi right after wake.
  const l = obs.listen;
  if (listen === 'skip') {
    for (const id of ['listen.started', 'listen.screen_off', 'listen.cfi_advanced_screen_off']) skip(id, '--listen skip');
  } else {
    add('listen.started', l?.started === true, l ? `mode ${l.mode}; started: ${l.started}` : nr);
    add('listen.screen_off', l?.screenOff === true, l ? `screen went off for the locked phase: ${l.screenOff ?? 'unknown'}` : nr);
    add('listen.cfi_advanced_screen_off', compareCfi(l?.afterCfi, l?.screenOffCfi) === 1,
      l ? `${l.screenOffCfi ?? 'none'} at screen off -> ${l.afterCfi ?? 'none'} after wake (before play ${l.beforeCfi ?? 'none'})` : nr);
  }

  const offlineCfi = obs.offline?.cfi ?? null;
  add('offline.cfi_recorded', typeof offlineCfi === 'string' && parseCfi(offlineCfi) !== null, obs.offline ? `persisted offline CFI ${offlineCfi ?? 'none'}` : nr);
  add('offline.cfi_matches_live', compareCfi(offlineCfi, obs.offline?.liveCfi) === 0,
    obs.offline ? `persisted ${offlineCfi ?? 'none'}; live reader ${obs.offline.liveCfi ?? 'none'}` : nr);
  // The persisted position must not sit behind the last position observed
  // (post-listen, or end of reading when listen is skipped).
  const lastSeen = listen === 'skip' ? r?.endCfi ?? null : l?.afterCfi ?? null;
  const vsLast = compareCfi(offlineCfi, lastSeen);
  add('offline.cfi_not_behind_last_observed', vsLast === 0 || vsLast === 1,
    obs.offline ? `persisted ${offlineCfi ?? 'none'}; last observed ${lastSeen ?? 'none'} (${listen === 'skip' ? 'end of reading' : 'after wake'})` : nr);

  for (const phase of ['kill', 'reboot']) {
    const s = obs[phase];
    if (phase === 'reboot') {
      add('reboot.boot_completed', s?.bootCompleted === true, s ? `sys.boot_completed: ${s.bootCompleted}` : nr);
      add('reboot.airplane_still_on', s?.airplaneOn === true, s ? `airplane_mode_on after boot: ${s.airplaneOn}` : nr);
    }
    add(`${phase}.cfi_persisted`, Boolean(offlineCfi) && s?.cfi === offlineCfi, s ? `persisted ${s.cfi ?? 'none'}; offline ${offlineCfi ?? 'none'}` : nr);
    add(`${phase}.highlight_persisted`, Boolean(highlightId) && (s?.noteIds ?? []).includes(highlightId), s ? `${(s.noteIds ?? []).length} local notes; highlight ${highlightId ?? 'none'}` : nr);
    add(`${phase}.pending_nonzero`, typeof s?.pending === 'number' && s.pending >= 1, s ? `pending ${s.pending ?? 'unknown'} (source ${s.pendingSource ?? 'none'})` : nr);
    // Every row queued before the kill must still be queued after the kill and
    // after the reboot: a row lost in either step never reaches the drain.
    const preKill = Array.isArray(obs.offline?.queuedKeys) ? obs.offline.queuedKeys : null;
    const keys = Array.isArray(s?.queuedKeys) ? s.queuedKeys : null;
    const lost = preKill && keys ? preKill.filter((k) => !keys.includes(k)) : null;
    add(`${phase}.queue_intact`, preKill !== null && preKill.length >= 1 && lost !== null && lost.length === 0,
      !s ? nr : preKill === null ? 'no outbox snapshot before the kill'
        : preKill.length === 0 ? 'outbox was empty before the kill'
          : keys === null ? `outbox not readable after ${phase}`
            : lost.length ? `lost during ${phase}: ${lost.join(', ')}` : `${preKill.length} rows queued before the kill still queued`);
  }

  const d = obs.drain;
  const drained = (d?.samples ?? []).find((sample) => sample.pending === 0 && sample.t <= drainTimeoutMs);
  add('drain.pending_zero', Boolean(drained), d ? (drained ? `pending 0 after ${Math.round(drained.t / 1000)} s` : `pending never reached 0 within ${drainTimeoutMs / 1000} s (last ${d.samples?.at(-1)?.pending ?? 'unknown'})`) : nr);
  const afterDrain = obs.afterDrain;
  const leftover = Array.isArray(afterDrain) ? (obs.queued ?? []).filter((q) => afterDrain.some((e) => e?.key === q.key)).map((q) => q.key) : null;
  add('drain.queued_all_acked', Array.isArray(obs.queued) && obs.queued.length >= 1 && leftover !== null && leftover.length === 0,
    !Array.isArray(obs.queued) ? nr : leftover === null ? 'post-drain outbox not read' :
      leftover.length ? `still queued after the drain: ${leftover.join(', ')}` : `${obs.queued.length} queued rows left the outbox`);

  checks.push(...diffServerReadback({
    baseline: b,
    offline: { cfi: offlineCfi, highlightId, bookHash: obs.book ?? null },
    queued: obs.queued,
    afterDrain,
    server: obs.server,
    preDrain: obs.preDrain,
  }));

  const rs = obs.restore;
  add('restore.airplane_off', rs?.airplaneOff === true, rs ? `airplane off: ${rs.airplaneOff}` : nr);
  add('restore.screen_on', rs?.screenOn === true, rs ? `screen on: ${rs.screenOn}` : nr);

  const run = obs.run;
  add('run.within_budget', run?.budgetExhausted === false,
    run ? (run.budgetExhausted ? `run budget ran out during ${run.stoppedAt ?? 'a step'}; the step was aborted and the device restored` : 'every step finished inside the run budget') : nr);
  add('run.steps_completed', run != null && run.stoppedAt == null,
    run ? (run.stoppedAt == null ? `${run.completed?.length ?? 0} steps completed` : `stopped at ${run.stoppedAt}: ${run.error ?? 'unknown'}`) : nr);

  const refusals = obs.safety?.redactionRefusals ?? 0;
  add('safety.no_token_leak', refusals === 0, refusals === 0 ? 'no line carried the device token' : `${refusals} line(s) refused because they carried the device token`);

  // PASS means every check ran and passed. Any SKIP (for example --listen skip)
  // makes the run PARTIAL: useful evidence, but not the full acceptance proof.
  const verdict = checks.some((c) => c.status === 'FAIL') ? 'FAIL'
    : checks.some((c) => c.status === 'SKIP') ? 'PARTIAL' : 'PASS';
  return { verdict, checks };
}

// ---------------------------------------------------------------------------
// Run orchestration: step runner under one deadline, restore, summary. No
// device code here, so --self-test drives it with fake steps.
// ---------------------------------------------------------------------------

export class BudgetExceeded extends Error {}

/**
 * Run steps in order under one deadline. The deadline is enforced inside a
 * step, not only between steps: a step still running when it passes is
 * abandoned, `abort()` fires so its device calls stop, and the loop ends.
 * A step that throws also ends the loop. Never throws; returns the outcome.
 */
export async function runSteps(steps, { deadline, now = Date.now, record = () => {}, say = () => {}, abort = () => {} }) {
  const outcome = { budgetExhausted: false, stoppedAt: null, error: null, completed: [] };
  for (const [name, fn] of steps) {
    const remaining = deadline - now();
    if (remaining <= 0) {
      outcome.budgetExhausted = true; outcome.stoppedAt = name; outcome.error = 'run budget exhausted before the step started';
      record(name, 'budget_exhausted', { when: 'before start' });
      say(`  run budget exhausted before ${name}`);
      try { abort(); } catch { /* best effort */ }
      break;
    }
    record(name, 'start', {});
    say(`[${new Date().toISOString()}] ${name}`);
    let timer;
    const overBudget = new Promise((_, reject) => { timer = setTimeout(() => reject(new BudgetExceeded(`run budget exhausted during ${name}`)), remaining); });
    const work = Promise.resolve().then(fn);
    work.catch(() => { /* an abandoned step's late rejection is expected */ });
    try {
      await Promise.race([work, overBudget]);
      outcome.completed.push(name);
    } catch (e) {
      const message = String(e?.message ?? e);
      outcome.stoppedAt = name; outcome.error = message;
      if (e instanceof BudgetExceeded) {
        outcome.budgetExhausted = true;
        try { abort(); } catch { /* best effort */ }
        record(name, 'budget_exhausted', { when: 'mid-step' });
      } else {
        record(name, 'step_error', { error: message });
      }
      say(`  ${name} failed: ${message}`);
      break;
    } finally { clearTimeout(timer); }
  }
  return outcome;
}

/** A jsonl record call that can never throw into the run. */
function safeRecorder(log) {
  return (step, event, data) => { try { return log.write(step, event, data); } catch (e) { console.error(`proof.jsonl write failed: ${e?.message ?? e}`); return false; } };
}

/**
 * Judge the run and write <out>/summary.json through the redaction guard.
 * A summary that cannot be written, or is refused, fails the verdict.
 */
export function finishRun({ obs, log, out, listen, meta = {} }) {
  const result = evaluateRun(obs, { listen });
  let written = false;
  try { written = log.writeJson(join(out, 'summary.json'), { ...result, ...meta, finishedAt: new Date().toISOString() }); }
  catch (e) { result.summaryError = String(e?.message ?? e); }
  if (!written) result.verdict = 'FAIL';
  result.summaryWritten = written;
  safeRecorder(log)('summary', 'verdict', { verdict: result.verdict, summaryWritten: written });
  return result;
}

/**
 * Steps, then restore, then summary, whatever happens in between: a step
 * error, the budget running out mid-step, or restore itself throwing.
 */
export async function executeRun({ steps, restore, deadline, abort, log, obs, out, listen, meta, say = () => {}, now = Date.now }) {
  const record = safeRecorder(log);
  let outcome;
  try { outcome = await runSteps(steps, { deadline, now, record, say, abort }); }
  catch (e) { outcome = { budgetExhausted: false, stoppedAt: 'runner', error: String(e?.message ?? e), completed: [] }; }
  obs.run = outcome;
  record('run', 'outcome', outcome);
  try { obs.restore = await restore(); }
  catch (e) { obs.restore = { airplaneOff: false, screenOn: false, error: String(e?.message ?? e) }; }
  record('restore', 'observed', obs.restore);
  obs.safety = { redactionRefusals: log.refusals };
  return finishRun({ obs, log, out, listen, meta });
}

// ---------------------------------------------------------------------------
// Device: adb
// ---------------------------------------------------------------------------

// Every device helper takes an optional AbortSignal. When the run budget
// runs out mid-step, the runner aborts it: child adb processes are killed and
// sleeps and polls reject, so an abandoned step cannot keep driving the Palma
// while restore runs.
const abortedError = () => new Error('run aborted');

async function adb(serial, args, { timeoutMs = 60_000, encoding = 'utf8', signal } = {}) {
  if (signal?.aborted) throw abortedError();
  const { stdout } = await execFile('adb', ['-s', serial, ...args], { timeout: timeoutMs, encoding, maxBuffer: 64 * 1024 * 1024, signal });
  return encoding === 'buffer' ? stdout : stdout.trim();
}
const shell = (serial, cmd, opts) => adb(serial, ['shell', cmd], opts);
export function sleep(ms, signal) {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) { reject(abortedError()); return; }
    const onAbort = () => { clearTimeout(timer); reject(abortedError()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolvePromise(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function waitFor(fn, { timeoutMs, intervalMs = 1000, label, signal }) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    if (signal?.aborted) throw abortedError();
    try { last = await fn(); if (last) return last; } catch { /* keep polling */ }
    await sleep(intervalMs, signal);
  }
  throw new Error(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${label}`);
}

// ---------------------------------------------------------------------------
// Device: CDP over adb forward
// ---------------------------------------------------------------------------

class Cdp {
  #ws; #nextId = 1; #pending = new Map();
  static connect(url, timeoutMs = 10_000) {
    return new Promise((resolvePromise, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => { ws.close(); reject(new Error('CDP connect timeout')); }, timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(timer); resolvePromise(new Cdp(ws)); });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP socket error')); });
    });
  }
  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
      const waiter = msg.id && this.#pending.get(msg.id);
      if (!waiter) return;
      this.#pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(`CDP ${msg.error.message}`)); else waiter.resolve(msg.result);
    });
    ws.addEventListener('close', () => {
      for (const w of this.#pending.values()) w.reject(new Error('CDP socket closed'));
      this.#pending.clear();
    });
  }
  send(method, params = {}, timeoutMs = 30_000) {
    // A closed socket drops sends silently; fail fast instead of timing out.
    if (this.#ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP socket closed'));
    const id = this.#nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error(`CDP ${method} timeout`)); }, timeoutMs);
      this.#pending.set(id, { resolve: (v) => { clearTimeout(timer); resolvePromise(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression, timeoutMs = 30_000) {
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
    if (res.exceptionDetails) throw new Error(`page threw: ${res.exceptionDetails.exception?.description?.split('\n')[0] ?? res.exceptionDetails.text}`);
    return res.result?.value;
  }
  async key(key, code, keyCode, text) {
    const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
    await this.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text } : {}) });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }
  close() { try { this.#ws.close(); } catch { /* already closed */ } }
}

async function connectCdp(serial, port, signal) {
  const pid = await waitFor(async () => (await shell(serial, `pidof ${PACKAGE}`, { signal })).split(/\s+/)[0] || null, { timeoutMs: 30_000, label: 'app process', signal });
  const socket = `webview_devtools_remote_${pid}`;
  await waitFor(async () => (await shell(serial, 'cat /proc/net/unix', { signal })).includes(`@${socket}`), { timeoutMs: 30_000, label: `WebView devtools socket ${socket} (is WebView debugging enabled in this build?)`, signal });
  await adb(serial, ['forward', `tcp:${port}`, `localabstract:${socket}`], { signal });
  const target = await waitFor(async () => {
    const list = await (await fetch(`http://127.0.0.1:${port}/json`, { signal })).json();
    return list.find((t) => t.type === 'page' && /tauri\.localhost|^https?:\/\/localhost/.test(t.url)) ?? list.find((t) => t.type === 'page');
  }, { timeoutMs: 20_000, label: 'WebView page target', signal });
  if (signal?.aborted) throw abortedError();
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  return { cdp, pid, detail: `pid ${pid}; page ${target.url.split('?')[0]}` };
}

// Page-side snippets. None of them returns the token except readToken.
// Pure helpers above are embedded by source so the page runs the same code
// --self-test checks.
const readTextSnippet = (pathExpr) => `(async () => { const inv = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
      if (!inv) return { ok: false, missing: false, error: 'no tauri invoke' };
      try { const raw = await inv('plugin:fs|read_text_file', { path: ${pathExpr}, options: { baseDir: ${TAURI_APPDATA} } });
        return { ok: true, text: (${decodeFsText.toString()})(raw) }; }
      catch (e) { return { ok: false, missing: ${MISSING_FILE_RE.toString()}.test(String(e)), error: String(e) }; } })()`;

export const js = {
  readToken: `localStorage.getItem('token') ?? ''`,
  clientId: `Boolean(localStorage.getItem('readest-homebase-client-id'))`,
  // Every source of the app's own Homebase base URL. Must run before any
  // harness fetch; harness fetches also carry PROBE_MARKER.
  baseUrlCandidates: `(async () => {
    const out = [];
    const rc = window.__READEST_RUNTIME_CONFIG && window.__READEST_RUNTIME_CONFIG.homebaseApiBaseUrl;
    if (rc) out.push({ source: 'runtime-config', url: String(rc) });
    const names = (performance.getEntriesByType('resource') || []).map((e) => e.name);
    for (const url of (${baseUrlsFromResources.toString()})(names, '/reader/sync', ${JSON.stringify(PROBE_MARKER)})) out.push({ source: 'resource-timing', url });
    const scripts = [...new Set([...document.scripts].map((s) => s.src).concat((performance.getEntriesByType('resource') || []).filter((e) => e.initiatorType === 'script' || /\\.js(\\?|$)/.test(e.name)).map((e) => e.name)).filter((u) => u && u.startsWith(location.origin)))].slice(0, 120);
    const extract = ${extractBundleBaseUrls.toString()};
    for (const src of scripts) { try { const text = await (await fetch(src)).text(); if (text.includes('homebaseApiBaseUrl')) for (const url of extract(text)) out.push({ source: 'bundle', url }); } catch {} }
    return out; })()`,
  routeProbe: (url) => `(async () => { const c = new AbortController(); const t = setTimeout(() => c.abort(), 8000);
    try { const r = await fetch(${JSON.stringify(`${url}${url.includes('?') ? '&' : '?'}${PROBE_MARKER}=1`)}, { signal: c.signal, cache: 'no-store' }); return { reached: true, status: r.status }; }
    catch (e) { return { reached: false, error: String(e && e.name || e) }; } finally { clearTimeout(t); } })()`,
  liveCfi: `(() => { const v = document.querySelector('foliate-view'); return v && v.lastLocation ? v.lastLocation.cfi ?? null : null; })()`,
  readFile: (path) => readTextSnippet(JSON.stringify(path)),
  hasMediaOverlay: `(() => { const v = document.querySelector('foliate-view'); const bk = v && v.book;
    return Boolean(bk && ((bk.sections || []).some((s) => s.mediaOverlay) || (bk.media && bk.media.duration))); })()`,
  listenState: `(() => { const ms = navigator.mediaSession && navigator.mediaSession.playbackState;
    const pause = [...document.querySelectorAll('button[aria-label]')].some((b) => /pause/i.test(b.getAttribute('aria-label')));
    return { mediaSession: ms || null, pauseButton: pause }; })()`,
  clickReadaloud: `(() => { const b = [...document.querySelectorAll('button[aria-label]')].find((x) => /read ?aloud|listen|play audio/i.test(x.getAttribute('aria-label')));
    if (!b) return false; b.click(); return true; })()`,
  selectText: `(() => { const v = document.querySelector('foliate-view'); const contents = v && v.renderer && v.renderer.getContents ? v.renderer.getContents() : [];
    for (const { doc } of contents) { if (!doc || !doc.body) continue;
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) { const text = n.textContent || ''; const m = text.match(/\\S+(\\s+\\S+){3}/);
        if (!m) continue; const range = doc.createRange(); range.setStart(n, m.index); range.setEnd(n, m.index + m[0].length);
        const rect = range.getBoundingClientRect(); if (!rect.width || !rect.height) continue;
        const sel = doc.getSelection(); sel.removeAllRanges(); sel.addRange(range);
        const opts = { bubbles: true, cancelable: true, clientX: rect.right - 1, clientY: rect.bottom - 1, pointerType: 'touch' };
        doc.dispatchEvent(new Event('selectionchange'));
        for (const type of ['pointerup', 'mouseup', 'touchend']) { try { (type === 'pointerup' ? n.parentElement.dispatchEvent(new PointerEvent(type, opts)) : n.parentElement.dispatchEvent(new MouseEvent(type, opts))); } catch {} }
        return { selected: true, text: m[0].length }; } }
    return { selected: false }; })()`,
  clickHighlight: `(() => { const b = document.querySelector('button[aria-label="Highlight"]'); if (!b || b.disabled) return false; b.click(); return true; })()`,
  // The durable outbox as the app reads it: Readest/homebase/outbox.json
  // under AppData, plus any legacy localStorage rows not yet migrated. A file
  // that exists but cannot be read or parsed yields pending null (a FAIL),
  // never an empty queue.
  pendingProbe: `(async () => {
    const summarize = (entries) => entries.map((e) => { const r = (e && e.record) || {}; return { key: e && e.key, channel: e && e.channel, bookHash: r.book_hash ?? r.bookHash ?? r.hash ?? null, id: r.id ?? null, deleted: Boolean(r.deleted_at ?? r.deletedAt), poisoned: Boolean(e && e.poisoned) }; });
    const store = window.__homebaseSyncStatus && window.__homebaseSyncStatus.getState && window.__homebaseSyncStatus.getState();
    const sources = []; let broken = null; const byKey = new Map();
    const file = await ${readTextSnippet(`'${DATA_PREFIX}/homebase/outbox.json'`)};
    if (file.ok) { try { const parsed = JSON.parse(file.text); if (!Array.isArray(parsed)) throw new Error('not an array'); for (const e of parsed) byKey.set(e.key, e); sources.push('outbox-file'); } catch (e) { broken = 'outbox-file unparseable: ' + String(e && e.message || e); } }
    else if (!file.missing) broken = 'outbox-file unreadable: ' + file.error;
    const raw = localStorage.getItem('readest-homebase-outbox');
    if (raw) { try { const parsed = JSON.parse(raw); if (!Array.isArray(parsed)) throw new Error('not an array'); for (const e of parsed) if (!byKey.has(e.key)) byKey.set(e.key, e); sources.push('outbox-localStorage'); } catch (e) { broken = broken || 'legacy outbox unparseable'; } }
    const list = broken ? null : summarize([...byKey.values()]);
    if (store && typeof store.pending === 'number') return { source: 'useHomebaseSyncStatus', pending: store.pending, entries: list, error: broken };
    return { source: broken ? 'outbox-error' : (sources.join('+') || 'outbox-empty'), pending: list ? list.filter((e) => !e.poisoned).length : null, entries: list, error: broken };
  })()`,
};

// ---------------------------------------------------------------------------
// Device run
// ---------------------------------------------------------------------------

async function readLine(prompt, timeoutMs, signal) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // Cancel the timeout once answered so its timer does not hold the process open.
  const answered = new AbortController();
  const stop = signal ? AbortSignal.any([signal, answered.signal]) : answered.signal;
  try {
    return await Promise.race([
      new Promise((r) => rl.question(prompt, r)),
      sleep(timeoutMs, stop).then(() => null, () => null),
    ]);
  } finally { answered.abort(); rl.close(); }
}

async function runDevice(opts) {
  mkdirSync(opts.out, { recursive: true });
  const log = createJsonlWriter(join(opts.out, 'proof.jsonl'));
  const say = (text) => { if (log.guardText(text)) console.log(text); else console.log('[redacted line]'); };
  const obs = { book: opts.book };
  const serial = opts.serial;
  const port = 9300 + Math.floor(Math.random() * 500);
  const configPath = `${DATA_PREFIX}/Books/${opts.book}/config.json`;
  const deadline = Date.now() + RUN_BUDGET_MS;
  let token = null;
  let cdp = null;
  let shot = 0;

  // Steps drive the device only through these. When the budget runs out
  // mid-step the runner aborts `run`: adb children die, sleeps and polls
  // reject, and the CDP socket closes. Restore uses the raw helpers.
  const run = new AbortController();
  const sig = run.signal;
  const ad = (args, o = {}) => adb(serial, args, { ...o, signal: sig });
  const sh = (cmd, o) => ad(['shell', cmd], o);
  const nap = (ms) => sleep(ms, sig);
  const wait = (fn, o) => waitFor(fn, { ...o, signal: sig });

  const record = (step, event, data) => { try { return log.write(step, event, data); } catch { return false; } };
  const screenshot = async (step, { raw = false } = {}) => {
    try {
      const png = raw
        ? await adb(serial, ['exec-out', 'screencap', '-p'], { encoding: 'buffer', timeoutMs: 20_000 })
        : await ad(['exec-out', 'screencap', '-p'], { encoding: 'buffer', timeoutMs: 20_000 });
      const name = `${String(++shot).padStart(2, '0')}-${step}.png`;
      writeFileSync(join(opts.out, name), png);
      record(step, 'screenshot', { file: name });
    } catch (e) { record(step, 'screenshot_failed', { error: String(e.message) }); }
  };
  const reconnect = async (step) => {
    cdp?.close();
    const c = await connectCdp(serial, port, sig);
    // An abandoned step must not hand restore a fresh socket to leak.
    if (sig.aborted) { c.cdp.close(); throw abortedError(); }
    cdp = c.cdp;
    record(step, 'cdp_connected', { detail: c.detail });
    return c;
  };
  const readConfig = async () => {
    const res = await cdp.evaluate(js.readFile(configPath));
    if (!res?.ok) return { ok: false, error: res?.error ?? 'unreadable' };
    const config = JSON.parse(res.text);
    const notes = (config.booknotes ?? []).filter((n) => !n.deletedAt);
    return { ok: true, location: config.location ?? null, noteIds: notes.map((n) => n.id), highlightIds: notes.filter((n) => n.type === 'annotation').map((n) => n.id) };
  };
  const pending = async () => cdp.evaluate(js.pendingProbe);
  const airplaneOn = async () => (await sh('settings get global airplane_mode_on')) === '1';
  const screenAwake = async () => /mWakefulness=Awake/.test(await sh('dumpsys power'));
  const wake = async () => { if (!(await screenAwake())) await sh('input keyevent 224'); await sh('wm dismiss-keyguard').catch(() => {}); };
  const launch = async () => { await sh(`monkey -p ${PACKAGE} -c android.intent.category.LAUNCHER 1`); };
  const waitReader = async () => wait(async () => cdp.evaluate(js.liveCfi), { timeoutMs: 45_000, label: 'reader location' });
  const openBook = async (step) => {
    let via = 'cdp-navigation';
    const deepLink = `palma-readest://open?book=${opts.book}`;
    const resolved = await sh(`cmd package query-activities --brief -a android.intent.action.VIEW -d '${deepLink}'`).catch(() => '');
    if (resolved.includes(PACKAGE)) {
      via = 'deep-link';
      await sh(`am start -a android.intent.action.VIEW -d '${deepLink}' ${PACKAGE}`);
    } else {
      await cdp.evaluate(`location.href = '/reader?ids=' + encodeURIComponent(${JSON.stringify(opts.book)}); true`).catch(() => {});
      await nap(2000);
      await reconnect(step);
    }
    await waitReader();
    return via;
  };
  const turnPages = async (n) => { for (let i = 0; i < n; i++) { await cdp.key('ArrowRight', 'ArrowRight', 39); await nap(700); } };
  const localState = async (phase) => {
    const cfg = await readConfig();
    const pend = await pending();
    const live = await cdp.evaluate(js.liveCfi).catch(() => null);
    const state = { cfi: cfg.ok ? cfg.location : null, liveCfi: live, noteIds: cfg.ok ? cfg.noteIds : [], pending: pend?.pending ?? null, pendingSource: pend?.source ?? null, queuedKeys: Array.isArray(pend?.entries) ? pend.entries.map((e) => e.key) : null, configError: cfg.ok ? undefined : cfg.error };
    if (Array.isArray(pend?.entries)) queuedEver.push(...pend.entries);
    record(phase, 'local_state', state);
    return state;
  };
  const serverGet = async (type, book) => {
    const rows = [];
    let since = 0;
    for (let page = 0; page < 50; page++) {
      const url = `${opts.server}/reader/sync?since=${since}&type=${type}&book=${encodeURIComponent(book)}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'X-Homebase-Client': HARNESS_CLIENT_ID, 'X-Homebase-Schema': '1' }, signal: AbortSignal.any([AbortSignal.timeout(20_000), sig]) });
      if (!res.ok) throw new Error(`GET ${type} for ${book}: HTTP ${res.status}`);
      const batch = (await res.json())[type] ?? [];
      rows.push(...batch);
      const next = maxReceiptMs(batch);
      if (batch.length === 0 || next <= since) break;
      since = next;
    }
    return rows;
  };
  // configs, notes and books rows for every hash, read from the host.
  const readServer = async (hashes) => {
    const server = { ok: true, hashes: [...hashes], configs: [], notes: [], books: [] };
    for (const hash of hashes) {
      server.configs.push(...(await serverGet('configs', hash)));
      server.notes.push(...(await serverGet('notes', hash)));
      server.books.push(...(await serverGet('books', hash)));
    }
    return server;
  };
  const serverSummary = (server) => ({
    hashes: server.hashes,
    configs: server.configs.map((c) => ({ book_hash: bookHashOf(c), location: c.location ?? null, synced_at: c.synced_at ?? null })),
    notes: server.notes.map((n) => ({ id: n.id, book_hash: bookHashOf(n), synced_at: n.synced_at ?? null, deleted: isDeleted(n) })),
    books: server.books.map((bk) => ({ book_hash: bookHashOf(bk), synced_at: bk.synced_at ?? null })),
  });
  // Every outbox entry seen offline (before the kill, after it, after the
  // reboot), so the server readback covers rows lost on the way to the drain.
  const queuedEver = [];
  const queuedHashes = () => new Set([opts.book, ...(obs.queued ?? []).map((e) => e.bookHash).filter(Boolean)]);

  const steps = [
    ['preflight', async () => {
      const p = (obs.preflight = { serial, serverArg: opts.server });
      p.adbState = await ad(['get-state']).catch((e) => `error: ${e.message.split('\n')[0]}`);
      if (p.adbState !== 'device') throw new Error(`adb state ${p.adbState}`);
      if (serial.includes(':')) throw new Error('network serial: airplane mode would drop adb. Use the USB serial.');
      p.packageInstalled = (await sh(`pm list packages ${PACKAGE}`)).split('\n').some((l) => l.trim() === `package:${PACKAGE}`);
      if (!p.packageInstalled) throw new Error(`${PACKAGE} not installed`);
      if (!(await sh(`pidof ${PACKAGE}`).catch(() => ''))) { await launch(); }
      await wake();
      try { const c = await reconnect('preflight'); p.cdpConnected = true; p.cdpDetail = c.detail; }
      catch (e) { p.cdpConnected = false; p.cdpDetail = e.message; throw e; }
      token = await cdp.evaluate(js.readToken);
      log.addSecret(token);
      p.tokenPresent = typeof token === 'string' && token.length > 0;
      p.clientIdPresent = await cdp.evaluate(js.clientId);
      // Before the route probe, so no harness fetch can be mistaken for the app's.
      const candidates = await cdp.evaluate(js.baseUrlCandidates, 60_000).catch((e) => { record('preflight', 'base_url_probe_failed', { error: e.message }); return []; });
      const base = resolveDeviceBaseUrl(candidates);
      p.deviceBaseUrl = base.baseUrl;
      p.deviceBaseSources = base.sources;
      p.deviceBaseConflict = base.conflict;
      const probe = await cdp.evaluate(js.routeProbe(`${opts.server}/reader/sync/capabilities`));
      p.deviceRouteOk = probe?.reached === true;
      record('preflight', 'observed', { ...p });
      await screenshot('preflight');
      if (!p.tokenPresent || !p.clientIdPresent) throw new Error('device is not paired');
      if (norm(p.deviceBaseUrl) !== norm(opts.server)) throw new Error(`cannot confirm --server is the device's sync target (device: ${p.deviceBaseUrl ?? 'unknown'})`);
      if (!p.deviceRouteOk) throw new Error('device cannot reach the server before airplane mode');
    }],
    ['baseline', async () => {
      try {
        const configs = await serverGet('configs', opts.book);
        const notes = await serverGet('notes', opts.book);
        const config = configs.find((row) => bookHashOf(row) === opts.book);
        obs.baseline = { ok: true, location: config?.location ?? null, noteIds: notes.map((n) => n.id), maxReceiptMs: maxReceiptMs([...configs, ...notes]) };
      } catch (e) { obs.baseline = { ok: false, error: e.message }; }
      record('baseline', 'observed', obs.baseline);
      if (!obs.baseline.ok) throw new Error('baseline readback failed');
    }],
    ['airplane', async () => {
      await sh('cmd connectivity airplane-mode enable');
      await nap(5000);
      const enabled = await airplaneOn();
      const probe = await cdp.evaluate(js.routeProbe(`${opts.server}/reader/sync/capabilities`));
      obs.airplane = { enabled, fetchFailed: probe?.reached === false, probe };
      record('airplane', 'observed', obs.airplane);
      await screenshot('airplane');
      if (!enabled) throw new Error('airplane mode did not turn on');
    }],
    ['read', async () => {
      const via = await openBook('read');
      await nap(2000);
      const startCfi = await cdp.evaluate(js.liveCfi);
      await turnPages(opts.pages);
      await nap(1500);
      const endCfi = await cdp.evaluate(js.liveCfi);
      obs.read = { opened: Boolean(startCfi), via, startCfi, endCfi, pagesTurned: opts.pages };
      record('read', 'observed', obs.read);
      await screenshot('read');
    }],
    ['annotate', async () => {
      const before = await readConfig();
      const known = new Set(before.ok ? before.noteIds : []);
      let mode = null;
      const sel = await cdp.evaluate(js.selectText);
      if (sel?.selected) {
        const clicked = await wait(async () => cdp.evaluate(js.clickHighlight), { timeoutMs: 6000, intervalMs: 500, label: 'Highlight button' }).catch(() => false);
        if (clicked) mode = 'cdp';
      }
      if (!mode) {
        await screenshot('annotate-manual');
        say('\nManual step: on the Palma, long-press a word on the current page, drag to select a few words, and tap Highlight.');
        const answer = await readLine('Press Enter here once the highlight is visible (5 min timeout): ', 5 * 60_000, sig);
        mode = answer === null ? 'manual-timeout' : 'manual';
      }
      const found = await wait(async () => {
        const cfg = await readConfig();
        return cfg.ok ? cfg.highlightIds.find((id) => !known.has(id)) ?? null : null;
      }, { timeoutMs: 15_000, label: 'new highlight in config.json' }).catch(() => null);
      obs.annotate = found ? { highlightId: found, mode } : { highlightId: null, mode, error: 'no new highlight in config.json' };
      record('annotate', 'observed', obs.annotate);
      await screenshot('annotate');
    }],
    ['listen', async () => {
      if (opts.listen === 'skip') { record('listen', 'skipped', {}); return; }
      const beforeCfi = await cdp.evaluate(js.liveCfi);
      let mode = 'tts';
      if (opts.listen === 'readaloud' && (await cdp.evaluate(js.hasMediaOverlay)) && (await cdp.evaluate(js.clickReadaloud))) mode = 'readaloud';
      else await cdp.key('t', 'KeyT', 84, 't');
      if (opts.listen === 'readaloud' && mode === 'tts') record('listen', 'readaloud_unavailable', { fallback: 'tts' });
      await nap(5000);
      const state = await cdp.evaluate(js.listenState);
      const started = state?.mediaSession === 'playing' || state?.pauseButton === true;
      await nap(LISTEN_PLAY_MS - 5000);
      await screenshot('listen-playing');
      // The locked-phase baseline: read immediately before the power key.
      const screenOffCfi = await cdp.evaluate(js.liveCfi);
      if (await screenAwake()) await sh('input keyevent 26');
      await nap(1500);
      const screenOff = !(await screenAwake());
      record('listen', 'screen_off', { screenOffCfi, screenOff });
      await nap(LISTEN_SCREEN_OFF_MS);
      await wake();
      await nap(2000);
      const afterCfi = await cdp.evaluate(js.liveCfi);
      obs.listen = { mode, started, state, beforeCfi, screenOffCfi, screenOff, afterCfi };
      record('listen', 'observed', obs.listen);
      await screenshot('listen-woken');
      // Stop playback so the persisted position holds still for the kill checks.
      if (mode === 'readaloud') await cdp.evaluate(js.clickReadaloud).catch(() => {}); else await cdp.key(' ', 'Space', 32, ' ').catch(() => {});
    }],
    ['offline', async () => {
      // Wait for the progress autosave to persist the live position.
      let cfg = { ok: false, error: 'not read' };
      let liveCfi = null;
      const until = Date.now() + 15_000;
      do {
        await nap(1500);
        liveCfi = await cdp.evaluate(js.liveCfi).catch(() => null);
        cfg = await readConfig();
      } while (Date.now() < until && !(cfg.ok && compareCfi(cfg.location, liveCfi) === 0));
      const snap = await pending().catch(() => null);
      if (Array.isArray(snap?.entries)) queuedEver.push(...snap.entries);
      obs.offline = { cfi: cfg.ok ? cfg.location : null, liveCfi, queuedKeys: Array.isArray(snap?.entries) ? snap.entries.map((e) => e.key) : null, error: cfg.ok ? undefined : cfg.error };
      record('offline', 'observed', obs.offline);
    }],
    ['kill', async () => {
      await sh(`am force-stop ${PACKAGE}`);
      record('kill', 'force_stopped', {});
      await nap(2000);
      await launch();
      await reconnect('kill');
      await openBook('kill').catch((e) => record('kill', 'reopen_failed', { error: e.message }));
      await nap(2000);
      obs.kill = await localState('kill');
      await screenshot('kill-relaunched');
    }],
    ['reboot', async () => {
      cdp?.close(); cdp = null;
      await ad(['reboot']);
      record('reboot', 'rebooting', {});
      await nap(10_000);
      await ad(['wait-for-device'], { timeoutMs: 180_000 });
      const bootCompleted = await wait(async () => (await sh('getprop sys.boot_completed')) === '1', { timeoutMs: 180_000, intervalMs: 3000, label: 'sys.boot_completed' }).then(() => true).catch(() => false);
      const stillOn = await airplaneOn();
      if (!stillOn) await sh('cmd connectivity airplane-mode enable');
      await wake();
      await nap(5000);
      await launch();
      await reconnect('reboot');
      await openBook('reboot').catch((e) => record('reboot', 'reopen_failed', { error: e.message }));
      await nap(2000);
      obs.reboot = { bootCompleted, airplaneOn: stillOn, ...(await localState('reboot')) };
      await screenshot('reboot-relaunched');
    }],
    ['drain', async () => {
      const snapshot = await pending();
      // Union by key: the latest snapshot's entry wins, and a row seen earlier
      // but missing now stays in the list, so the readback fails on it.
      const byKey = new Map(queuedEver.map((e) => [e.key, e]));
      for (const e of snapshot?.entries ?? []) byKey.set(e.key, e);
      obs.queued = Array.isArray(snapshot?.entries) ? [...byKey.values()] : null;
      record('drain', 'queued_snapshot', { source: snapshot?.source, queued: obs.queued });
      // The device is still in airplane mode, so nothing it queued can have
      // arrived yet. The server rows read now are the "before" that each
      // queued row's receipt must beat after the drain.
      try { obs.preDrain = await readServer(queuedHashes()); record('drain', 'pre_drain_server', serverSummary(obs.preDrain)); }
      catch (e) { obs.preDrain = { ok: false, error: e.message }; record('drain', 'pre_drain_server_failed', { error: e.message }); }
      await sh('cmd connectivity airplane-mode disable');
      const start = Date.now();
      const samples = [];
      let last = null;
      while (Date.now() - start <= DRAIN_TIMEOUT_MS) {
        await nap(5000);
        const p = await pending().catch(() => null);
        if (p) last = p;
        samples.push({ t: Date.now() - start, pending: p?.pending ?? null, source: p?.source ?? null });
        if (p?.pending === 0) break;
      }
      obs.drain = { samples };
      obs.afterDrain = last?.entries ?? null;
      record('drain', 'observed', { ...obs.drain, afterDrain: obs.afterDrain, error: last?.error ?? undefined });
      await screenshot('drain');
    }],
    ['server', async () => {
      try {
        obs.server = await readServer(queuedHashes());
        record('server', 'observed', serverSummary(obs.server));
      } catch (e) { obs.server = { ok: false, error: e.message }; record('server', 'failed', { error: e.message }); }
    }],
  ];

  // Restore runs after the steps however they ended, with raw adb (not bound
  // to the aborted run) and short timeouts, inside the lock's last minute.
  const restore = async () => {
    const r = {};
    const rsh = (cmd) => shell(serial, cmd, { timeoutMs: 15_000 });
    try { await rsh('cmd connectivity airplane-mode disable'); r.airplaneOff = (await rsh('settings get global airplane_mode_on')) !== '1'; }
    catch (e) { r.airplaneOff = false; r.error = e.message; }
    try {
      const awake = async () => /mWakefulness=Awake/.test(await rsh('dumpsys power'));
      if (!(await awake())) await rsh('input keyevent 224');
      await rsh('wm dismiss-keyguard').catch(() => {});
      r.screenOn = await awake();
    } catch (e) { r.screenOn = false; r.error = e.message; }
    await screenshot('restore', { raw: true });
    cdp?.close();
    await adb(serial, ['forward', '--remove', `tcp:${port}`], { timeoutMs: 15_000 }).catch(() => {});
    return r;
  };

  const result = await executeRun({
    steps, restore, deadline, log, obs, say,
    out: opts.out, listen: opts.listen,
    abort: () => { run.abort(); cdp?.close(); },
    meta: { book: opts.book, server: opts.server },
  });
  for (const c of result.checks) say(`${c.status.padEnd(4)} ${c.id}  ${c.detail}`);
  say(`\nverdict: ${result.verdict}  (${result.summaryWritten ? `${opts.out}/summary.json` : 'summary.json NOT written'})`);
  return result.verdict === 'PASS' ? 0 : result.verdict === 'PARTIAL' ? 3 : 1;
}

// ---------------------------------------------------------------------------
// Self-test: canned transcripts, no device
// ---------------------------------------------------------------------------

const CFI = {
  base: 'epubcfi(/6/10!/4/2/8/1:0)',
  readStart: 'epubcfi(/6/10!/4/2/12/1:40)',
  readEnd: 'epubcfi(/6/12!/4/2/30/1:12)',
  screenOff: 'epubcfi(/6/12!/4/2/58/1:0)',
  listenEnd: 'epubcfi(/6/14!/4/2/6/1:0)',
  final: 'epubcfi(/6/14!/4/2/6,/1:0,/1:88)',
};
const BOOK = 'b0c4f1e2d3a4958677';
// Carries + / = so its URL-encoded form differs from the raw one.
const TOKEN = 'hbdev_9f8e7d6c+5b4a/39281706f5e4d3c2b1a0==';

const QUEUED_KEYS = [`configs:${BOOK}`, `notes:${BOOK}:n-new-offline`, `statPages:${BOOK}:41:1790541000`, `books:${BOOK}`];

function passingTranscript() {
  return {
    book: BOOK,
    preflight: { adbState: 'device', serial: '82d5c0a8', serverArg: 'https://studio.example.ts.net:3148/api/readest', packageInstalled: true, cdpConnected: true, cdpDetail: 'pid 4242', tokenPresent: true, clientIdPresent: true, deviceBaseUrl: 'https://studio.example.ts.net:3148/api/readest', deviceBaseSources: ['resource-timing', 'bundle'], deviceBaseConflict: null, deviceRouteOk: true },
    baseline: { ok: true, location: CFI.base, noteIds: ['n-old-1', 'n-old-2'], maxReceiptMs: Date.parse('2026-09-27T20:00:00Z') },
    airplane: { enabled: true, fetchFailed: true },
    read: { opened: true, via: 'cdp-navigation', startCfi: CFI.readStart, endCfi: CFI.readEnd, pagesTurned: 12 },
    annotate: { highlightId: 'n-new-offline', mode: 'cdp' },
    listen: { mode: 'tts', started: true, beforeCfi: CFI.readEnd, screenOffCfi: CFI.screenOff, screenOff: true, afterCfi: CFI.listenEnd },
    offline: { cfi: CFI.final, liveCfi: CFI.final, queuedKeys: QUEUED_KEYS },
    kill: { cfi: CFI.final, noteIds: ['n-old-1', 'n-old-2', 'n-new-offline'], pending: 4, pendingSource: 'outbox-file', queuedKeys: QUEUED_KEYS },
    reboot: { bootCompleted: true, airplaneOn: true, cfi: CFI.final, noteIds: ['n-old-1', 'n-old-2', 'n-new-offline'], pending: 4, pendingSource: 'outbox-file', queuedKeys: QUEUED_KEYS },
    queued: [
      { key: `configs:${BOOK}`, channel: 'configs', bookHash: BOOK, id: null, poisoned: false },
      { key: `notes:${BOOK}:n-new-offline`, channel: 'notes', bookHash: BOOK, id: 'n-new-offline', poisoned: false },
      { key: `statPages:${BOOK}:41:1790541000`, channel: 'statPages', bookHash: BOOK, id: null, poisoned: false },
      { key: `books:${BOOK}`, channel: 'books', bookHash: BOOK, id: null, poisoned: false },
    ],
    // Read from the host while the device was still offline: the old rows.
    preDrain: {
      ok: true,
      hashes: [BOOK],
      configs: [{ book_hash: BOOK, location: CFI.base, synced_at: '2026-09-27T20:00:00Z' }],
      notes: [
        { id: 'n-old-1', book_hash: BOOK, synced_at: '2026-09-27T19:00:00Z' },
        { id: 'n-old-2', book_hash: BOOK, synced_at: '2026-09-27T20:00:00Z' },
      ],
      books: [{ hash: BOOK, book_hash: BOOK, synced_at: '2026-09-01T08:00:00Z' }],
    },
    drain: { samples: [{ t: 5000, pending: 4 }, { t: 10000, pending: 1 }, { t: 15000, pending: 0 }] },
    afterDrain: [],
    server: {
      ok: true,
      configs: [{ book_hash: BOOK, location: CFI.final, synced_at: '2026-09-27T21:10:00Z' }],
      notes: [
        { id: 'n-old-1', book_hash: BOOK, synced_at: '2026-09-27T19:00:00Z' },
        { id: 'n-old-2', book_hash: BOOK, synced_at: '2026-09-27T20:00:00Z' },
        { id: 'n-new-offline', book_hash: BOOK, synced_at: '2026-09-27T21:10:01Z' },
      ],
      books: [{ hash: BOOK, book_hash: BOOK, synced_at: '2026-09-27T21:10:02Z' }],
    },
    run: { budgetExhausted: false, stoppedAt: null, error: null, completed: ['preflight', 'baseline', 'airplane', 'read', 'annotate', 'listen', 'offline', 'kill', 'reboot', 'drain', 'server'] },
    restore: { airplaneOff: true, screenOn: true },
    safety: { redactionRefusals: 0 },
  };
}

async function selfTest() {
  const results = [];
  const expect = (name, cond, detail = '') => { results.push({ name, ok: Boolean(cond), detail }); };
  const dir = mkdtempSync(join(tmpdir(), 'offline-proof-selftest-'));
  try {
    // Unit checks on the pure helpers.
    expect('parseArgs: full device invocation', (() => {
      const o = parseArgs(['--serial', '82d5c0a8', '--server', 'https://h.example/api/readest/', '--book', BOOK, '--listen', 'skip', '--pages', '5', '--out', join(dir, 'o')]);
      return o.server === 'https://h.example/api/readest' && o.pages === 5 && o.listen === 'skip' && o.out === join(dir, 'o');
    })());
    expect('parseArgs: defaults', (() => { const o = parseArgs(['--serial', 's', '--server', 'http://h', '--book', 'abc']); return o.pages === 12 && o.listen === 'readaloud' && o.out.includes('offline-proof-'); })());
    for (const bad of [[], ['--serial', 's', '--server', 'h', '--book', 'b'], ['--serial', 's', '--server', 'http://h', '--book', 'b', '--listen', 'loud'], ['--serial', 's', '--server', 'http://h', '--book', 'b', '--pages', '0'], ['--bogus'], ['--serial']]) {
      expect(`parseArgs rejects ${JSON.stringify(bad)}`, (() => { try { parseArgs(bad); return false; } catch (e) { return e instanceof UsageError; } })());
    }
    expect('parseArgs: --lock-owner', parseArgs(['--serial', 's', '--server', 'http://h', '--book', 'b', '--lock-owner', 'lane-x']).lockOwner === 'lane-x');
    expect('lockRefusal: own lock passes', lockRefusal('reader-sync\n', 'reader-sync') === null);
    expect('lockRefusal: missing lock refuses', /does not exist/.test(lockRefusal(null, 'reader-sync') ?? ''));
    expect('lockRefusal: another lane\'s lock refuses', /held by "boox-launcher"/.test(lockRefusal('boox-launcher\n', 'reader-sync') ?? ''));
    expect('lockRefusal: empty owner refuses', lockRefusal('', 'reader-sync') !== null);
    expect('compareCfi: later spine wins', compareCfi(CFI.readEnd, CFI.readStart) === 1);
    expect('compareCfi: char offset ordering', compareCfi('epubcfi(/6/4!/4/2/1:30)', 'epubcfi(/6/4!/4/2/1:120)') === -1);
    expect('compareCfi: range uses start', compareCfi(CFI.final, CFI.listenEnd) === 0);
    expect('compareCfi: id assertions ignored', compareCfi('epubcfi(/6/4[ch1]!/4[body,x]/2)', 'epubcfi(/6/4!/4/2)') === 0);
    expect('compareCfi: garbage is null', compareCfi('page 12', CFI.base) === null);

    // Tauri fs decoding: plugin-fs 2.5.1 hands raw invokes bytes, older builds a string.
    const enc = new TextEncoder().encode('{"location":"x"}');
    expect('decodeFsText: string passes through', decodeFsText('{"a":1}') === '{"a":1}');
    expect('decodeFsText: ArrayBuffer', decodeFsText(enc.buffer.slice(0)) === '{"location":"x"}');
    expect('decodeFsText: Uint8Array view', decodeFsText(new Uint8Array([0, ...enc]).subarray(1)) === '{"location":"x"}');
    expect('decodeFsText: number array', decodeFsText([...enc]) === '{"location":"x"}');
    expect('decodeFsText: rejects non-text shapes', [null, {}, [1, 999]].every((v) => { try { decodeFsText(v); return false; } catch (e) { return e instanceof TypeError; } }));

    // The page snippets themselves, run against a fake Tauri bridge.
    const runSnippet = (snippet, env) => new Function('window', 'localStorage', `return ${snippet};`)(env.window, env.localStorage);
    const fakeLs = (items = {}) => ({ getItem: (k) => (k in items ? items[k] : null) });
    const bridge = (impl) => ({ window: { __TAURI_INTERNALS__: { invoke: async (cmd, args) => impl(cmd, args) } }, localStorage: fakeLs() });
    const cfgText = JSON.stringify({ location: CFI.final, booknotes: [] });
    for (const [label, ret] of [['string', cfgText], ['bytes', new TextEncoder().encode(cfgText).buffer], ['number array', [...new TextEncoder().encode(cfgText)]]]) {
      const res = await runSnippet(js.readFile(`Readest/Books/${BOOK}/config.json`), bridge((cmd, args) => { if (cmd !== 'plugin:fs|read_text_file' || args.options.baseDir !== 14) throw new Error('bad call'); return ret; }));
      expect(`readFile snippet decodes a ${label} result`, res.ok && JSON.parse(res.text).location === CFI.final, JSON.stringify(res).slice(0, 120));
    }
    const missingRes = await runSnippet(js.readFile('x'), bridge(() => { throw 'failed to open file: No such file or directory (os error 2)'; }));
    expect('readFile snippet flags a missing file', !missingRes.ok && missingRes.missing === true);
    const outboxFile = JSON.stringify([
      { key: `configs:${BOOK}`, channel: 'configs', record: { book_hash: BOOK }, queuedAt: 1, attempts: 0 },
      { key: `notes:${BOOK}:n1`, channel: 'notes', record: { book_hash: BOOK, id: 'n1' }, queuedAt: 2, attempts: 0 },
      { key: `notes:${BOOK}:bad`, channel: 'notes', record: { book_hash: BOOK, id: 'bad' }, queuedAt: 3, attempts: 1, poisoned: true },
    ]);
    const legacy = JSON.stringify([
      { key: `notes:${BOOK}:n1`, channel: 'notes', record: { book_hash: BOOK, id: 'n1' }, queuedAt: 2, attempts: 0 },
      { key: `statBooks:${BOOK}`, channel: 'statBooks', record: { book_hash: BOOK }, queuedAt: 4, attempts: 0 },
    ]);
    const pend = await runSnippet(js.pendingProbe, { window: bridge(() => new TextEncoder().encode(outboxFile)).window, localStorage: fakeLs({ 'readest-homebase-outbox': legacy }) });
    expect('pendingProbe merges outbox file and legacy rows', pend.pending === 3 && pend.entries.length === 4 && pend.source === 'outbox-file+outbox-localStorage', JSON.stringify(pend).slice(0, 160));
    const pendDenied = await runSnippet(js.pendingProbe, { window: bridge(() => { throw 'Permission denied (os error 13)'; }).window, localStorage: fakeLs() });
    expect('pendingProbe: unreadable outbox is null, not empty', pendDenied.pending === null && pendDenied.entries === null && pendDenied.source === 'outbox-error');
    const pendNone = await runSnippet(js.pendingProbe, { window: bridge(() => { throw 'No such file or directory (os error 2)'; }).window, localStorage: fakeLs() });
    expect('pendingProbe: no outbox anywhere is 0', pendNone.pending === 0 && pendNone.source === 'outbox-empty');

    // Device base URL discovery.
    const srv = 'https://studio.example.ts.net:3148/api/readest';
    expect('baseUrlsFromResources: app requests only', JSON.stringify(baseUrlsFromResources([
      `${srv}/reader/sync?since=0&type=configs&book=${BOOK}`,
      `${srv}/reader/sync/capabilities`,
      `https://other.example/reader/sync/capabilities?${PROBE_MARKER}=1`,
      'https://x.example/reader/syncx',
      'http://tauri.localhost/_next/static/chunks/app.js',
    ])) === JSON.stringify([srv]));
    expect('extractBundleBaseUrls: minified getHomebaseBaseUrl', JSON.stringify(extractBundleBaseUrls(
      `let a=()=>{let e=(null!=(t=window.__READEST_RUNTIME_CONFIG)?t:{}).homebaseApiBaseUrl||process.env.HOMEBASE_API_BASE_URL||"${srv}/"||"";return e?e.replace(/\/+$/,""):null}`)) === JSON.stringify([srv]));
    expect('extractBundleBaseUrls: none without the key', extractBundleBaseUrls('fetch("https://x.example/reader/sync")').length === 0);
    expect('resolveDeviceBaseUrl: agreeing sources', resolveDeviceBaseUrl([{ source: 'bundle', url: `${srv}/` }, { source: 'resource-timing', url: srv }]).baseUrl === srv);
    expect('resolveDeviceBaseUrl: conflict is null', (() => { const r = resolveDeviceBaseUrl([{ source: 'bundle', url: srv }, { source: 'resource-timing', url: 'https://old.example' }]); return r.baseUrl === null && r.conflict.length === 2; })());
    expect('resolveDeviceBaseUrl: no source is null', resolveDeviceBaseUrl([]).baseUrl === null);
    const origin = 'http://tauri.localhost';
    const chunk = `x.homebaseApiBaseUrl||"${srv}"||""`;
    const pageEnv = {
      window: {},
      performance: { getEntriesByType: () => [
        { name: `${srv}/reader/sync?since=0&type=notes`, initiatorType: 'fetch' },
        { name: `${srv}/reader/sync/capabilities?${PROBE_MARKER}=1`, initiatorType: 'fetch' },
        { name: `${origin}/_next/static/chunks/hb.js`, initiatorType: 'script' },
      ] },
      document: { scripts: [{ src: `${origin}/_next/static/chunks/main.js` }] },
      location: { origin },
      fetch: async (u) => ({ text: async () => (u.endsWith('hb.js') ? chunk : 'no key here') }),
    };
    const cands = await new Function(...Object.keys(pageEnv), `return ${js.baseUrlCandidates};`)(...Object.values(pageEnv));
    const resolved = resolveDeviceBaseUrl(cands);
    expect('baseUrlCandidates snippet: resource timing and bundle agree', resolved.baseUrl === srv && resolved.sources.join() === 'resource-timing,bundle', JSON.stringify(cands));
    expect('every page snippet compiles', Object.entries(js).every(([, v]) => { try { new Function(`return ${typeof v === 'function' ? v('x') : v};`); return true; } catch { return false; } }));

    // Run orchestration: the budget is enforced inside a step, and restore and
    // summary.json happen however the steps ended.
    const runCase = async (label, { steps, deadlineMs, restoreThrows = false }) => {
      const out = join(dir, `run-${label}`);
      mkdirSync(out);
      const runLog = createJsonlWriter(join(out, 'proof.jsonl'));
      const ctl = new AbortController();
      const seen = { restored: false, ran: [] };
      const wrapped = steps.map(([name, fn]) => [name, async () => { seen.ran.push(name); await fn(ctl.signal); }]);
      const obs = passingTranscript(); delete obs.run; delete obs.restore; delete obs.safety;
      const started = Date.now();
      const result = await executeRun({
        steps: wrapped, deadline: Date.now() + deadlineMs, log: runLog, obs, out, listen: 'readaloud',
        abort: () => ctl.abort(),
        restore: async () => { seen.restored = true; if (restoreThrows) throw new Error('adb gone'); return { airplaneOff: true, screenOn: true }; },
      });
      const summaryPath = join(out, 'summary.json');
      const summary = existsSync(summaryPath) ? JSON.parse(readFileSync(summaryPath, 'utf8')) : null;
      const status = (id) => summary?.checks.find((c) => c.id === id)?.status;
      return { result, summary, status, seen, aborted: ctl.signal.aborted, elapsed: Date.now() - started, jsonl: readFileSync(join(out, 'proof.jsonl'), 'utf8'), obs };
    };
    const hang = await runCase('hang', {
      deadlineMs: 150,
      restoreThrows: true,
      steps: [['preflight', async () => {}], ['reboot', (signal) => sleep(60_000, signal)], ['drain', async () => {}]],
    });
    expect('budget: a step still running at the deadline is cut off mid-step', hang.obs.run.budgetExhausted === true && hang.obs.run.stoppedAt === 'reboot' && hang.elapsed < 2000, `elapsed ${hang.elapsed} ms; run ${JSON.stringify(hang.obs.run)}`);
    expect('budget: the abandoned step is aborted and later steps never start', hang.aborted && hang.seen.ran.join() === 'preflight,reboot');
    expect('budget: restore runs even when it throws', hang.seen.restored && hang.obs.restore.error === 'adb gone');
    expect('budget: summary.json written with FAIL on run.within_budget', hang.summary?.verdict === 'FAIL' && hang.status('run.within_budget') === 'FAIL' && hang.status('restore.airplane_off') === 'FAIL' && hang.result.summaryWritten === true);
    expect('budget: proof.jsonl records the mid-step cut', /"event":"budget_exhausted","when":"mid-step"/.test(hang.jsonl) && /"step":"summary","event":"verdict"/.test(hang.jsonl));
    const late = await runCase('late', { deadlineMs: -1, steps: [['preflight', async () => {}]] });
    expect('budget: exhausted before the first step runs nothing and still writes summary', late.seen.ran.length === 0 && late.obs.run.budgetExhausted && late.summary?.verdict === 'FAIL' && late.seen.restored);
    const threw = await runCase('threw', { deadlineMs: 60_000, steps: [['preflight', async () => { throw new Error('adb state offline'); }], ['baseline', async () => {}]] });
    expect('step error: loop stops, not a budget failure, summary written', threw.seen.ran.join() === 'preflight' && threw.obs.run.budgetExhausted === false && threw.status('run.within_budget') === 'PASS' && threw.status('run.steps_completed') === 'FAIL' && threw.summary?.verdict === 'FAIL');
    const clean = await runCase('clean', { deadlineMs: 60_000, steps: [['preflight', async () => {}], ['baseline', async () => {}]] });
    expect('run checks pass when every step finishes in budget', clean.status('run.within_budget') === 'PASS' && clean.status('run.steps_completed') === 'PASS' && clean.summary?.verdict === 'PASS', JSON.stringify(clean.summary?.checks.filter((c) => c.status === 'FAIL')));
    expect('sleep rejects promptly on abort', await (async () => { const c = new AbortController(); const t0 = Date.now(); const p = sleep(30_000, c.signal); setTimeout(() => c.abort(), 20); try { await p; return false; } catch { return Date.now() - t0 < 1000; } })());

    // Transcripts.
    const cases = [
      { name: 'passing run', obs: passingTranscript(), verdict: 'PASS', failing: [] },
      { name: 'lost annotation', obs: (() => { const o = passingTranscript(); o.server.notes = o.server.notes.filter((n) => n.id !== 'n-new-offline'); return o; })(), verdict: 'FAIL', failing: ['server.highlight_present', 'server.highlight_receipt_advanced', 'server.queued_all_present'] },
      { name: 'regressed CFI', obs: (() => { const o = passingTranscript(); o.listen.afterCfi = CFI.readStart; o.server.configs[0].location = CFI.readEnd; return o; })(), verdict: 'FAIL', failing: ['listen.cfi_advanced_screen_off', 'server.location_matches'] },
      { name: 'listen advanced only before screen off', obs: (() => { const o = passingTranscript(); o.listen.screenOffCfi = CFI.listenEnd; return o; })(), verdict: 'FAIL', failing: ['listen.cfi_advanced_screen_off'] },
      { name: 'screen never locked', obs: (() => { const o = passingTranscript(); o.listen.screenOff = false; return o; })(), verdict: 'FAIL', failing: ['listen.screen_off'] },
      { name: 'persisted CFI behind post-listen CFI', obs: (() => { const o = passingTranscript(); for (const k of ['offline', 'kill', 'reboot']) o[k].cfi = CFI.readEnd; o.offline.liveCfi = CFI.readEnd; o.server.configs[0].location = CFI.readEnd; return o; })(), verdict: 'FAIL', failing: ['offline.cfi_not_behind_last_observed'] },
      { name: 'persisted CFI differs from live reader', obs: (() => { const o = passingTranscript(); o.offline.liveCfi = 'epubcfi(/6/16!/4/2/2/1:0)'; return o; })(), verdict: 'FAIL', failing: ['offline.cfi_matches_live'] },
      { name: 'device base URL unknown', obs: (() => { const o = passingTranscript(); o.preflight.deviceBaseUrl = null; o.preflight.deviceBaseSources = []; return o; })(), verdict: 'FAIL', failing: ['preflight.base_url'] },
      { name: 'device base URL differs from --server', obs: (() => { const o = passingTranscript(); o.preflight.deviceBaseUrl = 'https://old.example/api/readest'; return o; })(), verdict: 'FAIL', failing: ['preflight.base_url'] },
      { name: 'stats row still queued after drain', obs: (() => { const o = passingTranscript(); o.afterDrain = [o.queued[2]]; return o; })(), verdict: 'FAIL', failing: ['drain.queued_all_acked', 'server.queued_all_present'] },
      { name: 'post-drain outbox unread', obs: (() => { const o = passingTranscript(); o.afterDrain = null; return o; })(), verdict: 'FAIL', failing: ['drain.queued_all_acked', 'server.queued_all_present'] },
      { name: 'queued channel with no readback', obs: (() => { const o = passingTranscript(); o.queued.push({ key: `readingGoals:${BOOK}`, channel: 'readingGoals', bookHash: BOOK, id: null, poisoned: false }); return o; })(), verdict: 'FAIL', failing: ['server.queued_all_present'] },
      { name: 'highlight receipt not newer than baseline', obs: (() => { const o = passingTranscript(); o.server.notes.find((n) => n.id === 'n-new-offline').synced_at = '2026-09-27T20:00:00Z'; return o; })(), verdict: 'FAIL', failing: ['server.highlight_receipt_advanced'] },
      { name: 'stale book row counted as delivered', obs: (() => { const o = passingTranscript(); o.server.books[0].synced_at = o.preDrain.books[0].synced_at; return o; })(), verdict: 'FAIL', failing: ['server.queued_all_present'] },
      { name: 'stale config row for another book', obs: (() => {
        const o = passingTranscript(); const other = 'a1b2c3d4e5f60718';
        o.queued.push({ key: `configs:${other}`, channel: 'configs', bookHash: other, id: null, poisoned: false });
        o.preDrain.hashes.push(other);
        o.preDrain.configs.push({ book_hash: other, location: 'epubcfi(/6/2!/4/2/1:0)', synced_at: '2026-09-20T10:00:00Z' });
        o.server.configs.push({ book_hash: other, location: 'epubcfi(/6/2!/4/2/1:0)', synced_at: '2026-09-20T10:00:00Z' });
        return o; })(), verdict: 'FAIL', failing: ['server.queued_all_present'] },
      { name: 'stale note row already on the server', obs: (() => {
        const o = passingTranscript();
        o.queued.push({ key: `notes:${BOOK}:n-old-2`, channel: 'notes', bookHash: BOOK, id: 'n-old-2', deleted: false, poisoned: false });
        return o; })(), verdict: 'FAIL', failing: ['server.queued_all_present'] },
      { name: 'queued note deletion arrived as a tombstone', obs: (() => {
        const o = passingTranscript();
        o.queued.push({ key: `notes:${BOOK}:n-old-1`, channel: 'notes', bookHash: BOOK, id: 'n-old-1', deleted: true, poisoned: false });
        Object.assign(o.server.notes.find((n) => n.id === 'n-old-1'), { deleted_at: '2026-09-27T21:10:01Z', synced_at: '2026-09-27T21:10:01Z' });
        return o; })(), verdict: 'PASS', failing: [] },
      { name: 'new book row absent before the drain', obs: (() => { const o = passingTranscript(); o.preDrain.books = []; return o; })(), verdict: 'PASS', failing: [] },
      { name: 'pre-drain snapshot failed', obs: (() => { const o = passingTranscript(); o.preDrain = { ok: false, error: 'HTTP 502' }; return o; })(), verdict: 'FAIL', failing: ['server.queued_all_present'] },
      { name: 'queued book missing from the pre-drain snapshot', obs: (() => {
        const o = passingTranscript(); const other = 'a1b2c3d4e5f60718';
        o.queued.push({ key: `configs:${other}`, channel: 'configs', bookHash: other, id: null, poisoned: false });
        o.server.configs.push({ book_hash: other, location: 'epubcfi(/6/2!/4/2/1:0)', synced_at: '2026-09-27T21:10:03Z' });
        return o; })(), verdict: 'FAIL', failing: ['server.queued_all_present'] },
      { name: 'server book row without a receipt', obs: (() => { const o = passingTranscript(); delete o.server.books[0].synced_at; return o; })(), verdict: 'FAIL', failing: ['server.queued_all_present'] },
      { name: 'budget ran out mid-step', obs: (() => { const o = passingTranscript(); o.run = { budgetExhausted: true, stoppedAt: 'reboot', error: 'run budget exhausted during reboot', completed: [] }; return o; })(), verdict: 'FAIL', failing: ['run.within_budget', 'run.steps_completed'] },
      { name: 'row lost during the kill', obs: (() => { const o = passingTranscript(); o.kill.queuedKeys = QUEUED_KEYS.filter((k) => !k.startsWith('notes:')); o.reboot.queuedKeys = o.kill.queuedKeys; return o; })(), verdict: 'FAIL', failing: ['kill.queue_intact', 'reboot.queue_intact'] },
      { name: 'row lost during the reboot', obs: (() => { const o = passingTranscript(); o.reboot.queuedKeys = QUEUED_KEYS.slice(1); return o; })(), verdict: 'FAIL', failing: ['reboot.queue_intact'] },
      { name: 'no outbox snapshot before the kill', obs: (() => { const o = passingTranscript(); o.offline.queuedKeys = null; return o; })(), verdict: 'FAIL', failing: ['kill.queue_intact', 'reboot.queue_intact'] },
      { name: 'outbox unreadable after reboot', obs: (() => { const o = passingTranscript(); o.reboot.queuedKeys = null; return o; })(), verdict: 'FAIL', failing: ['reboot.queue_intact'] },
      { name: 'drain timeout', obs: (() => { const o = passingTranscript(); o.drain.samples = [5, 30, 60, 90, 120].map((s) => ({ t: s * 1000, pending: 2 })); return o; })(), verdict: 'FAIL', failing: ['drain.pending_zero'] },
    ];

    // Token leak: drive the real writer and summary path with a leaking step.
    const leakOut = join(dir, 'leak');
    mkdirSync(leakOut);
    const log = createJsonlWriter(join(leakOut, 'proof.jsonl'));
    log.write('preflight', 'start', {});
    log.addSecret(TOKEN);
    log.write('preflight', 'observed', { tokenPresent: true });
    const leaked1 = log.write('baseline', 'request', { headers: { Authorization: `Bearer ${TOKEN}` } });
    const leaked2 = log.write('baseline', 'request_url', { url: `https://h/x?token=${encodeURIComponent(TOKEN)}` });
    const leakObs = passingTranscript();
    leakObs.safety = { redactionRefusals: log.refusals };
    const leakResult = evaluateRun(leakObs);
    const summaryWritten = log.writeJson(join(leakOut, 'summary.json'), leakResult);
    const leakSummaryRefused = !log.writeJson(join(leakOut, 'leak.json'), { note: TOKEN });
    const jsonl = readFileSync(join(leakOut, 'proof.jsonl'), 'utf8');
    const summaryText = readFileSync(join(leakOut, 'summary.json'), 'utf8');
    cases.push({ name: 'token leak attempt', obs: leakObs, verdict: 'FAIL', failing: ['safety.no_token_leak'], result: leakResult });
    expect('token leak: both leaking lines refused', leaked1 === false && leaked2 === false);
    expect('token leak: token absent from proof.jsonl', !jsonl.includes(TOKEN) && !jsonl.includes(encodeURIComponent(TOKEN)));
    expect('token leak: refusal markers written', (jsonl.match(/"redaction_refused"/g) ?? []).length === 2);
    expect('token leak: clean lines still written', jsonl.split('\n').filter(Boolean).length === 4);
    expect('token leak: summary written and clean', summaryWritten && !summaryText.includes(TOKEN));
    expect('token leak: JSON file carrying the token refused', leakSummaryRefused && !existsSync(join(leakOut, 'leak.json')));
    expect('guard ignores empty secret', (() => { const w = createJsonlWriter(join(dir, 'empty.jsonl')); w.addSecret(''); return w.write('x', 'y', { a: 'b' }) && w.refusals === 0; })());

    // --listen skip: listen checks SKIP and the run can still pass.
    const skipObs = passingTranscript(); delete skipObs.listen;
    const skipRes = evaluateRun(skipObs, { listen: 'skip' });
    expect('listen skip: verdict PARTIAL (never a full PASS) with three SKIPs', skipRes.verdict === 'PARTIAL' && skipRes.checks.filter((c) => c.status === 'SKIP').length === 3);
    const skipFail = passingTranscript(); delete skipFail.listen; skipFail.drain.samples = [{ t: 120_000, pending: 1 }];
    expect('listen skip plus a failure: verdict FAIL', evaluateRun(skipFail, { listen: 'skip' }).verdict === 'FAIL');
    const skipBehind = passingTranscript(); delete skipBehind.listen;
    for (const k of ['offline', 'kill', 'reboot']) skipBehind[k].cfi = CFI.readStart;
    skipBehind.offline.liveCfi = CFI.readStart; skipBehind.server.configs[0].location = CFI.readStart;
    expect('listen skip: persisted CFI behind end of reading fails', evaluateRun(skipBehind, { listen: 'skip' }).checks.find((c) => c.id === 'offline.cfi_not_behind_last_observed').status === 'FAIL');

    // A run that stopped after preflight fails every later check as not reached.
    const early = evaluateRun({ book: BOOK, preflight: passingTranscript().preflight, safety: { redactionRefusals: 0 } });
    const deletedObs = passingTranscript();
    deletedObs.server.notes.find((n) => n.id === 'n-new-offline').deleted_at = Date.parse('2026-09-27T21:10:01Z');
    expect('highlight tombstoned on server fails highlight_present', evaluateRun(deletedObs).checks.find((c) => c.id === 'server.highlight_present').status === 'FAIL');

    expect('unreached steps fail',early.verdict === 'FAIL' && early.checks.find((c) => c.id === 'kill.cfi_persisted').detail === 'not reached');

    for (const c of cases) {
      const res = c.result ?? evaluateRun(c.obs);
      const failing = res.checks.filter((x) => x.status === 'FAIL').map((x) => x.id).sort();
      const want = [...c.failing].sort();
      const ok = res.verdict === c.verdict && JSON.stringify(failing) === JSON.stringify(want);
      expect(`transcript "${c.name}": ${c.verdict}${want.length ? ` on ${want.join(', ')}` : ''}`, ok, ok ? '' : `got ${res.verdict} failing [${failing.join(', ')}]`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nself-test: ${results.length - failed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
  return failed === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const USAGE = `usage: node scripts/homebase-offline-proof.mjs --serial <adb serial> --server <homebase base url> --book <fileHash>
         [--out <dir>] [--listen readaloud|tts|skip] [--pages 12] [--lock-owner reader-sync] [--skip-lock-check]
       node scripts/homebase-offline-proof.mjs --self-test`;

async function main(argv) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) {
    if (e instanceof UsageError) { console.error(`${e.message}\n${USAGE}`); return 2; }
    throw e;
  }
  if (opts.help) { console.log(USAGE); return 0; }
  if (opts.selfTest) return selfTest();
  if (typeof WebSocket !== 'function') { console.error('Node 24+ is required (global WebSocket).'); return 2; }
  if (!opts.skipLockCheck) {
    let ownerText = null;
    try { ownerText = readFileSync(join(LOCK_DIR, 'owner'), 'utf8'); } catch { ownerText = null; }
    const refusal = lockRefusal(ownerText, opts.lockOwner);
    if (refusal) { console.error(`Refusing to touch the Palma: ${refusal}`); return 2; }
  }
  return runDevice(opts);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('homebase-offline-proof.mjs')) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(e?.message ?? e); process.exitCode = 1; });
}
