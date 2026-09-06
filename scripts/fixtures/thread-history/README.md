# Released thread history

These fixtures model persisted fork state, independently of the current schema
decoder and migration list. All event payloads are synthetic; no conversations,
credentials, device identities, or personal workspace paths are included.

- `1293-fork.2.sql` freezes the released schema through upstream migration 52
  and fork migration 4. Schema definitions and migration names were checked
  against the pre-upgrade database and the released migration sources; ledger
  timestamps are synthetic. It includes the retired sidebar column.
- `1400-fork.1.sql` adds the two upstream columns and ledger entries shipped
  before fork migration 5. It is applied after the first schema.
- `events.json` contains project/thread creation, goals set/evaluated/cleared,
  sidebar ordering set/cleared, and conversation messages with legacy file handoffs. The smoke runner
  substitutes only the temporary workspace path, then records all original
  event fields and migration ledger rows for preservation assertions.

`scripts/smoke-thread-history.ts` starts the packaged server with each fixture,
requires HTTP readiness, checks migrated events and reconstructed projections,
and restarts the same database to check idempotency. The macOS runner uses
Electron's Node mode, so this checks the packaged backend without opening UI.
The Linux headless smoke uses the unpacked `bin/t3`. Both release jobs must pass
before publication. No provider turn is requested.

Do not regenerate these fixtures from current contracts or mark new migrations
as already applied: that would erase the upgrade boundary being tested. Add a
new historical case when a persisted feature changes; preserve earlier cases
until support for those databases explicitly ends. Never reuse a shipped
migration ID, including retired fork ID 4.
