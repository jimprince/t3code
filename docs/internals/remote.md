# Remote architecture

Each connection joins a client to one environment over HTTP and WebSocket. The
environment owns providers, execution, files, and durable state. Direct access,
Tailscale, SSH, and T3 Connect change how the client reaches that server; they do
not introduce another execution model. See
[remote access](../user/remote-access.md) for setup.

## Identity is independent of the route

An environment keeps its ID across server restarts and endpoint changes. Saved
connections are local to a client profile; the server's identity and state are
not. A repository identity can correlate clones across environments, but never
routes work between them. A project and its threads belong to one environment.

[Environment ID initialization](../../apps/server/src/environment/ServerEnvironment.ts)
must publish a complete ID atomically. Repair of an empty ID file retains a
recovery file so concurrent or delayed initializers choose the same winner.
Removing that recovery state as ordinary temporary-file cleanup can change the
identity underneath an already-running server.

Advertised endpoints are reachability hints. Only the connecting device can
prove that a route works. In particular, a host's loopback address refers to a
different machine when another device opens it. Endpoint selection must not
silently fall back to loopback when a shareable endpoint is unavailable.

## Hosted web is a client

The hosted web app stores its connection catalog in the browser and connects
directly to each environment. It does not proxy traffic or hold server-side
pairing state. Hosting the UI over HTTPS therefore cannot make a plain HTTP LAN
backend accessible from that browser context.

A [hosted pairing URL](../../apps/web/src/hostedPairing.ts) identifies the backend
in its query and carries the pairing secret in its fragment. Fragments stay out
of requests to the hosted origin. The browser exchanges the secret with the
environment and strips it from its history. Moving the token into a query
parameter would disclose it to the wrong origin.

## Access and process ownership are different

Tailscale supplies an endpoint for ordinary pairing, so it needs no separate
environment type. Authentication remains the environment's responsibility for
every route. See [environment authentication](./environment-auth.md) and the
[T3 Connect trust boundary](./t3-connect.md).

SSH can launch a server as well as forward a port. Desktop main owns that
lifecycle because it can spawn SSH and handle authentication prompts. The
renderer uses the forwarded endpoint through the shared connection runtime.
[SSH cleanup](../../packages/ssh/src/tunnel.ts) stops a remote server only if the
launcher owns it; a server it discovered already running must survive a client
disconnect. Reconnection restores the forward before opening the application
transport.

Remote servers can outlive several client releases. Clients must use advertised
capabilities and handle their absence, rather than assume their own version
describes the server. Process replacement belongs to the launcher's
[update protocol](./server-updates.md); the connection runtime handles the
resulting disconnect.

### Remote file downloads

Assistant Markdown file links use the existing authenticated asset-capability flow. On a remote
web or desktop connection, the client asks `assets.createUrl` for a `workspace-file-download`
resource containing the current thread id and linked path. The server derives the workspace root
from that thread's project or worktree; client-supplied environment or workspace roots are never
trusted. It canonicalizes both root and file, rejects traversal and symlinks escaping the root, and
issues a short-lived signed URL for that exact regular file.

The `/api/assets` route streams the file and adds `Content-Disposition: attachment` with a sanitized
ASCII fallback plus an RFC 5987 UTF-8 filename. The browser therefore downloads directly from the
environment endpoint without base64 encoding, WebSocket transfer, or buffering the file in client
JavaScript. Every connected environment offers **Download file** in the file-chip context menu.
Primary means same-origin, not necessarily the same physical machine, so primary file chips retain
their existing preview/editor left-click behavior while still allowing an explicit download.
Saved Bearer, Relay, and SSH targets download on left click and retain open-in-editor in their
context menu. The contracts and asset URL machinery are shared with mobile, but mobile does not yet
expose the download action because saving a streamed response requires platform document-picker and
filesystem UX.

Download capabilities preserve the canonical project/worktree containment boundary. Agents that
generate downloadable artifacts must write them inside the thread's project or active worktree and
link that path. An artifact written to an external location, such as a screenshot tool's temporary
or evidence directory, is intentionally rejected even if its absolute path appears in Markdown;
move or copy it into the thread workspace before linking it for download.
