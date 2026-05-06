# Debug Fixtures

These patch fixtures snapshot review-rendering worktree diffs used to develop
the scratch review renderer. Keep them deterministic so the debug route can test
parsing, chunked syntax highlighting, and virtualization without depending on
the current repo state.

- `review-small.diff`: 155 lines, narrow model/rendering changes.
- `review-medium.diff`: 1,955 lines, review screen and highlighter changes.
- `review-large.diff`: 3,208 lines, broad current worktree snapshot excluding
  this fixture directory.
- `current-working-review.diff`: alias of `review-large.diff` for quick loading
  while iterating.
