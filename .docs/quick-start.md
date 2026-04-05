# Quick start

Before first launch:

- Codex users: read `./codex-prerequisites.md`
- OpenCode users: read `./opencode-prerequisites.md`

```bash
# Development (with hot reload)
bun run dev

# Desktop development
bun run dev:desktop

# Desktop development on an isolated port set
T3CODE_DEV_INSTANCE=feature-xyz bun run dev:desktop

# Production
bun run build
bun run start

# Build a shareable macOS .dmg (arm64 by default)
bun run dist:desktop:dmg

# Or from any project directory after publishing:
npx t3
```

## First-run provider setup

1. Start T3 Code.
2. Open Settings.
3. Confirm the OpenCode provider is enabled.
4. Set the OpenCode binary path if `opencode` is not already on `PATH`.
5. Click the provider refresh action in Settings after changing the binary path or custom model list.
6. Verify the OpenCode status card shows the CLI as available.
7. Add any extra OpenCode model slugs you want exposed in the picker.

## Using OpenCode in the UI

- Choose OpenCode from the composer provider picker when starting a new thread or changing the provider on an existing draft.
- Pick one of the discovered OpenCode models or enter a saved custom model slug.
- Use the same runtime-mode toggle and approval flows the app exposes for other providers.
- Pending OpenCode approvals and pending user-input prompts are handled directly in the chat composer.

## Notes

- T3 manages the local OpenCode sidecar automatically. You do not need to run `opencode serve` yourself.
- OpenCode provider status and discovered model catalog come from the server's current provider snapshot, not from hardcoded web defaults.
- If you point Settings at a different OpenCode binary, refresh providers so T3 re-runs the health check and model discovery without restarting the app.
- OpenCode does not expose separate traits controls in the composer today. The provider picker and model selection are the main web-facing controls.
