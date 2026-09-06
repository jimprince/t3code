# Fork release-note entries

Each file here is one small, immutable announcement for a fork feature, fix,
performance change, maintenance change, or removal. `scripts/ci/render-release-notes`
renders the ones that are new since the previous fork release tag into the
GitHub release body, ahead of and separate from upstream's own commit list.

## Adding an entry

Create `docs/release-notes/entries/<id>.toml` alongside the patch that owns
the functionality (see `LLM_INSTRUCTIONS.md` Route B):

```toml
id = "gitea-pr-checkout"
category = "feature"
functionality = "source-control"
text = "Create and check out Gitea pull requests from the source control panel."
```

- `id` is the entry's stable identity. It must be lowercase kebab-case and
  match the filename exactly. Never reuse or rename an id once it has shipped
  in a release — selection is based on id presence, not content, so a rename
  reads as a brand new, unannounced entry.
- `category` is one of `feature`, `fix`, `performance`, `maintenance`,
  `removal`. Release notes group and order sections in that order
  (functionality first, upstream housekeeping last).
- `functionality` is a short label for the area the change lives in (e.g.
  `source-control`, `web sidebar`). It is for authors scanning the directory,
  not rendered in the release body.
- `text` is the one-sentence, user-facing description shown as the bullet.

## Follow-up changes and retirement

A later fix or enhancement to an existing feature gets a **new entry and id**.
Do not edit an already released entry to describe new behavior: it would never
appear in the next release's notes. Unreleased wording may be corrected in place.

Keep published entries when renaming or retiring a feature. They are the release
history, not the active feature inventory. Move their ownership into release
publication when retiring their implementation; add a new removal entry if the
retirement changes the product. A pure stack replay creates no entries.

## What not to add

- Don't add an entry for a rename, refactor, or internal cleanup with no
  user-visible effect.
- Don't re-list a feature that's already shipped just because it's still
  present — release notes cover what's new in _this_ release, not a running
  inventory of retained functionality.
- Don't infer a feature announcement from a commit subject alone; write the
  entry as part of implementing the change it describes.

## Validation

`scripts/ci/check-fork-release-notes` fails closed on any invalid entry
(bad TOML, unknown category, missing field, or a filename that doesn't match
`id`) and runs in the `fork-policy` CI job. `scripts/ci/render-fork-release-notes`,
which actually builds the release body, is deliberately the opposite: it
never fails a release over a bad or missing entry, skipping what it can't
parse instead.
