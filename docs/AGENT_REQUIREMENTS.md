# Agent Requirements

## Task

Repair the T3 Code fork automation so the fork follows upstream stable and nightly releases reliably.

## User Requirements

- Use Brad's local Apple Silicon Mac as an on-demand GitHub Actions macOS build worker.
- Do not configure the runner to launch at startup.
- Runner must be time-limited so it shuts off automatically if forgotten.
- Document this preference in a reusable skill or shared instruction location.
- Update release workflow so macOS builds target the local self-hosted runner, while Linux remains hosted.
- Keep a fork of upstream `pingdotgg/t3code` that rebases Brad's fork commits onto new upstream releases automatically.
- Track both stable releases and nightly releases.
- Prefer salvaging the current fork unless restarting from upstream is clearly better.
- Clean up the prior botched implementation enough that the system works.

## Acceptance Criteria

- Self-hosted macOS runner can be started manually with a timeout.
- Release workflow routes macOS arm64 build to the self-hosted runner label.
- Shared skill documents the management preference and commands.
- Main-branch fork-only changes automatically create the next updater-visible stable interim tag (`vNEXT-fork.N`) without waiting for upstream.
- Scheduled sync checks both stable and nightly, not only one selected channel.
- Stable and nightly sync replay only fork commits onto the selected upstream tag; stable releases must not accidentally include upstream nightly commits.
- Nightly fork tags use the fork-specific `-fork.N` scheme and do not create bare upstream-style nightly tags.
- Manual release/sync paths cannot accidentally recreate bare non-fork nightly releases.
- Stable `v0.0.21` can be recovered/published if upstream has it and the fork release is missing.
- Fork-only stable tags like `v0.0.22-fork.1` publish as normal/latest releases so installed stable fork clients receive updates.
- Documentation matches the implemented workflow.
- Existing fork patches and local untracked user files are not destroyed.

## Constraints

- Do not overwrite unrelated user work.
- Avoid destructive remote cleanup unless it is directly part of repairing the broken release state.
- Use GitHub CLI/API wrappers; do not read or expose secrets.
- For GitHub release creation, prefer the workflow-scoped `GITHUB_TOKEN` with
  `contents: write`; keep `GH_PAT` only for workflow-triggering tag/commit pushes.

## Status

- Implemented: release workflow routes macOS arm64 jobs to the local self-hosted runner label while Linux remains hosted.
- Implemented: local runner script supports on-demand detached `tmux` start, status, stop, and foreground run modes with a default 2-hour TTL.
- Implemented: shared `github-actions-local-runner` skill documents Brad's no-startup-service, TTL-limited local runner preference.
- Operational state: local runner was observed online under label `t3code-mac-arm64`; release run `24874392764` was still in `Preflight` when last checked.
- Implemented: release publishing now uses the job-scoped `GITHUB_TOKEN` for
  `softprops/action-gh-release`; `GH_PAT` remains reserved for tag/commit pushes.
