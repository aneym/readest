# Readest source audit for a Homebase-owned sync engine

Read-only audit. No product code was edited. Every claim below cites a path and, where the
claim rests on a specific construct, a line number.

## 1. Provenance

| Fact | Value |
| --- | --- |
| Checkout | `/Volumes/StudioExt/repos/personal/readest-homebase` |
| HEAD | `459d934a01214f915cdb8c0339182f4b8026d38d` |
| HEAD subject | `chore(homebase): establish upstream-sync fork policy` |
| HEAD author / date | alexneyman <a.neyman17@gmail.com>, 2026-08-23 18:41:24 -0400 |
| `git describe` | `v0.12.1-108-g459d934a` |
| Branch at audit start | `homebase/bootstrap`, tracking `fork/homebase/bootstrap` |
| Branch at audit end | `homebase/sync-adapter-spike` (same commit, no upstream tracking) |
| `main` | `558ed2af` `fix(koplugin): pull reading stats in bounded pages (#5833)`, tracking `fork/main` |
| Remotes | `fork` → `https://github.com/aneym/readest.git` (fetch + push); `upstream` → `https://github.com/readest/readest.git` (fetch only, push DISABLED) |
| Package manager | `pnpm@11.1.1` (`package.json`) |
| App version | `0.12.1` (`apps/readest-app/package.json`, name `@readest/readest-app`) |
| Working tree | one untracked path: `apps/readest-app/src/services/sync/homebase/` |

### Integrity note

The checkout changed under the audit. At the start it sat on `homebase/bootstrap` with a clean
tree. By the end the checkout had moved to a new local branch `homebase/sync-adapter-spike` at the
same commit, and seven untracked files had appeared under
`apps/readest-app/src/services/sync/homebase/` (`adapter.ts`, `clocks.ts`, `config.ts`,
`httpAdapter.ts`, `memoryAdapter.ts`, `types.ts`, `wire.ts`, mtimes 18:25 to 18:29 on 2026-08-28).
This audit did not create, edit, stage, or remove any of them, and did not move the branch.

The commit `459d934a` is unchanged, so the source facts below still hold. The spike is inert:
`rg -n "sync/homebase" --glob '!services/sync/homebase/**' src` returns nothing, so no shipping
module imports it, and `isHomebaseSyncEnabled()` returns false without both a base URL and an
explicit opt-in flag (`services/sync/homebase/config.ts:59-67`). It is discussed in section 6
because it constrains the recommendation, not because it is part of the audited tree.

### AGENTS rules

`apps/readest-app/AGENTS.md` (139 lines) is the project rule file. `.agents/` is a symlink to
`.claude/`, and `.claude/memory/`, `.claude/plans/`, and `.claude/rules/` are tracked in git.
Rules that bear on this work:

- "For every coding task, write the minimum code that solves the requested problem. Do not add
  abstractions for single-use code. Do not add flexibility or configurability unless requested."
- Worktrees must come from `pnpm worktree:new`, never `git worktree add`, because the script wires
  submodules (simplecc WASM, foliate-js), `.env`, vendor assets, and Tauri gen symlinks that lint
  and tests need.

An earlier `find -maxdepth 3` for these files came back empty and was wrong. The table above is
from `rg --files` plus `git ls-files`, which agree.

## 2. What Readest's sync actually is

Three sync generations run side by side. Conflating them is the main way a Homebase design goes
wrong, so they are separated here.

### 2.1 Row sync (the oldest, and the one Homebase would displace)

Client: `src/libs/sync.ts` (119 lines). One class, `SyncClient` (`libs/sync.ts:56`), two methods,
`pullChanges` (`:61`) and `pushChanges` (`:95`), both against a single endpoint
`SYNC_API_ENDPOINT` (`libs/sync.ts:6`) with a 15 s timeout via `fetchWithTimeout`. Channels are
`SyncType = 'books' | 'configs' | 'notes' | 'stats'`.

Construction site: `src/context/SyncContext.tsx:6`, `const syncClient = new SyncClient()` at module
scope, handed to the tree by `useSyncContext()` (`:19`). That is the only place a `SyncClient` is
built.

Server: `src/pages/api/sync.ts`, 842 lines, and it is not a thin CRUD wrapper. It is the merge
engine.

- GET cursor is `synced_at` for `books` and `updated_at` for configs and notes. `synced_at` is
  stamped by a Postgres trigger, not by the client (`docker/volumes/db/init/schema.sql`,
  `set_books_synced_at`).
- Books page at 1000 rows; `fetchPagedBooks()` completes a page out to the trailing `synced_at`
  millisecond so a page boundary cannot split a same-millisecond batch.
- Stats rows carry an extra `updated_at_ms` for the Lua koplugin.
- POST resolves per row with `clientIsNewer = clientDeletedAt > serverDeletedAt || clientUpdatedAt
  > serverUpdatedAt`, upserting in batches of 100.
- For `books` only, three field groups merge on their own clocks, independent of the row clock:
  `resolveReadingStatusMerge` (#4634), `resolveCoverMerge` (#4544), `resolveMetadataMerge` (#5438).
  A row that loses the row-level comparison still gets fresher fields grafted on by
  `buildStatusPropagationRow`, deliberately without bumping `updated_at`.
- Primary keys: `books` `['book_hash']`, `book_configs` `['book_hash']`, `book_notes`
  `['book_hash','id']`.
- `books.progress` is piggybacked off the configs push, guarded by `.lt('updated_at', u.updated_at)`.
- `stat_pages` goes through `supabase.rpc('upsert_stat_pages', { p_rows })` in batches of 500
  (migration 019).

The file exports App Router `GET`/`POST` and also a Pages Router `handler` that re-wraps them using
`process.env['PROTOCOL']` and `process.env['HOST']` plus `corsAllMethods`. Both routers are live in
this app.

The practical consequence: `/api/sync` is roughly 800 lines of conflict semantics that clients
depend on and that no client re-implements. Anything claiming to be API-compatible has to reproduce
the field-level clocks, not just the row upsert.

### 2.2 Replica sync (the newest, CRDT, and the one that quietly keeps Readest Cloud in the loop)

About 4000 lines across `services/sync/replica*.ts`, `libs/replicaSync{Client,Server}.ts`,
`libs/replicaSchemas.ts`, `libs/crdt.ts`, `libs/hlcStore.ts`, and two API routes.

`libs/crdt.README.md` states the model: hybrid logical clocks packed as
`0000018e7d6ab5c0-00000007-device-uuid` so lexicographic string order matches temporal order,
per-field LWW envelopes `{ v, t, s }`, and remove-wins tombstones where field writes do not revive
a tombstoned row (revival needs an explicit `withReincarnation` token).

Server merge is a Postgres function, not TypeScript: `pages/api/sync/replicas.ts:86` calls
`supabase.rpc('crdt_merge_replica', {...})` once per row. Migration `004_crdt_merge_replica_fn`
carries the body. Pull supports a batched form (`{ cursors: [...] }`) that collapses N per-kind
worker invocations into one, capped at 1000 rows per kind, ordered by `updated_at_ts`.

Replica payloads can be encrypted client-side (`replicaCryptoMiddleware.ts`, 294 lines;
`passphraseGate.ts`, 274 lines) with salts fetched from `pages/api/sync/replica-keys.ts`, and large
bodies spill to object storage under `CLOUD_REPLICAS_SUBDIR` (`replicaBinaryUpload.ts`).

Note the endpoint-resolution difference from row sync: `libs/replicaSyncClient.ts:7` builds the URL
lazily, `const ENDPOINT = () => \`${getAPIBaseUrl()}/sync/replicas\``, while `libs/sync.ts:6`
computes its constant at module load. See section 8.

### 2.3 File sync providers (the seam upstream built for third parties)

`services/sync/file/provider.ts` (93 lines) defines `FileSyncProvider`: `readText`, `readBinary`,
`head`, `list`, `writeText`, `writeBinary`, `ensureDir`, `deleteDir`, plus optional
`uploadStream`/`downloadStream`, with a normalized `FileSyncErrorCode` of `AUTH_FAILED |
NOT_FOUND | NETWORK | CONFLICT | UNKNOWN`. The file's own comment says implementing a new backend
means writing one of these, validated against the shared conformance suite, and nothing else.

That suite exists: `src/__tests__/services/sync/file/provider-conformance.test.ts`, with a
semantic contract in `providerSemanticContract.ts` next to it.

Registration is one union plus one factory:
`services/sync/file/providerRegistry.ts:21` `FileSyncBackendKind = 'webdav' | 'gdrive' | 's3' |
'onedrive' | 'icloud'`, and `createFileSyncProvider` at `:76`.

The wire model and tree layout are explicitly frozen. `file/wire.ts` (182 lines) pins
`RemoteBookConfig` at `schemaVersion: 1` with `writerVersion: 'readest-webdav-1'`, and
`buildRemotePayload` trims config down to `{ progress, location, xpointer, updatedAt }`. View
settings stay device-local on purpose; `referencePageCount` is the single carve-out.
`file/layout.ts` (122 lines) freezes `<root>/Readest/library.json` and
`<root>/Readest/books/<hash>/{<title>.<ext>, cover.png, config.json, tts/}`.

The catch, and it is the important one for HOMEBASE.md: choosing a third-party provider does not
detach the app from Readest Cloud. `services/sync/cloudSyncProvider.ts:14` says account-level data
(settings replicas, reading stats, dictionaries and fonts, translations) always syncs via Readest
Cloud while signed in, regardless of the selection. `isReadestCloudEnabled` at `:70` defaults to
"on unless some third-party provider is enabled", but that only gates the book, config, and note
channels.

## 3. Configuration and endpoint surface

This is the part that decides how expensive a Homebase repoint is.

`services/environment.ts:15`:

```ts
export const getBaseUrl = () =>
  getRuntimeConfig()?.apiBaseUrl ??
  process.env['API_BASE_URL'] ??
  process.env['NEXT_PUBLIC_API_BASE_URL'] ??
  READEST_WEB_BASE_URL;
export const getAPIBaseUrl = () => (isWebDevMode() ? '/api' : `${getBaseUrl()}/api`);
```

`READEST_WEB_BASE_URL = 'https://web.readest.com'` (`services/constants.ts:885`).

`getRuntimeConfig()` reads `window.__READEST_RUNTIME_CONFIG`, injected by
`src/app/runtime-config.js/route.ts` with `Cache-Control: no-store` and
`export const dynamic = 'force-dynamic'`. `ReadestRuntimeConfig` (`services/runtimeConfig.ts:1`)
carries `supabaseUrl`, `supabaseAnonKey`, `apiBaseUrl`, `objectStorageType`, `storageFixedQuota`,
`translationFixedQuota`, `fontBaseUrl`.

This is runtime, not build time. A pulled stock image can be pointed at different Supabase and API
hosts with container env alone. `docker/README.md` states exactly that.

Supabase client URL and key resolve through `utils/supabase.ts`: runtime config, then `SUPABASE_URL`
/ `NEXT_PUBLIC_SUPABASE_URL`, then a base64-baked default. There are three clients: anon, per-token,
and admin (`SUPABASE_ADMIN_KEY`).

Object storage selects at `utils/storage.ts:5`, `getStorageType()` reading
`runtimeConfig.objectStorageType ?? process.env['OBJECT_STORAGE_TYPE']`, default `'r2'`. `utils/r2.ts`
signs with `aws4fetch`; `utils/s3.ts` uses `@aws-sdk/client-s3` with `forcePathStyle` and keeps a
separate signing client on `S3_PUBLIC_ENDPOINT` so presigned URLs carry a browser-reachable host
rather than an internal Docker name.

Client storage calls go through six endpoints built once at module load in `libs/storage.ts:14-20`
(`upload`, `download`, `delete`, `stats`, `list`, `purge`). Object keys are always
`${userId}/${cfp}`. `pages/api/storage/upload.ts` enforces quota, guards traversal with
`isSafeObjectKeyName()` (GHSA-mfmj-2frf-vhgw), writes `files`-table bookkeeping with the admin
client, then returns a 30-minute presigned PUT.

### Upstream already ships a self-host stack

`docker/compose.yaml` plus `docker/.env.example` and `docker/volumes/db/` run
`ghcr.io/readest/readest` against `supabase/postgres`, `supabase/gotrue:v2.185.0`,
`postgrest/postgrest:v14.3`, `kong:2.8.1`, and `minio/minio`. `.env.example` exposes
`POSTGRES_*`, `JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY`, `API_EXTERNAL_URL`, `SITE_URL`,
`DISABLE_SIGNUP`, `OBJECT_STORAGE_TYPE`, `MINIO_ROOT_*`, `S3_BUCKET_NAME`, `STORAGE_FIXED_QUOTA`,
`TRANSLATION_FIXED_QUOTA`, `FONT_BASE_URL`. Migrations apply through
`zz-readest-migrations.sh` and are tracked in `readest_meta.migrations`, with 19 numbered files from
`001_add_rsvp_position` through `019_stat_pages_upsert_rpc`.

The schema is small: `public.books` (PK `user_id, book_hash`), `public.book_configs`,
`public.book_notes` (PK `user_id, book_hash, id`), `public.files`, RLS on all four keyed to
`auth.uid() = user_id`, index `idx_books_user_synced`, and the `books_set_synced_at` trigger.

## 4. Auth, identity, and paywall

`utils/access.ts:154` `getAccessToken()` reads `localStorage.getItem('token')` on web and
`supabase.auth.getSession()` under Tauri. `validateUserAndToken(authHeader)` at `:174` calls
`supabase.auth.getUser(token)` and is the gate on every API route, including
`pages/api/sync/replicas.ts:20`.

Every server-side authorization decision therefore terminates in a Supabase JWT check. A Homebase
backend either issues Supabase-compatible JWTs (self-hosted GoTrue does) or replaces this function.

Paywall flags are hard-coded booleans a fork can flip: `utils/access.ts:68`
`CLOUD_SYNC_REQUIRES_PREMIUM = true` and `:96` `TTS_CACHE_REQUIRES_PREMIUM = true`. Plan and quota
come from JWT custom claims (`plan`, `storage_usage_bytes`, `storage_purchased_bytes`).

Book identity is content-derived and cheap to reproduce:

- `utils/md5.ts:11` `partialMD5(file)` hashes 1 KB windows at offsets `step << (2 * i)` for
  `i = -1 .. 10`, concatenated in order.
- `utils/book.ts:458` `metaHash = md5(\`${title}|${authors}|${identifiers}\`.normalize('NFC'))`,
  with `|${filename}` appended for PDFs (#5411).
- `services/bookService.ts:575` picks native hash, `partialMD5`, or a direct md5 for streams.

## 5. Other consumers and boundaries

**KOSync.** `services/sync/KOSyncClient.ts` (316 lines) speaks the KOReader protocol:
`X-Auth-User` / `X-Auth-Key` (`:79`), retried as HTTP Basic on 401 or 400 because CWA answers 400
for an auth failure, auto-registration with `md5(password)`, endpoints `/users/auth`,
`/users/create`, `/syncs/progress/<digest>`. On LAN or under Tauri it fetches directly, with
`acceptInvalidCerts: true` on the Tauri path (`:102`); a non-LAN web client proxies through
`${getAPIBaseUrl()}/kosync` (`:108`).

Two constraints fall out of this:

1. `getDocumentDigest` (`:310`) returns `book.hash`, which is Readest's `partialMD5`, and warns that
   the `filename` method "is not possible anymore". KOReader computes its own document digest.
   These do not agree, so a shared KOSync server does not line progress up between Readest and
   KOReader or CWA without a digest mapping on the server side.
2. `pages/api/kosync.ts` rejects private and internal addresses outright
   (`isLanAddress(serverUrl)` → 400) and allowlists only the three endpoint patterns. So a hosted
   Readest web client cannot reach a LAN KOSync server through the proxy at all, and a direct
   browser fetch from an HTTPS page to a plain-HTTP LAN host is mixed-content blocked. LAN KOSync
   works from Tauri, and from a browser only if Homebase serves it over HTTPS with CORS.

**Tauri.** `src-tauri/capabilities/default.json` already allows `http://*:*`, `https://*:*`,
`http://*`, and `https://*` under `http:default`, and `tauri.conf.json` `connect-src` includes
`http://*:*` and `https://*:*`. An arbitrary Homebase host needs no capability or CSP edit. Storage
on Tauri goes through `tauriUpload`/`tauriDownload` in `libs/storage.ts` rather than the web paths.

**Telemetry.** PostHog (`utils/telemetry.ts`, `context/PHContext.tsx`) keyed by
`NEXT_PUBLIC_POSTHOG_KEY` / `NEXT_PUBLIC_POSTHOG_HOST`, initialized with
`opt_out_capturing_by_default: shouldOptOutAtBoot()`, opt-out persisted in `localStorage` under
`readest-telemetry-opt-out`, and only 10 percent of new users see the consent prompt
(`TELEMETRY_PROMPT_BUCKET_RATE = 0.1`); the rest are opted out silently. Sentry is wired through
`@sentry/cli` and `scripts/upload-sourcemaps.mjs`. Both are unset-key no-ops, so a Homebase build
that leaves the env vars empty ships no telemetry.

**Tests.** 842 test files under `src/__tests__/`, with 40-plus touching sync directly, including
`services/sync/replica*.test.ts`, `KOSyncClient.test.ts`, `cloudSyncProvider.test.ts`,
`file/provider-conformance.test.ts`, `file/providerRegistry.test.ts`, `file/layout.test.ts`, and
`libs/crdt.test.ts` with its 1000-sample HLC ordering property test. Runners are Vitest (jsdom and
a separate `vitest.browser.config.mts` on Chromium), Playwright, and WebdriverIO, driven from
`pnpm test`, `pnpm test:browser`, and `pnpm test:tauri`.

**Second and third API consumers.** `apps/readest.koplugin` (Lua, in KOReader) and
`apps/readest-calibre-plugin` both call `/api/sync` directly. Any wire change has to hold for
them, not only for the TypeScript client. The `main` branch tip is literally a koplugin paging fix
(#5833).

## 6. Seam inventory, measured

| Seam | Where | Size of a Homebase change | Merge exposure |
| --- | --- | --- | --- |
| Runtime config repoint | container env only | 0 lines | none |
| Object storage backend | `OBJECT_STORAGE_TYPE=s3` plus `S3_*` env | 0 lines | none |
| `FileSyncProvider` implementation | new dir under `services/sync/providers/`, one union member at `providerRegistry.ts:21`, one branch in `createFileSyncProvider` (`:76`), one settings type | roughly 2 edited lines in shipping files, plus new files | very low; the union line is the only common merge target |
| Row-sync client swap | `context/SyncContext.tsx:6` | 1 line | very low |
| Row-sync server | `pages/api/sync.ts` | replaces 842 lines of merge logic | high if forked, zero if hosted separately |
| Auth | `utils/access.ts:174` | 1 function | medium; the file also holds paywall logic that upstream edits |

Two facts make the first two rows more interesting than they look. Configuration is resolved at
runtime from an injected global, so a stock upstream image is repointable without a rebuild. And
`utils/s3.ts` already solves the split-horizon problem that self-hosting creates, by signing on
`S3_PUBLIC_ENDPOINT` while talking to `S3_ENDPOINT`.

The spike in the working tree takes the fourth row and generalizes it: `HomebaseSyncAdapter` in
`services/sync/homebase/adapter.ts` is a `pull`/`push`/`capabilities` transport modelled on
`FileSyncProvider`, with a `HomebaseSyncError` code set matching `FileSyncErrorCode`. Its own header
comment names the problem correctly, that `libs/sync.ts` hard-codes both the endpoint and a Supabase
bearer token. It is worth noting that this design carries the same cost as option (b) below,
because a real landing needs `SyncContext` to choose between clients and needs the field-level clock
rules from `pages/api/sync.ts` reproduced on the Homebase side (the spike's `clocks.ts` is that
attempt).

## 7. Option comparison

### (a) API-compatible backend

Homebase serves the same routes the app already calls; the app is repointed with env.

Upstream ships and documents this path, which is the decisive fact. `docker/compose.yaml` proves
the app runs against a non-Readest Supabase and non-R2 storage today. Merge surface is zero,
because no shipping file changes. The koplugin and Calibre plugin keep working unmodified.

The cost is real and lands on the server: Homebase must reproduce `/api/sync`'s field-level merge
(`resolveReadingStatusMerge`, `resolveCoverMerge`, `resolveMetadataMerge`,
`buildStatusPropagationRow`), the `synced_at` trigger cursor, 1000-row paging with millisecond
completion, `upsert_stat_pages`, and, if replicas are in scope, `crdt_merge_replica` and the
replica-keys RPCs. Also, auth stays Supabase-shaped: either run GoTrue, or issue JWTs that
`supabase.auth.getUser()` accepts.

Two sub-variants differ a lot in cost. Running upstream's own compose stack and letting Homebase
read the Postgres tables is close to free. Writing a from-scratch service that mimics the API is
the most expensive option on this list.

### (b) Client SyncAdapter interface

Introduce a transport interface for the row channels, implement Homebase behind it, select at
`SyncContext.tsx:6`.

The construction site really is one line, and upstream has already validated the pattern once for
files. But the row channels are not like files. `FileSyncProvider` works because merge lives on the
client and the remote is dumb storage. For rows, merge lives on the server in
`pages/api/sync.ts`, so an adapter either ships a client-side reimplementation of those field
clocks or hands them to Homebase anyway, at which point most of option (a)'s server cost is still
owed. The adapter buys endpoint choice, not merge ownership. It also owns permanent maintenance of
a file upstream will keep editing around, and it does nothing for the koplugin or Calibre plugin,
which never touch this code.

### (c) Sidecar companion

A separate process syncs Homebase against Readest Cloud or a local store, with Readest untouched.

Zero merge surface, and it is the only option that keeps HOMEBASE.md's canonical-data rule with no
argument at all, because Readest stays a client of its own backend and Homebase reads a copy. But
it makes reading state eventually consistent through a third party, adds a component that has to be
run and monitored, and either depends on hosted Readest Cloud staying available or duplicates
option (a)'s backend anyway. It is a bridge, not a sync engine.

### (d) KOSync-only progress

Point Readest's KOSync client at Homebase or CWA and sync progress only.

Cheapest to stand up: the client exists, CWA already speaks the protocol, and the settings are
user-facing. It covers only reading position. Annotations, book files, covers, reading status,
configs, and stats stay wherever they were. And two concrete blockers apply, from section 5: the
digest is Readest's `partialMD5` rather than a KOReader document digest, so positions do not line
up with KOReader or CWA without a server-side mapping; and the web proxy refuses LAN addresses, so
a browser client needs Homebase to serve KOSync over HTTPS. Useful as a component. Not a sync
engine.

### (e) Upstream contribution

Land a Homebase backend kind in `readest/readest`.

The registry pattern makes a file-provider contribution plausible, and it would carry zero
long-term merge cost, since the code would be upstream. But `upstream` push is disabled in this
checkout, HOMEBASE.md's whole policy is built on `main` staying fast-forwardable, upstream has no
reason to accept a backend specific to one person's home server, and the review cycle gates
delivery on someone else's schedule. Reasonable eventually, for the generic parts only, and only
after something works locally.

## 8. Recommendation

Take (a), in its cheap sub-variant, and treat (d) as an optional add-on.

Concretely: run upstream's `docker/compose.yaml` stack under Homebase, with `OBJECT_STORAGE_TYPE=s3`
against Homebase's own MinIO or S3-compatible storage, and repoint the client through
`/runtime-config.js` with `apiBaseUrl`, `supabaseUrl`, and `supabaseAnonKey`. Homebase then owns the
Postgres that holds `books`, `book_configs`, `book_notes`, `replicas`, and `files`, and reads or
writes them directly alongside Calibre-Web Automated. Zero shipping files change, `main` stays
fast-forwardable, and the koplugin and Calibre plugin keep working.

This is smaller than any client-side seam, because it requires no line in any file that upstream
also edits, and it is the path upstream tests.

What it does not resolve on its own is HOMEBASE.md's rule that Readest must not become a second
source of truth. Owning the Postgres is necessary but not sufficient; the reconciliation direction
between that database and CWA still has to be decided, and section 2.3 shows account-level replica
data flows to whatever backend is configured regardless of provider selection.

If a client-side seam is wanted later, `FileSyncProvider` is the one to use, not a new row-sync
adapter. It costs about two lines in shipping files, upstream documents it as the extension point,
and a conformance suite already exists to test an implementation against.

## 9. Risks

1. **Merge semantics are not documented anywhere but the code.** The three field-level resolvers in
   `pages/api/sync.ts` were each added for a specific bug (#4634, #4544, #5438). Any Homebase-side
   reimplementation will reintroduce those bugs unless it ports the rules exactly. Reading upstream
   Postgres directly avoids this entirely.
2. **Upstream schema drift.** 19 migrations exist already and `main` moves. A self-hosted stack must
   run `zz-readest-migrations.sh` on upgrade, and Homebase queries against those tables break when
   upstream changes them. `readest_meta.migrations` is the thing to watch.
3. **Auth shape is load-bearing.** `validateUserAndToken` calls `supabase.auth.getUser()` on every
   route. Replacing Supabase auth means either running GoTrue or editing a file that also holds
   paywall logic upstream keeps changing.
4. **Account-level data still leaves.** Per `cloudSyncProvider.ts:14`, settings replicas, reading
   stats, dictionaries, fonts, and translations sync via the configured Readest Cloud while signed
   in, whatever provider is selected. After a repoint that destination is Homebase, which is the
   desired outcome, but it must be a deliberate decision and not a surprise.
5. **KOSync will not interoperate as-is.** `getDocumentDigest` returns `partialMD5`, not a KOReader
   digest. Progress from Readest and progress from KOReader or CWA land under different keys.
6. **Baked-in defaults hide misconfiguration.** `utils/supabase.ts` falls back to a base64-decoded
   Readest URL and key when neither runtime config nor env is set, so a partly configured deployment
   silently talks to hosted Readest rather than failing. Assert on boot that the resolved
   `supabaseUrl` and `apiBaseUrl` are the Homebase ones.
7. **Presigned-URL host mismatch.** `utils/s3.ts` needs `S3_PUBLIC_ENDPOINT` set to a
   browser-reachable host distinct from the internal `S3_ENDPOINT`, or uploads will be signed for a
   hostname clients cannot resolve.
8. **AGPL-3.0.** A network-served modified fork must offer corresponding source, per HOMEBASE.md.
   Repointing config alone is not a modification; forking `pages/api/sync.ts` is.
9. **Two other API consumers.** Any wire-level change must hold for the Lua koplugin and the Calibre
   plugin, neither of which shares the TypeScript client.
10. **Working-tree state changed during the audit** (section 1). Findings are pinned to
    `459d934a`; the untracked spike was left exactly as found.

## 10. Open question, needs a decision

Two contradictory patterns exist in this codebase for resolving the API base URL, and they behave
differently under a runtime repoint:

- `libs/sync.ts:6` computes `SYNC_API_ENDPOINT = getAPIBaseUrl() + '/sync'` once at module load.
  Same in `libs/storage.ts:14-20` for all six storage endpoints.
- `libs/replicaSyncClient.ts:7` computes it per call: `const ENDPOINT = () =>
  \`${getAPIBaseUrl()}/sync/replicas\``.

The eager form works only if the module is first imported after `window.__READEST_RUNTIME_CONFIG` is
set by `/runtime-config.js`. That ordering holds for the normal web boot, but it makes any
post-boot repoint (a settings toggle, a re-login against a different host, a test that swaps
config) silently ineffective for row sync and storage while working correctly for replicas.

Which pattern wins for Homebase work? Averaging them is not an option. Either the eager reads get
converted to lazy ones, which is a small edit to two shipping files and a permanent merge target,
or Homebase configuration is declared boot-time-only and the constraint gets written down. This
audit did not choose.
