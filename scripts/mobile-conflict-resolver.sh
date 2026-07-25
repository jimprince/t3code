#!/usr/bin/env bash
set -euo pipefail

required_env=(
  GITHUB_TOKEN
  REPOSITORY
  UPSTREAM_SHA
  MOBILE_SHA
  SYNC_RUN_ID
  SYNC_RUN_ATTEMPT
  UPSTREAM_BRANCH
  MOBILE_BRANCH
  CANDIDATE_BRANCH
  CONFLICTED_FILES_JSON
)

for name in "${required_env[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "$name is required." >&2
    exit 2
  fi
done

export GH_TOKEN="$GITHUB_TOKEN"

if [[ "$CANDIDATE_BRANCH" != automation/mobile-track-conflict/* ]]; then
  echo "Refusing to push non-candidate branch: $CANDIDATE_BRANCH" >&2
  exit 2
fi

if [[ "$MOBILE_BRANCH" == "$CANDIDATE_BRANCH" ]]; then
  echo "Candidate branch must not equal the mobile branch." >&2
  exit 2
fi

repo_url="https://x-access-token:${GITHUB_TOKEN}@github.com/${REPOSITORY}.git"
worktree="/workspace/repo"
log_file="/workspace/resolver-summary.md"

{
  echo "# Mobile Track Conflict Resolver"
  echo
  echo "- Repository: \`${REPOSITORY}\`"
  echo "- Sync run: \`${SYNC_RUN_ID}\` attempt \`${SYNC_RUN_ATTEMPT}\`"
  echo "- Upstream branch: \`${UPSTREAM_BRANCH}\`"
  echo "- Upstream SHA: \`${UPSTREAM_SHA}\`"
  echo "- Original mobile SHA: \`${MOBILE_SHA}\`"
  echo "- Candidate branch: \`${CANDIDATE_BRANCH}\`"
  echo "- Sync run URL: ${SYNC_RUN_URL:-unavailable}"
  echo
  echo "## Conflicted Files"
  echo
  jq -r '.[] | "- `\(.)`"' <<< "$CONFLICTED_FILES_JSON"
} > "$log_file"

git clone --no-tags --filter=blob:none "$repo_url" "$worktree"
cd "$worktree"

git config user.name "t3code-mobile-conflict-resolver[bot]"
git config user.email "t3code-mobile-conflict-resolver[bot]@users.noreply.github.com"
git config core.editor true

git remote add upstream "https://github.com/pingdotgg/t3code.git"
git fetch --no-tags origin "+refs/heads/${MOBILE_BRANCH}:refs/remotes/origin/${MOBILE_BRANCH}"
git fetch --no-tags upstream "+refs/heads/${UPSTREAM_BRANCH}:refs/remotes/upstream/${UPSTREAM_BRANCH}"

if [[ "$(git rev-parse "origin/${MOBILE_BRANCH}")" != "$MOBILE_SHA" ]]; then
  echo "Refusing stale job: ${MOBILE_BRANCH} no longer points at ${MOBILE_SHA}." >&2
  exit 1
fi

if [[ "$(git rev-parse "upstream/${UPSTREAM_BRANCH}")" != "$UPSTREAM_SHA" ]]; then
  echo "Refusing stale job: upstream ${UPSTREAM_BRANCH} no longer points at ${UPSTREAM_SHA}." >&2
  exit 1
fi

git checkout -B "$CANDIDATE_BRANCH" "$MOBILE_SHA"

set +e
git rebase "$UPSTREAM_SHA"
rebase_status=$?
set -e

if [[ "$rebase_status" -ne 0 ]]; then
  {
    echo
    echo "## Resolver"
    echo
    echo "Initial rebase conflicted as expected."
  } >> "$log_file"

  if [[ -n "${MOBILE_CONFLICT_RESOLVER_COMMAND:-}" ]]; then
    {
      echo
      echo "Running configured resolver command inside the sandbox."
    } >> "$log_file"
    bash -lc "$MOBILE_CONFLICT_RESOLVER_COMMAND"
  else
    {
      echo
      echo "No MOBILE_CONFLICT_RESOLVER_COMMAND was configured; leaving the job failed before any push."
      echo
      echo '```'
      git status --short
      echo '```'
    } >> "$log_file"
    exit 1
  fi
fi

if git diff --name-only --diff-filter=U | grep -q .; then
  {
    echo
    echo "Resolver command returned with unresolved conflicts:"
    echo
    echo '```'
    git diff --name-only --diff-filter=U
    echo '```'
  } >> "$log_file"
  exit 1
fi

if [[ -d .git/rebase-merge || -d .git/rebase-apply ]]; then
  git rebase --continue
fi

candidate_sha="$(git rev-parse HEAD)"

{
  echo
  echo "## Result"
  echo
  echo "- Candidate SHA: \`${candidate_sha}\`"
  echo
  echo "## Check Results"
  echo
} >> "$log_file"

checks=(
  "bun install --frozen-lockfile"
  "bun run fmt:check"
  "bun run lint"
  "bun run lint:mobile"
  "bun run typecheck"
  "bun run --filter @t3tools/mobile test src/features/threads/ThreadDetailScreen.test.ts"
  "bun run --filter @t3tools/client-runtime test src/threadDetailState.test.ts"
)

for check in "${checks[@]}"; do
  {
    echo "### \`${check}\`"
    echo
  } >> "$log_file"

  if bash -lc "$check" >> "$log_file" 2>&1; then
    echo "PASS: $check"
    echo "- Passed." >> "$log_file"
  else
    echo "FAIL: $check" >&2
    echo "- Failed." >> "$log_file"
    exit 1
  fi
done

git push --force-with-lease origin "HEAD:${CANDIDATE_BRANCH}"

pr_body="$(mktemp)"
cat "$log_file" > "$pr_body"
cat >> "$pr_body" <<EOF

## Manual Promotion

After review, promote only if \`feature/mobile-track\` still points at:

\`\`\`
${MOBILE_SHA}
\`\`\`

Use the \`Mobile Track Conflict Promote\` workflow with:

- \`candidate_branch=${CANDIDATE_BRANCH}\`
- \`expected_mobile_sha=${MOBILE_SHA}\`

EOF

if gh pr view "$CANDIDATE_BRANCH" --repo "$REPOSITORY" >/dev/null 2>&1; then
  gh pr edit "$CANDIDATE_BRANCH" \
    --repo "$REPOSITORY" \
    --title "Resolve mobile-track upstream conflict from run ${SYNC_RUN_ID}" \
    --body-file "$pr_body"
else
  gh pr create \
    --repo "$REPOSITORY" \
    --head "$CANDIDATE_BRANCH" \
    --base "$MOBILE_BRANCH" \
    --title "Resolve mobile-track upstream conflict from run ${SYNC_RUN_ID}" \
    --body-file "$pr_body"
fi
