#!/usr/bin/env bash
set -euo pipefail

# The same local configuration is used by cron, systemd and manual checks.
config_file="${T3CODE_HEADLESS_CONFIG:-$HOME/.config/t3code/headless-upgrade.env}"
if [ -f "$config_file" ]; then
  # shellcheck source=/dev/null
  source "$config_file"
fi

repo="${T3CODE_HEADLESS_REPO:-jimprince/t3code}"
if [ "$repo" = jimprince/t3code ]; then
  default_channel=nightly
else
  default_channel=stable
fi
channel="${T3CODE_HEADLESS_CHANNEL:-$default_channel}"
root="${T3CODE_HEADLESS_ROOT:-$HOME/.local/share/t3code-server}"
service_name="${T3CODE_HEADLESS_SERVICE:-t3code.service}"
keep_releases="${T3CODE_HEADLESS_KEEP_RELEASES:-3}"

log() {
  printf '[t3-headless-upgrade] %s\n' "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

pending_file="$root/update-pending"
force=0
check_only=0
allow_downgrade=0
dry_run=0
requested_tag=""
while [ "$#" -gt 0 ]; do
case "$1" in
  --force) force=1 ;;
  --check-idle) check_only=1 ;;
  --retry-pending) [ -f "$pending_file" ] || exit 0 ;;
  --allow-downgrade) allow_downgrade=1 ;;
  --dry-run) dry_run=1 ;;
  --tag) shift; [ "$#" -gt 0 ] || die "--tag requires a release tag"; requested_tag="$1" ;;
  --help)
    printf 'Usage: t3code-headless-upgrade [--check-idle | --retry-pending | --force] [--dry-run] [--tag TAG] [--allow-downgrade]\nAutomatic updates defer while work is active. --force permits interruption only.\nOlder releases require --allow-downgrade. --dry-run checks selection and versions without install mutations.\n'
    exit 0 ;;
  *) die "unknown argument '$1'; use --help" ;;
esac
shift
done
[[ "$requested_tag" =~ ^[A-Za-z0-9.+_-]*$ ]] || die "invalid release tag"

# Read the live database strictly read-only, including its WAL. Missing or unfamiliar
# state is an error, never evidence that it is safe to interrupt the server.
check_idle() {
  python3 - "${T3CODE_HEADLESS_STATE_DB:-${T3CODE_HOME:-$HOME/.t3}/userdata/state.sqlite}" \
    "${T3CODE_HEADLESS_QUEUE_STATE:-$HOME/.config/t3-remote-agents/state.json}" <<'PYIDLE'
import json
import pathlib
import sqlite3
import sys

try:
    path = pathlib.Path(sys.argv[1]).expanduser().resolve(strict=True)
    with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=5) as db:
        db.execute('PRAGMA query_only = ON')
        db.execute('BEGIN')
        busy = set()
        for query in (
            "SELECT thread_id FROM projection_thread_sessions WHERE active_turn_id IS NOT NULL OR status IN ('starting', 'running')",
            "SELECT thread_id FROM provider_session_runtime WHERE active_turn_id IS NOT NULL AND status != 'stopped'",
            "SELECT t.thread_id FROM projection_turns t JOIN projection_threads p ON p.thread_id = t.thread_id AND p.latest_turn_id = t.turn_id WHERE t.state IN ('pending', 'running') OR t.checkpoint_status = 'pending'",
            "SELECT thread_id FROM projection_threads WHERE pending_user_input_count > 0",
            "SELECT thread_id FROM projection_pending_approvals WHERE status = 'pending'",
        ):
            busy.update(row[0] for row in db.execute(query))
    queue_path = pathlib.Path(sys.argv[2]).expanduser()
    if queue_path.exists():
        queue = json.loads(queue_path.read_text())
        busy.update(item['threadId'] for item in queue.get('queuedSends', [])
                    if item.get('status') in ('queued', 'dispatching'))
    if busy:
        print('active or queued threads: ' + ', '.join(sorted(busy)), file=sys.stderr)
        sys.exit(75)
    print('idle: no active turns, transitions, checkpoints, approvals or queued sends', file=sys.stderr)
except (OSError, sqlite3.Error, ValueError, KeyError, TypeError) as error:
    print('cannot establish that the server is idle: ' + str(error), file=sys.stderr)
    sys.exit(1)
PYIDLE
}

require_idle() {
  if [ "$force" = 1 ]; then
    log "manual --force requested; active work may be interrupted"
    return
  fi
  local idle_result=0
  check_idle || idle_result=$?
  case "$idle_result" in
    0) ;;
    75)
      mkdir -p "$root"
      : > "$pending_file"
      log "update deferred until threads finish; use --force only to explicitly interrupt them"
      exit 0 ;;
    *) die "update deferred because activity could not be checked; configure T3CODE_HEADLESS_STATE_DB or use manual --force" ;;
  esac
}

if [ "$check_only" = 1 ]; then
  check_idle
  exit $?
fi

# Older installed releases used a Node-based bin/t3 wrapper. Keep the standard
# fallback on PATH only so one of those releases remains usable for rollback.
export PATH="${PATH:-/usr/bin:/bin}:$HOME/.local/node/bin"

resolve_base_url() {
  if [ -n "${T3CODE_HEADLESS_BASE_URL:-}" ]; then
    printf '%s\n' "$T3CODE_HEADLESS_BASE_URL"
    return
  fi

  if command -v tailscale >/dev/null 2>&1; then
    local ip
    ip="$(tailscale ip -4 2>/dev/null | sed -n '1p')"
    if [ -n "$ip" ]; then
      printf 'http://%s:3773\n' "$ip"
      return
    fi
  fi

  printf 'http://127.0.0.1:3773\n'
}

release_json_path="$(mktemp)"
tmp_dir="$(mktemp -d)"
# Set once a release is staged. The promote below moves the directory away, so
# cleaning it here only affects runs that failed before getting that far.
stage_dir=""
cleanup() {
  rm -rf "$tmp_dir" "$release_json_path" ${stage_dir:+"$stage_dir"}
}
trap cleanup EXIT

github_api="https://api.github.com/repos/$repo"
curl_headers=(-H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28")
if [ -n "${GITHUB_TOKEN:-}" ]; then
  curl_headers+=(-H "Authorization: Bearer $GITHUB_TOKEN")
fi

if [ -n "$requested_tag" ]; then
  curl -fsSL "${curl_headers[@]}" "$github_api/releases/tags/$requested_tag" -o "$release_json_path"
else
case "$channel" in
  stable)
    curl -fsSL "${curl_headers[@]}" "$github_api/releases/latest" -o "$release_json_path"
    ;;
  nightly)
    # GitHub orders by release creation, which can put an old reroll first.
    # Read all pages and choose by version, including numeric fork suffixes.
    page=1
    while :; do
      page_path="$tmp_dir/releases.$page.json"
      curl -fsSL "${curl_headers[@]}" "$github_api/releases?per_page=100&page=$page" -o "$page_path"
      count="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert isinstance(d,list); print(len(d))' "$page_path")"
      [ "$count" = 100 ] || break
      page=$((page + 1))
    done
    python3 - "$tmp_dir" "$release_json_path" <<'PY'
import json,pathlib,sys
data=[]
for path in pathlib.Path(sys.argv[1]).glob('releases.*.json'):
    data.extend(json.loads(path.read_text()))
pathlib.Path(sys.argv[2]).write_text(json.dumps(data))
PY
    ;;
  *)
    die "unsupported channel '$channel'; expected stable or nightly"
    ;;
esac
fi

# Keep the ordering implementation in this installed script, so copying the
# updater never depends on a separately deployed helper or a host Node runtime.
version_tool="$tmp_dir/versions.py"
cat > "$version_tool" <<'PYVERSIONS'
import datetime
import re

def version_key(version):
    if not isinstance(version, str):
        raise ValueError('missing version')
    match = re.fullmatch(r'v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?', version)
    if not match:
        raise ValueError('unparseable version: ' + version)
    major, minor, patch, pre, build = match.groups()
    fork = 0
    if pre:
        suffix = re.search(r'(?:^|-)fork\.(0|[1-9]\d*)$', pre)
        if suffix:
            fork = int(suffix[1])
            pre = pre[:suffix.start()] or None
    identifiers = []
    if pre:
        for part in pre.split('.'):
            if not part or (part.isdigit() and len(part) > 1 and part.startswith('0')):
                raise ValueError('invalid prerelease: ' + version)
            identifiers.append((0, int(part)) if part.isdigit() else (1, part))
        if pre.startswith('nightly.'):
            if not re.fullmatch(r'nightly\.\d{8}\.(0|[1-9]\d*)', pre):
                raise ValueError('invalid nightly version: ' + version)
            datetime.datetime.strptime(pre.split('.')[1], '%Y%m%d')
    if build and any(not part for part in build.split('.')):
        raise ValueError('invalid build metadata: ' + version)
    return (int(major), int(minor), int(patch), pre is None, tuple(identifiers), fork)
PYVERSIONS

release_info="$(
  python3 - "$release_json_path" "$channel" "$requested_tag" "$version_tool" "$repo" <<'PY'
import json
import re
import sys

path, channel, requested_tag, version_tool, repo = sys.argv[1:]
exec(open(version_tool).read())
with open(path, "r", encoding="utf-8") as handle:
    data = json.load(handle)

releases = data if isinstance(data, list) else [data]
matching = []
for release in releases:
    if release.get("draft"):
        continue
    if requested_tag and release.get('tag_name') != requested_tag:
        raise ValueError('release API returned a different tag')
    if not requested_tag and channel == "nightly" and not release.get("prerelease"):
        continue
    tag = release.get("tag_name") or ""
    if not requested_tag and channel == 'nightly' and repo == 'jimprince/t3code' and not re.fullmatch(r'v?\d+\.\d+\.\d+-nightly\.[\d.]+-fork\.\d+', tag):
        continue
    version = tag[1:] if tag.startswith("v") else tag
    asset_name = f"t3-headless-{version}-linux-x64.tar.gz"
    for asset in release.get("assets", []):
        if asset.get("name") == asset_name:
            matching.append((version_key(version), {
                "tag": tag,
                "version": version,
                "asset_name": asset_name,
                "url": asset.get("browser_download_url"),
                "digest": asset.get("digest") or "",
            }))
if matching:
    print(json.dumps(max(matching, key=lambda item: item[0])[1]))
    sys.exit(0)

print(f"no {channel} release with matching headless linux asset", file=sys.stderr)
sys.exit(2)
PY
)"

tag="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["tag"])' "$release_info")"
version="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["version"])' "$release_info")"
asset_name="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["asset_name"])' "$release_info")"
asset_url="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["url"])' "$release_info")"
asset_digest="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["digest"])' "$release_info")"

[ -n "$asset_url" ] || die "release $tag asset has no download URL"

current_link="$root/current"
releases_dir="$root/releases"
release_dir="$releases_dir/$version"
previous_target=""
if [ -e "$current_link" ] || [ -L "$current_link" ]; then
  previous_target="$(readlink -f "$current_link" || true)"
fi

base_url="$(resolve_base_url)"
guard_versions() {
  # Query the running server even if current already points at the target.
  # A symlink promotion can precede restart, or a restart can have failed.
  curl --max-time 5 -fsS "${base_url%/}/.well-known/t3/environment" > "$tmp_dir/running.json" || \
    die "cannot establish running version; refusing update"
  running_version="$(python3 - "$tmp_dir/running.json" "$version" "$previous_target" "$allow_downgrade" "$version_tool" <<'PYGUARD'
import json, pathlib, sys
path, target, installed, permission, tool = sys.argv[1:]
exec(open(tool).read())
try:
    running = json.loads(pathlib.Path(path).read_text()).get('serverVersion')
    target_key = version_key(target)
    versions = [('running', running)]
    if installed:
        versions.append(('installed', pathlib.Path(installed).name))
    allow_downgrade = permission == '1'
    for kind, current in versions:
        older = target_key < version_key(current)
        if older and not allow_downgrade:
            raise ValueError(f'refusing downgrade: selected {target} is older than {kind} {current}; use --allow-downgrade for an intentional downgrade')
    print(running)
except (OSError, ValueError, TypeError, AttributeError) as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
PYGUARD
)" || die "version safety check failed"
}
guard_versions
log "selected $version; running $running_version; channel $channel; repo $repo"
if [ "$dry_run" = 1 ]; then
  log "dry run: no download, install, activity marker or restart changes"
  exit 0
fi
require_idle

# A deferred retry and the regular timer must never promote releases together.
mkdir -p "$root"
exec 9>"$root/update.lock"
if ! flock -n 9; then
  log "another update check owns the install lock"
  exit 0
fi
# Refresh the installed target and running version after waiting for the lock.
previous_target=""
if [ -e "$current_link" ] || [ -L "$current_link" ]; then
  previous_target="$(readlink -f "$current_link" || true)"
fi
guard_versions

if [ "$previous_target" = "$release_dir" ] && [ "$running_version" = "$version" ]; then
  rm -f "$pending_file"
  log "already on $version"
  exit 0
fi

# The new archive is self-contained, but the release being replaced may be the
# old Node-based layout. Do not give up a known-good rollback target during the
# one transitional upgrade: prove its existing launcher still runs first.
previous_version=""
if [ -n "$previous_target" ] && [ -d "$previous_target" ]; then
  previous_version="${previous_target##*/}"
  previous_reported_version="$("$previous_target/bin/t3" --version)" || \
    die "existing rollback release $previous_version cannot start; restore its runtime before upgrading"
  case "$previous_reported_version" in
    *" $previous_version"|*" v$previous_version") ;;
    *) die "existing rollback release reported '$previous_reported_version', expected version $previous_version" ;;
  esac
fi

mkdir -p "$releases_dir"

download_path="$tmp_dir/$asset_name"
log "downloading $tag asset $asset_name"
curl -fL --retry 3 --retry-delay 2 -o "$download_path" "$asset_url"

if [ -n "$asset_digest" ]; then
  case "$asset_digest" in
    sha256:*)
      expected="${asset_digest#sha256:}"
      printf '%s  %s\n' "$expected" "$download_path" | sha256sum -c -
      ;;
    *)
      die "unsupported asset digest format '$asset_digest'"
      ;;
  esac
else
  log "release asset has no digest; continuing without checksum verification"
fi

# Staging is scratch, named with the owning pid. A run killed outright (reboot,
# timer timeout) never reaches the cleanup trap, so drop leftovers whose process
# is gone before staging a new one. Without this, 63 extracted releases piled up
# over two months, ~570M each.
mkdir -p "$root/.staging"
for leftover in "$root"/.staging/*; do
  [ -d "$leftover" ] || continue
  leftover_pid="${leftover##*.}"
  case "$leftover_pid" in
    ''|*[!0-9]*) continue ;;
  esac
  if ! kill -0 "$leftover_pid" 2>/dev/null; then
    rm -rf "$leftover"
    log "removed orphaned staging directory $leftover"
  fi
done

stage_dir="$root/.staging/$version.$$"
rm -rf "$stage_dir"
mkdir -p "$stage_dir"
tar -xzf "$download_path" -C "$stage_dir" --strip-components 1
test -x "$stage_dir/bin/t3" || die "extracted release is missing executable bin/t3"

reported_version="$("$stage_dir/bin/t3" --version)"
case "$reported_version" in
  *" $version"|*" v$version") ;;
  *) die "staged t3 reported '$reported_version', expected version $version" ;;
esac

if [ ! -d "$release_dir" ]; then
  mv "$stage_dir" "$release_dir"
else
  rm -rf "$stage_dir"
fi

# A turn may have started while the asset was downloading or being validated.
# Recheck immediately before changing current or signaling the live service.
require_idle
guard_versions

tmp_link="$root/current.next.$$"
ln -s "$release_dir" "$tmp_link"
mv -Tf "$tmp_link" "$current_link"
log "current now points to $release_dir"

restart_service() {
  if [ "${T3CODE_HEADLESS_NO_RESTART:-}" = "1" ]; then
    log "T3CODE_HEADLESS_NO_RESTART=1; skipping restart"
    return 0
  fi

  if systemctl restart "$service_name" >/dev/null 2>&1; then
    return 0
  fi

  local pid new_pid
  pid="$(systemctl show "$service_name" -p MainPID --value 2>/dev/null || true)"
  if [ -n "$pid" ] && [ "$pid" != "0" ]; then
    kill -TERM "$pid"

    # A successful kill(2) only means the signal was delivered. The server can
    # keep the main process alive while child providers are still running, so
    # wait for systemd to replace it before checking the new release.
    for _ in $(seq 1 10); do
      new_pid="$(systemctl show "$service_name" -p MainPID --value 2>/dev/null || true)"
      if [ -n "$new_pid" ] && [ "$new_pid" != "0" ] && [ "$new_pid" != "$pid" ]; then
        return 0
      fi
      sleep 1
    done

    if [ "$force" != 1 ]; then
      log "$service_name did not stop gracefully; refusing automatic SIGKILL (manual --force required)"
      return 1
    fi
    log "$service_name main PID $pid ignored SIGTERM; forcing restart"
    kill -KILL "$pid" 2>/dev/null || true
    for _ in $(seq 1 30); do
      new_pid="$(systemctl show "$service_name" -p MainPID --value 2>/dev/null || true)"
      if [ -n "$new_pid" ] && [ "$new_pid" != "0" ] && [ "$new_pid" != "$pid" ]; then
        return 0
      fi
      sleep 1
    done
  fi

  die "could not restart $service_name through systemctl or verified MainPID fallback"
}

check_health() {
  local base_url="${1%/}"
  local expected_version="$2"
  local endpoint="$base_url/.well-known/t3/environment"
  for _ in $(seq 1 "${T3CODE_HEADLESS_HEALTH_ATTEMPTS:-45}"); do
    if curl --max-time 3 -fsS "$endpoint" > "$tmp_dir/environment.json"; then
      if python3 - "$tmp_dir/environment.json" "$expected_version" <<'PY'
import json
import sys

path, expected = sys.argv[1], sys.argv[2]
with open(path, "r", encoding="utf-8") as handle:
    data = json.load(handle)
if data.get("serverVersion") == expected:
    sys.exit(0)
print(
    f"serverVersion={data.get('serverVersion')!r}, expected={expected!r}",
    file=sys.stderr,
)
sys.exit(1)
PY
      then
        return 0
      fi
    fi
    sleep 1
  done
  return 1
}

if restart_service && check_health "$base_url" "$version"; then
  rm -f "$pending_file"
  log "updated $service_name to $version"
else
  log "health check failed after updating to $version"
  if [ -n "$previous_target" ] && [ -d "$previous_target" ]; then
    rollback_link="$root/current.rollback.$$"
    ln -s "$previous_target" "$rollback_link"
    mv -Tf "$rollback_link" "$current_link"
    log "rolled back current to $previous_target"
    restart_service
    check_health "$base_url" "$previous_version" || die "rollback health check failed"
  fi
  exit 1
fi

find "$releases_dir" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' \
  | sort -rn \
  | awk -v keep="$keep_releases" 'NR > keep { print $2 }' \
  | while IFS= read -r old_release; do
      if [ "$old_release" != "$release_dir" ] && [ "$old_release" != "$previous_target" ]; then
        rm -rf "$old_release"
        log "removed old release $old_release"
      fi
    done
