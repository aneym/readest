# Vendored Homebase fixtures

Authored by `homebase-reading-sync-opus`, copied verbatim from

```
/Volumes/StudioExt/repos/personal/homebase/docs/work/homebase-reader/readest-homebase/fixtures/
```

on 2026-08-28, when that directory was still untracked (`git status` reported `??`)
and the homebase repo was at `48f96242`.

Only the five files the CLIENT can be held to are here. The rest of that
directory is server-side: `kosync-firewall.json`, `progress-guard.json`,
`locator-classification.json`, `query-parsing.json` and `identity.json` describe
what Homebase must do with what it receives, and no assertion about them belongs
in a Readest test.

| File | What the client owes it |
| --- | --- |
| `pull-books.json` | `decodeEnvelope` relays every field, both halves, unmodified |
| `push-configs.json` | `encodeConfig` produces the snake_case identity half Homebase keys on |
| `push-notes.json` | same for `encodeNote`, and a note keeps its own ULID |
| `merge-cases.json` | `resolveAnnotation` picks the same winner on all seven rungs |
| `voice-roundtrip.json` | `hb*` fields survive a round trip through the wire |

`fixture-conformance.test.ts` replays them and also diffs this copy against the
sibling repo when that path exists, so drift shows up as a failure rather than a
test that passes against a stale snapshot. When the sibling repo is not mounted
the diff test skips; the replays still run.
