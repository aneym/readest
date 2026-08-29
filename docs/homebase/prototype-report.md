# Homebase sync adapter: prototype report

An executable spike, not a landing. Twenty-one new files live under two `homebase/` directories,
no shipping file was edited, and the flag that would activate any of it defaults to off. Every
claim below cites a path and, where it rests on a specific construct, a line number.

Read `source-audit.md` first if you have not. It is the read-only survey this spike was built
against, and section 8 of it recommends a different option than the one prototyped here. Section 13
below explains why both documents can be right.

## 1. Provenance

| Fact | Value |
| --- | --- |
| Checkout | `/Volumes/StudioExt/repos/personal/readest-homebase` |
| Branch | `homebase/sync-adapter-spike`, no upstream tracking |
| HEAD | `459d934a01214f915cdb8c0339182f4b8026d38d` `chore(homebase): establish upstream-sync fork policy` |
| Commits made | none |
| Working tree | three untracked paths, all created by this spike: `apps/readest-app/src/services/sync/homebase/`, `apps/readest-app/src/__tests__/services/sync/homebase/`, `docs/` |
| Shipping files edited | none |
| Fixture source | `homebase` repo at `48f96242`, `docs/work/homebase-reader/readest-homebase/fixtures/`, untracked there (`??`) on 2026-08-28 |
| App | `@readest/readest-app` 0.12.1, pnpm 11.1.1, vitest 4.1.10 |

The spike is inert. `rg -l "sync/homebase" apps/readest-app/src --glob '!**/homebase/**'` returns
nothing, so no shipping module imports it, and `isHomebaseSyncEnabled()` requires both a base URL
and an explicit opt-in flag before it returns true (`services/sync/homebase/config.ts:60-67`).

## 2. The seam

`libs/sync.ts` exports a concrete `SyncClient` class. Two places consume it:

- `context/SyncContext.tsx:6` constructs one and hands it to every reader surface through
  `useSyncContext()`.
- `services/statistics/statsSync.ts:5-6` already depends on it structurally, as
  `Pick<SyncClient, 'pushChanges'>`.

So the seam is a two-method structural interface, and upstream already wrote half of it.
`RecordSyncClient` (`recordSyncClient.ts:40-49`) declares `pullChanges` and `pushChanges` with
signatures copied from `SyncClient` exactly, so `SyncClient` satisfies it without being modified.
`StockClientConformsToSeam` (`recordSyncClient.ts:52`) is a type alias that fails to compile if that
ever stops being true.

Routing books, configs, notes and stats to Homebase is then one line:

```diff
  // src/context/SyncContext.tsx
- const syncClient = new SyncClient();
+ const syncClient = resolveRecordSyncClient();
```

That line is not in the tree. `seam.test.ts` proves both halves of the claim without it being
applied: the type-level conformance, and the runtime drop-in where `resolveRecordSyncClient()`
returns a real `SyncClient` when Homebase is unconfigured.

### Configuration

`config.ts` mirrors `services/runtimeConfig.ts`, so a Homebase deployment configures this the same
way it already configures the Readest API: runtime config first, then env, then nothing.

| Setting | Runtime config | Env |
| --- | --- | --- |
| Base URL | `homebaseApiBaseUrl` | `HOMEBASE_API_BASE_URL`, `NEXT_PUBLIC_HOMEBASE_API_BASE_URL` |
| Opt-in | `homebaseSyncEnabled: true` | `HOMEBASE_SYNC_ENABLED`, `NEXT_PUBLIC_HOMEBASE_SYNC_ENABLED` (`1` or `true`) |

Defaults: `/reader/sync`, `/reader/storage`, 15s timeout matching `SyncClient`'s.

Requiring the flag on top of the URL is deliberate. A deployment can stage the endpoint, run health
checks, replay fixtures against it, and only then route real reading data. A misconfigured Homebase
falls back to `new SyncClient()`, which is not a degraded mode. It is the current product.

## 3. The push/pull asymmetry, and why the adapter backfills

This is the finding that shaped the whole wire layer, and it contradicts a claim I made earlier in
this work.

The types suggest symmetry. `interface BookRecord extends BookDataRecord, Book` (`libs/sync.ts:11`)
and `SyncData.books?: Partial<BookRecord>[]` (`libs/sync.ts:47`) let a record carry the snake_case
identity half and the camelCase app half together. At runtime the two directions differ:

- **Push.** `useSync.pushChanges` hands the client raw `Book[]`, `BookConfig[]` and `BookNote[]`
  objects (`useSync.ts:288`, `:309`, `:334`), and `useSync.ts:262` is a bare
  `syncClient.pushChanges(payload)` with no transform. The camelCase half only. A `Book` has
  `hash`. It has no `book_hash` at all. Readest's own server survives this because it runs
  `transformBookToDB` on arrival (`pages/api/sync.ts:148`).
- **Pull.** The server returns the merged record with both halves, and `useSync.ts:11,18` maps
  `transformBookFromDB` over the result itself.

Homebase keys its writes on `book_hash` (`push-configs.json`, `push-notes.json`). Point a stock
Readest at it and every push arrives with `book_hash: undefined`, which upserts nothing or matches
nothing and answers 200 either way. No amount of server-side care fixes that from the far end.

So the adapter's push job is an identity **backfill**, not a transform and not a pass-through
(`wire.ts:125-173`). Four fields, copied across only when the snake_case side is missing:

| Target | Source | Matches |
| --- | --- | --- |
| `book_hash` | `hash` on books, `bookHash` on configs and notes | `transformBookToDB`, `transformBookConfigToDB`, `transformBookNoteToDB` |
| `meta_hash` | `metaHash` | same |
| `updated_at` | `updatedAt` | same |
| `deleted_at` | `deletedAt`, else forced to `null` | same |

An existing snake_case value always wins, so a pull-then-push round trip cannot have its identity
rewritten by a camelCase field that drifted. `deleted_at` is forced to `null` rather than left
absent because every fixture row states it explicitly, and an absent column reads as "no opinion"
to an upserting server.

Books and configs also get `id` backfilled from `book_hash`, because they are one row per book.
Notes are excluded: they upsert on `(book_hash, id)`, and collapsing the id would merge every
annotation in a book into a single row.

Nothing in `wire.ts` imports `utils/transform.ts`. A second camelCase-to-snake_case conversion on
the client would be one more place for the two dialects to drift.

Three smaller jobs ride along in the same file:

1. A device-local deny-list (`wire.ts:65-75`). `filePath` and `altFilePaths` are one machine's disk
   layout, `audiobook` is a per-device pairing Readest already excludes from cloud sync, and the
   `lastSyncedAt*` / `lastPushedAt*` pairs are this install's own cursors. Pushing those would let
   one device rewind another's sync state.
2. `updated_at_ms`, the stats pull cursor, stripped on push and attached on pull.
3. Clock coercion to epoch ms, so a server that answers in ISO cannot make the merge sort
   lexicographically.

`user_id` is relayed when the app already holds one and never invented. Homebase must still
attribute writes from the bearer token; a client-asserted owner is a privilege bug the moment
anything trusts it.

## 4. Two clock dialects

Readest does not use one timestamp format. It uses two, and the split runs along family lines
(`libs/sync.ts:15-34`, `types/book.ts:624`):

| Family | `updated_at` | Cursor |
| --- | --- | --- |
| books, configs, notes | epoch ms, alongside `createdAt` / `updatedAt` / `deletedAt` | server-stamped ISO `synced_at` |
| statBooks, statPages | ISO string | numeric `updated_at_ms`, response-only |

`StatBookRecord` and `StatPageRecord` carry no `synced_at` and no `meta_hash`. `pullStats` reduces
over `updated_at_ms` to advance its cursor (`statsSync.ts:89`), so an adapter that forgot to attach
it would leave the cursor pinned and re-pull the whole history on every sync, silently, because the
loop's own break condition would fire on the first page forever. `wire.ts:208-216` attaches it.

The practical consequence for anyone writing tests here: a literal like
`{ book_hash, updated_at: '2026-08-01T00:00:00Z' }` does not typecheck as a book. A string
`updated_at` collapses the `HomebaseRecord` union to the stat families, whose required fields are
then missing. Use epoch ms for the first three families.

## 5. Merge, tombstones, and the three field clocks

`clocks.ts` keeps two authorities apart on purpose, because they do not resolve the same way.

**Readest's per-field book clocks.** Three of them, each added upstream for a specific bug, because
a page-turn bumps `updatedAt` constantly and would otherwise clobber an edit made on another
device:

| Group | Clock | Fields | Tie goes to |
| --- | --- | --- | --- |
| readingStatus | `readingStatusUpdatedAt` (#4634) | `readingStatus` | client |
| cover | `coverUpdatedAt` (#4544) | `coverHash`, `coverImageUrl` | client |
| metadata | `metadataUpdatedAt` (#5438) | `title`, `author`, `tags`, `metadata` | the row winner |

`mergeBookRecord` picks the row winner on `updated_at` (ties to the client, matching Readest's
server), then grafts each group on from whichever side owns it. Metadata defers to the row on a tie
so unstamped legacy rows keep their historical whole-row behaviour, instead of letting a stale push
graft its metadata onto a newer server row.

Tombstones are not a clock group. A delete is decided by the row clock and a `deleted_at` on the
winning side carries through as-is. Undeleting is a fresh write with a newer `updated_at` and
`deleted_at: null`, which the same rule handles with no special case. The semantic contract asserts
that a pull returns tombstoned rows rather than filtering them
(`adapterSemanticContract.ts:70-80`), against every transport, because a peer that never sees the
delete keeps the row forever.

**Homebase's annotation ladder**, pinned by `merge-cases.json` and implemented in
`resolveAnnotation` (`clocks.ts:168-192`), in order: different profile keeps local; newer
`updated_at`; higher `deviceSeq`; higher device id by string compare; total tie keeps local. The
last two rungs exist for an outbox draining several edits inside one millisecond.

The client needs Readest's rules even though the server also runs them, because two merges happen
on-device with no server in the loop: the outbox coalescing several local edits before a push, and
reconciling a pull against unpushed local state. Both must agree with the server's answer.

## 6. The offline outbox

Readest's stock client has no outbox. `useSync.pushChanges` catches the error, sets `syncError`,
and the write is gone until something else touches the same record. That survives against Readest
Cloud because the reader re-pushes a book's config on most interactions. It does not survive for a
canonical household store. A highlight made on a train is a highlight the ledger must eventually
get.

`outbox.ts` adds three rules, in the order they matter:

1. **Coalesce.** One entry per `(channel, primary key)`. Twenty minutes of offline page-turns is one
   row whose `updated_at` moved, not 400 queued rows. Coalescing uses the same clocks the server
   uses, so it cannot pick a different winner than a server-side merge would have.
2. **Order.** Flush is sequential and stops at the first retryable failure. Draining past a failure
   would let a later write land before an earlier one, and the server's LWW would then keep the
   wrong row.
3. **Bound.** `maxAttempts` poisons an entry that keeps failing permanently, so one malformed record
   cannot wedge the queue forever. Poisoned entries are surfaced, not silently dropped.

This is why the error contract distinguishes retryable from permanent (`adapter.ts:20-43`). Codes
are `AUTH_FAILED`, `NOT_FOUND`, `NETWORK`, `CONFLICT`, `RATE_LIMITED`, `UNKNOWN`; only `NETWORK`
and `RATE_LIMITED` retry by default. A revoked token that retried forever is how an outbox wedges;
an offline failure marked permanent is how the outbox poisons a perfectly good highlight. Both
cases are asserted against both adapters.

The store is injectable. The spike runs in memory, which loses on restart. A landing persists to
wherever `useSync` already writes settings.

## 7. Audio notes: the `hb*` extension point

Homebase carries fields on an annotation that Readest has no schema for: a voice note's audio
pointer, its duration, its transcript provenance. `voice-roundtrip.json` is the fixture for a watch
voice note passing through an unmodified reader.

The extension point is a prefix, not a nested object. `HomebaseAudioFields` declares `hbKind`,
`hbAudioSha256`, `hbAudioDurationMs` and `hbTranscriptSource` (`types.ts:75-83`), and
`HomebaseExtFields` is `Record<` `` `hb${string}` `` `, unknown>` (`types.ts:86`), which accepts any
future sibling. `encodeRecord`
relays every field it does not recognise, so a new `hb*` field needs no client release.

Two behaviours matter and both are tested:

- A client that speaks `hb` sends the fields back instead of dropping them, which turns Homebase's
  server-side re-attach into a safety net rather than the only thing standing between a voice note
  and silence.
- When an unmodified client does strip them, `resolveAnnotation` backfills the winner's `hb*` fields
  from the local row, but only where the winner states none. An incoming row that carries `hb`
  fields is a modified client speaking for itself and is left alone. A stale push still cannot
  resurrect a pre-edit transcript, because the ladder resolves on time first.

`storage.ts` gives audio its own lane. `HomebaseObjectClass` is `'book' | 'cover' | 'replica' |
'note-audio'`, named explicitly instead of derived from a path prefix the way Readest does with
`CLOUD_BOOKS_SUBDIR`. That lets Homebase apply per-kind retention and quota without a convention
nobody can enforce.

## 8. Storage

`libs/storage.ts` is module-level functions bound to `getAPIBaseUrl() + '/storage/*'`. Four
operations carry everything: presign an upload, resolve a download URL, delete an object, list
objects. The spike's interface presigns too, deliberately. Readest's client never streams bytes
through the API; it asks for a URL and hands it to `tauriUpload` / `webUpload`, which is what makes
a 400MB audiobook survive a mobile upload. An adapter that proxied bytes through its own API would
regress that.

`HomebaseUploadTarget` carries an absolute `expiresAt` in epoch ms. A stale target must be
re-presigned, not retried.

## 9. KOSync stays untouched

`services/sync/KOSyncClient.ts` speaks its own protocol (`X-Auth-User` / `X-Auth-Key`, document id
= partial MD5) to its own server and shares nothing with `SyncClient`. Nothing in the spike imports
it, references it, or changes its configuration. KOReader-compatible progress keeps flowing through
it whichever record backend is selected, which is what the brief asked for.

`homebase-kosync-isolation.test.ts` asserts this rather than trusting it, because "these two are
unrelated" is exactly the kind of claim that stops being true after one convenience refactor.

## 10. What the fixtures pinned

Five of the thirteen fixtures from `homebase-reading-sync-opus` are vendored into
`src/__tests__/services/sync/homebase/fixtures/` and replayed by `fixture-conformance.test.ts` (39
tests). These came from the other side of the wire, which is the point. Every other test in that
directory was written against my own reading of the protocol, and that kind of test agrees with
itself and with nothing else.

| Fixture | What the client owes it |
| --- | --- |
| `pull-books.json` | `decodeEnvelope` relays every field, both halves. Full `toEqual`, not a subset match: a pull that drops `synced_at` pins the cursor, one that drops `uploaded_at` makes a book show as indexed but unavailable |
| `push-configs.json` | `encodeConfig` produces the identity half Homebase keys on, from the camelCase half alone |
| `push-notes.json` | same for `encodeNote`, and a note keeps its own ULID; locator dialects relay untouched |
| `merge-cases.json` | `resolveAnnotation` picks the same winner on all seven rungs |
| `voice-roundtrip.json` | `hb*` fields survive a round trip through the wire |

The other eight are server-side and no assertion about them belongs in a Readest test:
`kosync-firewall.json`, `progress-guard.json`, `locator-classification.json`, `query-parsing.json`,
`identity.json`.

Two deliberate non-behaviours are worth stating, because they look like gaps:

- The client still sends the `expect.ok: false` cases in `push-configs.json` and `push-notes.json`.
  A client that pre-filtered them would hide a broken device instead of letting Homebase report
  `bad-clock` or `bad-file-hash` back.
- The client does not normalise locators. Homebase classifies epubcfi, xpointer and pdf-page itself.
  A client that normalised them would be deciding the classification, and would get the
  reflowable-versus-paged distinction wrong, because it cannot see it.

The last test in the file diffs the vendored copy against the sibling repo when that path is
mounted, so drift fails loudly instead of passing against a stale snapshot. It skips when the repo
is not mounted; the replays still run.

## 11. File inventory

Nothing here is imported by shipping code. Twenty-one files, 3,758 lines, plus five JSON fixtures
and a README.

**`apps/readest-app/src/services/sync/homebase/` (11 files, 1,761 lines)**

| File | Lines | What it is |
| --- | --- | --- |
| `types.ts` | 138 | Wire record shapes, channel list, `HOMEBASE_WIRE_VERSION = 1`, the `hb*` extension types |
| `config.ts` | 83 | Endpoint resolution and the two-part opt-in |
| `wire.ts` | 239 | Identity backfill, device-local deny-list, clock coercion, envelope encode/decode |
| `clocks.ts` | 192 | The three book field clocks, row LWW, the annotation ladder |
| `adapter.ts` | 104 | `HomebaseSyncAdapter` transport interface and `HomebaseSyncError` |
| `httpAdapter.ts` | 136 | The HTTP implementation, status-to-code mapping, capabilities probe |
| `memoryAdapter.ts` | 267 | An in-process reference server that merges the way Homebase must |
| `outbox.ts` | 199 | Coalescing, ordered, bounded offline queue |
| `recordSyncClient.ts` | 131 | The seam interface and `HomebaseSyncClient` |
| `storage.ts` | 212 | Presign / download / delete / list, with `note-audio` as its own class |
| `index.ts` | 60 | `resolveRecordSyncClient`, the one function a landing would call |

**`apps/readest-app/src/__tests__/services/sync/homebase/` (10 files, 1,997 lines)**

| File | Lines | What it covers |
| --- | --- | --- |
| `wire.test.ts` | 328 | Encode/decode, the backfill, the deny-list, tombstones |
| `clocks.test.ts` | 240 | Field clocks, ties, the ladder, `hb*` re-attach |
| `spike-e2e.test.ts` | 221 | Real loopback HTTP server, real HTTP adapter, memory backend |
| `fixture-conformance.test.ts` | 216 | The five vendored fixtures, plus the drift diff |
| `adapter-conformance.test.ts` | 209 | Runs the semantic contract against both adapters |
| `outbox.test.ts` | 205 | Coalescing, ordering, poisoning |
| `seam.test.ts` | 167 | Type-level and runtime drop-in for `SyncClient` |
| `storage.test.ts` | 164 | Presign flow, object classes, expiry |
| `homebase-kosync-isolation.test.ts` | 127 | KOSync is not touched |
| `adapterSemanticContract.ts` | 120 | The shared contract itself, modelled on `providerSemanticContract.ts` |

Plus `fixtures/` (5 JSON + `README.md` recording provenance and the exclusions).

**`docs/homebase/`**: `source-audit.md` (the prior read-only survey) and this report.

## 12. Checks run

All from `apps/readest-app` unless noted. `pnpm test -- --run <path>` silently drops the path filter
and runs all 810 files, so the runs below invoke vitest directly.

| Check | Command | Result |
| --- | --- | --- |
| Unit tests | `npx dotenv -e .env -e .env.test.local -- npx vitest run src/__tests__/services/sync/homebase` | 9 files, 161 tests passed, 908ms |
| Fixture conformance alone | same, `.../fixture-conformance.test.ts` | 39 passed |
| Typecheck | `NODE_OPTIONS='--max-old-space-size=4096' npx tsgo --noEmit` | clean apart from two pre-existing failures |
| Lint | `npx biome lint src/services/sync/homebase src/__tests__/services/sync/homebase` | no issues found |
| Format | `npx biome format` from the repo root, which is what `format:check` uses | no issues found, exit 0 |
| Leakage | `rg -l "sync/homebase" apps/readest-app/src --glob '!**/homebase/**'` | no matches |

The two typecheck failures are `Cannot find module '@simplecc/simplecc_wasm'` in
`src/utils/simplecc.ts(1,32)` and `src/__tests__/utils/simplecc.test.ts(2,32)`. They are an
uninitialised WASM submodule in this checkout and predate the spike.

Biome behaves differently depending on where it is invoked. `npx biome format` from
`apps/readest-app` reports a confusing "Lint: 2 errors" and an npm error; from the repo root it is
clean. Use the root.

### The tests were mutation-checked

Green tests written alongside the code they test prove very little. To check these bite, the
identity backfill was disabled and the suite re-run: 17 of the 39 fixture-conformance tests failed.
`wire.ts` was then restored from a backup and verified byte-identical by `diff`.

## 13. Open questions

1. **The wire is proposed, not agreed.** `GET {base}/reader/sync?since=&type=&book=&meta_hash=&limit=`,
   `POST {base}/reader/sync`, `GET {base}/reader/sync/capabilities`. That shape was written before
   the fixtures existed. The fixtures pinned the record shapes and the merge rules, and the spike now
   matches them, but they say nothing about paths, query parameters or the capabilities probe.
   Someone on the Homebase side has to confirm or replace those.
2. **Token source.** `httpAdapter` takes `getToken` as an injected dependency and `index.ts` defaults
   it to `utils/access.getAccessToken`, which is the Supabase session token. That default is almost
   certainly wrong: a Homebase deployment issues its own tokens. The injection point is right; the
   default needs a decision.
3. **Outbox persistence.** In-memory today, so a restart during an offline window loses the queue.
   A landing has to pick a store, and `useSync`'s existing settings path is the obvious candidate.
4. **`clientId`.** Defaults to the literal `'readest-unknown-device'`. Homebase uses it to attribute
   a write to a device and to suppress echoing a client's own push back to it, so a real per-install
   id has to come from somewhere.
5. **This is not the audit's recommendation.** `source-audit.md` section 8 recommends running
   upstream's own Docker stack against Homebase-owned Postgres and repointing the client through
   `/runtime-config.js`, on the grounds that it costs zero lines in files upstream also edits. That
   is still the cheaper path if Homebase can live with Readest's schema and merge semantics. The
   seam prototyped here is the answer to a different question: what it costs to route records to an
   API that is not Readest's. The brief asked for that, so it was built and measured. Section 14 is
   the measurement.

## 14. What a landing would actually cost

One line in `SyncContext.tsx`, and three small edits that are not strictly required but would
remove casts:

- `ReadestRuntimeConfig` gains two optional fields, `homebaseApiBaseUrl` and `homebaseSyncEnabled`,
  which deletes the structural cast in `config.ts:37-42`.
- `libs/sync.ts` exports `SyncClient`'s two-method shape as an interface, which deletes
  `RecordSyncClient` from the spike and makes `statsSync.ts`'s `Pick<>` unnecessary.
- Whatever store the outbox persists to.

The rest is additive: the whole `services/sync/homebase/` directory and its tests. Merge conflicts
with upstream would be confined to the one line in `SyncContext.tsx` and the two runtime-config
fields, which is the property that makes this reviewable as a fork.

What it does not resolve, and what no client-side seam can resolve, is HOMEBASE.md's rule that
Readest must not become a second source of truth. Owning the records is necessary and not
sufficient. The reconciliation direction between Homebase and Calibre-Web Automated still has to be
decided, and `source-audit.md` section 2.3 shows account-level replica data flows to whatever
backend is configured regardless of which record client is selected.
