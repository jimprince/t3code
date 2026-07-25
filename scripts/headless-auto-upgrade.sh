#!/usr/bin/env bash
set -euo pipefail

repo="${T3CODE_HEADLESS_REPO:-jimprince/t3code}"
channel="${T3CODE_HEADLESS_CHANNEL:-stable}"
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
cleanup() {
  rm -rf "$tmp_dir" "$release_json_path"
}
trap cleanup EXIT

github_api="https://api.github.com/repos/$repo"
curl_headers=(-H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28")
if [ -n "${GITHUB_TOKEN:-}" ]; then
  curl_headers+=(-H "Authorization: Bearer $GITHUB_TOKEN")
fi

case "$channel" in
  stable)
    curl -fsSL "${curl_headers[@]}" "$github_api/releases/latest" -o "$release_json_path"
    ;;
  nightly)
    curl -fsSL "${curl_headers[@]}" "$github_api/releases?per_page=50" -o "$release_json_path"
    ;;
  *)
    die "unsupported channel '$channel'; expected stable or nightly"
    ;;
esac

release_info="$(
  python3 - "$release_json_path" "$channel" <<'PY'
import json
import sys

path, channel = sys.argv[1], sys.argv[2]
with open(path, "r", encoding="utf-8") as handle:
    data = json.load(handle)

releases = data if isinstance(data, list) else [data]
for release in releases:
    if release.get("draft"):
        continue
    if channel == "nightly" and not release.get("prerelease"):
        continue
    tag = release.get("tag_name") or ""
    version = tag[1:] if tag.startswith("v") else tag
    asset_name = f"t3-headless-{version}-linux-x64.tar.gz"
    for asset in release.get("assets", []):
        if asset.get("name") == asset_name:
            print(json.dumps({
                "tag": tag,
                "version": version,
                "asset_name": asset_name,
                "url": asset.get("browser_download_url"),
                "digest": asset.get("digest") or "",
            }))
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

if [ "$previous_target" = "$release_dir" ]; then
  log "already on $version"
  exit 0
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
  local endpoint="$base_url/.well-known/t3/environment"
  for _ in $(seq 1 45); do
    if curl --max-time 3 -fsS "$endpoint" > "$tmp_dir/environment.json"; then
      python3 - "$tmp_dir/environment.json" "$version" <<'PY'
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
      return 0
    fi
    sleep 1
  done
  return 1
}

base_url="$(resolve_base_url)"
restart_service

if check_health "$base_url"; then
  log "updated $service_name to $version"
else
  log "health check failed after updating to $version"
  if [ -n "$previous_target" ] && [ -d "$previous_target" ]; then
    rollback_link="$root/current.rollback.$$"
    ln -s "$previous_target" "$rollback_link"
    mv -Tf "$rollback_link" "$current_link"
    log "rolled back current to $previous_target"
    restart_service
    check_health "$base_url" || die "rollback health check failed"
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
