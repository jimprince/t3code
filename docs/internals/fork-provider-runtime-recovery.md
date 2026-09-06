# Fork provider runtime recovery

## Operator CLI

[`apps/t3-thread`](../architecture/t3-thread.md) is a separately built workspace application for
persistent worker lifecycle and notification operations against an already-running T3 Code
environment. It is not part of the server runtime and is distinct from local subprocess fan-out
tools.

## Restart recovery

At boot, `sessions.reconcile` marks projections left in `starting` or `running` as `interrupted`,
including any running latest turn. Provider runtime bindings carry a server boot generation; the
session reaper atomically settles bindings from older generations without loading their provider
instance. Settlement preserves resume cursors and runtime payloads so the next user action can
recover the provider session lazily.

Runtime bindings also persist the active turn ID. A send reserves a temporary active-turn marker
before calling the provider adapter, then replaces it with the provider turn ID. Terminal turn
events clear only the matching marker. This closes the interval where cleanup could otherwise
mistake an in-flight send for an idle session.

Current-generation sessions remain warm for 15 minutes after their last activity and are checked
once per minute. The reaper never stops a binding with an active turn. Adapter exit events stop the
corresponding runtime binding and release its thread-scoped log writers.
