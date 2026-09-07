# Configured Gitea instances

`ServerSettings.giteaInstances` is an environment-local array of stable IDs,
Git hosts, SSH aliases/ports, web/API origins, and tokens. The settings service
stores token bytes through `ServerSecretStore`, persisting and broadcasting only
a redacted marker. The internal materialized settings accessor supplies the
actual token to the provider. IDs are unique; secret filenames encode the ID.
An empty array is the backward-compatible default.

`resolveGiteaRemote` in shared source-control code resolves explicit mappings
before DNS heuristics. SSH uses the configured host/alias and port; SCP has no
port and requires an unambiguous host/alias. HTTP(S) uses the configured web
host and port. Repository paths must be owner/repository. API calls use only the
configured API origin, never an SSH-derived origin or remote credentials.
Ambiguous mappings remain unknown.

The existing `SourceControlProviderRegistry` registers the additive Gitea
provider. It rechecks mappings on cached contexts so adding/removing an instance
does not require a restart. PR lookup and unsupported-host cache keys include the
non-secret routing configuration, so a settings change bypasses a prior negative
lookup. Tokens are excluded from those keys. GitManager uses the same mapping for presentation
and repository identity, and passes structured head repository selectors to
Gitea. The origin-first provider selection policy is unchanged.

The adapter uses the documented [Gitea 1.25 list pull requests endpoint](https://docs.gitea.com/api/1.25/operations/repo-list-pull-requests/):
`GET /api/v1/repos/{owner}/{repo}/pulls?state=all&sort=recentupdate&page=N&limit=50`.
It filters exact branch refs and full head/base repository identities before
applying the caller's limit. Pagination continues to an empty page to accommodate
instances that clamp page size; 1000 pages is an explicit error ceiling. Complete
negative scans are cached for five minutes, keyed by instance endpoints, credential
digest, full repository identities, branch, requested state and local tip SHA. The
cache holds at most 256 entries. Changed tips or tokens bypass cached absence; errors
and incomplete scans are never cached. A branch whose tip cannot be resolved is
read directly. This bounds repeated absent-branch polling without a page cutoff
that would silently lose older PRs. Merged
is determined from `merged`, independently of `state=closed`. `html_url` and
`updated_at` are preserved. Authentication discovery uses `GET /api/v1/user`.
No undocumented head-filter endpoint, CLI, or redirect following is required.
HTTP errors include only the status, not headers or response bodies.

Web and Electron share the settings form and provider presentation. Mobile
consumes the same badge contracts and has a Gitea icon; configure instances from
web/desktop. Add-project and publish pickers continue to list only providers
with those operations implemented. The rich pull-request registry also registers `GiteaPullRequestProvider`, carried
as `fork-gitea-pr-browser`. It resolves the selected checkout remote through the
source-control registry, then reuses `GiteaApi` with that instance’s token. It reads
PRs, issue comments, submitted reviews and their inline comments, commits, unified
diffs, and paginated combined commit statuses. Empty checks remain empty; incomplete
CI pagination fails explicitly. Mutations are disabled by both capabilities and
viewer permissions. Conversations have bounded pagination and report truncation.
Listings stop once the requested slice and a following row are known.

The concern is carried as `fork-gitea-connections`. Retire it when upstream
provides configured Gitea instances, protected token storage, and equivalent
branch/repository-safe badge lookup.
