# Homebase Readest fork

This fork tracks [`readest/readest`](https://github.com/readest/readest) for the Homebase Reader program.

## Branch policy

- `main` stays fast-forwardable from upstream for as long as possible.
- Homebase changes land on small `homebase/*` branches and are rebased onto current upstream before merging.
- The daily `Sync upstream Readest` workflow fast-forwards `main` only. It never force-pushes or auto-resolves divergence.
- Any divergence opens one issue for manual rebase and acceptance testing.

## Canonical data boundary

Calibre-Web Automated and Homebase remain the canonical library, identity, progress, and annotation systems. Readest is the reading client and sync adapter. Do not make Readest Cloud a second source of truth without an explicit architecture decision.

## License

Readest is AGPL-3.0. Modified network-served versions must offer their corresponding source to users. Preserve upstream notices and expose a visible source link in any deployed fork.

## Local checkout

`/Volumes/StudioExt/repos/personal/readest-homebase`

Remotes:

- `fork`: `https://github.com/aneym/readest.git`
- `upstream`: `https://github.com/readest/readest.git`, fetch only
