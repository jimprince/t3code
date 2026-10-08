# Existing-instance Gitea token rotation

This interface replaces a credential on an existing instance. It neither adds
instances nor mints tokens. Deployment owns the secret producer and each host's
installation window. Source preparation does not authorize a live invocation.

## RPC and storage

`sourceControl.gitea.setToken` requires `orchestration:operate`. Its JSON payload
is `{instanceId, token}`; Effect wraps the whole payload in `Redacted` before
validating any field, including malformed requests. Token input is nonempty
visible ASCII, at most 4096 characters, and rejects `redacted`. Settings markers
are also rejected. The only success fields are
`{instanceId, tokenSet, storedMatchesInput}`. Both booleans must be true.

The server holds the existing settings semaphore while checking the ID and
committing. Both general settings edits and this setter call one unlocked
persistence helper. The setter maps only the selected token onto the latest
registry, preserving instance IDs, origins, order, settings and other secrets.
Unknown or deleted IDs fail; there is no Add fallback. Existing secret-store
rollback restores the previous credential if settings persistence fails.
Rollback failure is logged without its cause or input; a failed/uncertain
operation requires owner reconciliation before retrying.

Secrets stay in the server's `userdata/secrets/gitea-token-<encoded-id>.bin`;
`settings.json` contains only the marker. Secret temporary files are opened
exclusively with mode 0600 before writing, synced, closed, and renamed. Setter
platform failures become a fixed typed `GiteaTokenSetError`, and child tracing
is disabled while credentials are handled. No receipt contains a suffix,
fingerprint, request payload, or credential. Memory strings are garbage
collected; JavaScript cannot guarantee erasure. Input byte buffers are cleared.

## Consumer

The owner supplies the actual environment, existing ID and an existing issue
inside the selected root thread's project:

```text
t3-thread source-control gitea set-token --env <paired-env> --instance <existing-id> --token-stdin --root-thread <root-id> --repository <owner/repo> --issue <number>
```

There is no argv token option. Parser errors are suppressed and replaced with
fixed text, including extra arguments. A TTY and Gitea token/password/secret/PAT
environment keys are refused without examining their values. Stdin must reach
EOF within 15 seconds and contain at most 4096 bytes including its optional
terminator. Only one trailing LF or CRLF is removed; whitespace is not trimmed.
Empty, marker, non-ASCII, control-byte, oversized and incomplete input fails
before requesting a mutation.

One authenticated connection reads redacted settings, finds the exact ID,
submits the redacted setter, calls `server.discoverSourceControl` (fresh `/user`
requests for every configured Gitea instance), and calls `projectIssues.get` for
the supplied existing issue through T3's native Gitea path. The issue host is
resolved from the existing instance's web origin. Discovery authenticates all
instances, so an unrelated broken connection prevents a verified receipt.
The connection has a 30-second request deadline. There is no mutation retry,
queueing, or watcher activation. The only stdout is the verified three-field
receipt; issue content and auth account details are not printed.

| Exit | Meaning                                                               | Owner action                         |
| ---- | --------------------------------------------------------------------- | ------------------------------------ |
| 0    | Receipt matches; fresh authentication and native issue read succeeded | Retain receipt                       |
| 2    | Input or parser rejected before a mutation                            | Correct delivery/arguments           |
| 20   | Preflight failed before a mutation request                            | Resolve pairing/ID/scope             |
| 30   | Mutation acknowledgement absent or outcome uncertain                  | Reconcile; never retry automatically |
| 40   | Setter acknowledged, verification failed                              | Diagnose; keep previous token active |

An explicit server rejection is conservatively classified as uncertain once
mutation dispatch begins. Successful native reads establish current server
use of the stored credential; they are not independent proof of a PAT's
numeric ID. The internal equality receipt binds the submitted credential to
what the store materialized during the atomic operation.

## Deployment producer/driver contract

Deployment's approved producer exposes `supply_id3(write_fd)`: one bounded read
(up to 4096 bytes) from its owner-only capture, ASCII and parent/capture-generation
checks, and one anonymous-pipe write bounded to 10 seconds. Never run it through
a shell, PTY, clipboard, environment variable, argv, tee, transcript, or token
file created for the consumer. Never read the capture during preparation.

The driver must read producer code once, check its owner-reviewed SHA-256, and
execute those same bytes. Hashing then reopening the pathname is prohibited.
Validate Deployment's capture ownership, regular non-symlink status, nlink and
parent generation through the producer, not by independently reading it.

Create one anonymous pipe and start the consumer **before** invoking the
producer. Pass only its read descriptor as stdin; do not inherit extra write
ends into either process. Run the producer's bounded supply function once,
close all driver write descriptors even on failure to deliver EOF, and reap the
consumer under a separate deadline (60 seconds after supply completes). Capture
only the consumer's non-secret receipt; do not relay arbitrary stderr or raw
exceptions. Treat a producer failure after a possible write, consumer signal,
missing/malformed receipt, or reap timeout as uncertain. No automatic retry.
On reap timeout terminate only the driver-owned consumer process group,
then reap it; termination does not establish that a server commit was prevented.
The approved host driver must bound and safely handle producer exceptions and
producer process execution too; the producer's 10-second bound is not a
substitute for the separate consumer reap bound.

`apps/t3-thread/tests/fixtures/gitea-token-producer-driver.py` is a synthetic-only
executable specification, not a host installation driver. Tests use a fake
producer and sentinel, verify consumer start order, hash rejection, execution
of the verified bytes despite pathname replacement, EOF, a separate reap bound,
and safe uncertain output. Deployment reviews the real host driver separately.

## Release and rotation order

1. Review this source patch and tests; integrate it into the owner's post-cutover V2
   release containing #189. Source prep does not upgrade either server or operator CLI.
2. Deployment verifies matching server/CLI capability, pairing, existing ID,
   host scope and target issue. DEV goes first. Do not infer an ID from the
   token's numeric PAT ID or add a guessed instance.
3. Under the approved DEV window, run the reviewed producer/driver once and
   retain the verified receipt. Stop on rejected, uncertain or failed verification.
4. Prepare equivalent owner-only delivery on the Mac and repeat against its
   independently confirmed existing UUID. A DEV-only capture is not a Mac
   distribution mechanism.
5. Only after **both** installations and native reads are verified may the owner
   revoke ID2. Revocation remains a separate owner action, never part of this CLI.

The accepted route and existing-instance mapping are recorded by Deployment in `/home/brad/.local/state/secrets-distribution-20261006/token85-routeB-producer-and-acceptance-mapping-corrected-20261006.md` (owner-reported SHA256 prefix `fdf4c2c4`). DEV instance is `home`; Mac instance is `d098c250-1cbb-4b78-a512-ed0f23bce4ae`; both use `http://git.home:3000`. The source preparation does not read or execute the live producer. V2 uses the fork RPC group and claims no migration ledger ID.
