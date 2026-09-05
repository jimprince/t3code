# Gitea branch pull-request badges

In **Settings → Source Control → Gitea instances**, choose **Add Gitea instance**.
Configuration belongs to the selected primary server environment. Every client
connected to that environment uses the same configuration.

Enter the Git host, any SSH aliases, accepted SSH ports, and the web and API
origins. An origin includes the scheme and port, but no path. The API origin
must not include `/api/v1`; it is added automatically.

For example, a host `git.example` with SSH port `2222` can use
`http://git.example:3000` for both origins. The remote
`ssh://git@git.example:2222/owner/repo.git` then opens pull requests on port 3000. SCP-style remotes such as `git@git.example:owner/repo.git`, SSH aliases,
and HTTP/HTTPS remotes are supported. HTTP remotes match the configured web
host and port. An SCP alias has no explicit port, so it must identify one
instance unambiguously. Two instances may share a hostname if their SSH ports
and web ports differ; give them different aliases when using SCP-style remotes.

Enter a personal access token with repository read access and user read access
(for the authentication scan). Save the instance, then use **Rescan server
environment** to check authentication. Tokens are stored in the server secret
store; settings display a redacted marker. Leave the token field blank when
editing to preserve it, enter another token to replace it, use **Clear token**
to delete it, or **Remove** to delete the instance and its token. A token is
optional for public repository badges, but an authentication scan needs one.

Branch badges show open, closed, and merged pull requests, retaining Gitea's
link and last-updated time. Matching uses the head branch and repository, so a
fork's identically named branch does not appear on the wrong repository.
Existing remote selection and refresh/backoff behavior still apply: the
source-control provider uses `origin` when present. Configuration changes are
picked up without restarting; a cached branch badge may wait for its normal
refresh interval.

This integration supports branch badges. Create, checkout, repository lookup,
and the in-app pull-request browser are not supported for Gitea yet. Open the
badge link to use Gitea in your browser. Clone a Gitea repository using its Git
URL. Unconfigured hosts retain their existing unknown-host behavior.
