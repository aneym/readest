# Immersion reading in the Homebase fork

Companion to Homebase `docs/wiki/books/immersion-reading.md` (the full design: alignment, storage,
pairing, request API). This page covers what lives in the fork. Status 2026-09-27: in progress on
`agent/immersion-20260927`.

## What the fork already had

Upstream Readest (PR #5480, in this fork) plays EPUB 3 Media Overlays through Read Aloud: sentence
highlight, native ExoPlayer on Android, scrubber, speed, sleep timer, page-follow inside a sentence.
See `apps/readest-app/docs/read-along-narration.md`. Homebase produces those EPUBs with Storyteller and
swaps them into Calibre in place, so a narrated book arrives through the normal Homebase shelf.

## What the fork adds

| Piece | Files | Notes |
|---|---|---|
| API client | `src/services/homebase/immersion/{client,types}.ts` | `/api/readest/immersion/*` with the paired device token. Types mirror Homebase `server/immersion/types.ts`. |
| Request sheet | `src/app/library/components/RequestBookSheet.tsx`, `request/*` | Entry: first item "Get a book…" in the `+` menu, and a row under empty library search results. |
| Shelf status | `src/store/immersionStore.ts`, `BookItem.tsx`, `useHomebaseBookDownloads.ts` | Pair chips from `GET status`; `hasNarration` set after a Homebase download (Homebase books never pass `importBook`). |
| E-ink narration highlight | `annotatorUtil.ts`, `useTTSControl.ts`, `TTSController.ts`, `TTSPanel.tsx` | B/W e-ink default is a 3px ink underline, stored separately as `ttsHighlightOptionsEink`. |
| Listen affordance | `NavigationBar.tsx`, `TTSPlayerSheet.tsx` | Headphones + "Listen" for narrated books; sheet title "Listen" while narrating. |

## UI rules (design seat, 2026-09-27)

- State is always words, never colour alone. "You need to act" is an inverted chip (`eink-inverted
  bg-base-content text-base-100`); passive progress is an outlined chip. No accent stripes.
- On B/W e-ink, percentages round down to a multiple of 5 to limit refreshes. No shimmer skeletons.
- Narration steps once per SMIL clip (sentence); the underline changes a 3px strip per line, which ghosts
  far less than inverting a block.

### Request sheet copy

| Situation | Copy |
|---|---|
| Tabs | "Find", "Requests (n)" |
| Loading | "Searching…" |
| Empty | "No matches for "{q}". Try the author's name." |
| Error | "Couldn't reach Homebase." + "Try again" |
| Offline | "You're offline. Requests need a connection." |
| Not configured | "Connect Homebase in Settings to request books." |
| No requests | "Nothing requested yet." |
| POST failed | "Couldn't send. Try again." |

Half labels: have "In library", missing "Not in library", requested "Requested", acquiring
"Downloading", failed "Failed: {detail}".

Actions: both halves gettable → **Get both** (want `pair`) plus "Ebook only", "Audio only"; one half
gettable → **Get ebook** / **Get audiobook** (a failed half reads "Retry …"); pair `candidate` →
**Confirm match**; pair `ready-to-swap` → **Use narrated edition** (both call `confirm`); pair `failed` →
**Retry alignment**.

Pair status lines: queued "Waiting to align"; aligning "Aligning {p}%"; candidate "Check the match";
ready-to-swap "Narration ready"; aligned "Narrated"; failed "Alignment failed".

Cover chips (grid, bottom-start): queued "Queued"; aligning "{p}%"; candidate "Check"; ready-to-swap
"Ready"; failed "Failed"; none and aligned show no chip. Needs-action chips open the sheet on Requests.
List mode shows a text line instead ("Narration: aligning 40%").

## Tests

Focused only (see `dev-loop.md`): `pnpm exec dotenv -e .env -- vitest run src/__tests__/app/library
src/__tests__/services/homebase src/__tests__/services/tts --maxWorkers=2`.
