# No-change replies

When the entire final assistant reply is exactly `No change.` or `Nothing new for you.`, T3 keeps the message in its thread timeline and suppresses extra completion output:

- No request answer is added to the project's Answers ready/Needs you feed.
- No worker output preview, reply notification, or finished mobile activity card is published.
- A successful app-owned delegated task completes without publishing result text or scheduling a completion wake for its parent. Its child timeline and internal context handoff remain available.
- The operator CLI watcher creates no completion notification, even at the `all` subscription level.

Matching is case-sensitive and trims only surrounding whitespace, including newlines. Markdown is not removed. `**No change.**`, `no change`, `No change. More text.`, and a second paragraph remain ordinary results. Appending `T3_NOTIFY: quiet` is additional text, so it does not invoke this suppression; the existing notification-footer rule still applies independently.

Pending questions, approvals, proposed plans and failures retain their existing behavior. This does not delete messages, close previously filed requests, or block explicit request/decision creation and direct thread sends. Automatic request capture already accepts only messages typed by the user, not final assistant output. No setting or database migration is needed.
