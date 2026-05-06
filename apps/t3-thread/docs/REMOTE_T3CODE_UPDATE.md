# Remote T3 Code Update Runbook

Use this when updating the headless `t3code.service` on the desktop dev VM. This is substrate maintenance for the remote T3 Code server, not worker-thread lifecycle work.

For service inspection, pairing URLs, and project registration, also use the shared `t3code-remote-ops` skill: `/Users/brad/.shared/skills/t3code-remote-ops/SKILL.md`.

## Load Canonical Values

Do not hardcode VM addresses in scripts or docs beyond examples. Source the shared network config:

```bash
source ~/.shared/config/local_network.env
export REMOTE_USER="${REMOTE_USER:-brad}"
export DEV_VM_SSH="${DEV_VM_SSH:-$REMOTE_USER@$DESKTOP_DEV_VM_TAILNET_IP}"
```

The remote service normally listens at `$DESKTOP_DEV_VM_T3CODE_URL`, currently the tailnet URL for port `3773`.

## Inspect Current Remote State

```bash
ssh "$DEV_VM_SSH" 'bash -lc "
  hostname
  systemctl is-active t3code.service || true
  systemctl cat t3code.service --no-pager
  command -v t3
  t3 --version
  readlink -f ~/.local/node/bin/t3 || true
"'
```

Expected service shape:

- unit: `t3code.service`
- base dir: `~/.local/share/t3code-dev`
- binary: `~/.local/node/bin/t3`
- command: `t3 serve --mode web --host "$(tailscale ip -4)" --port 3773 --no-browser --base-dir ~/.local/share/t3code-dev`

## Update From Brad's Fork

Use the fork, not upstream:

- repo: `https://github.com/jimprince/t3code.git`
- remote checkout on VM: `~/Programming/t3code-fork`

Choose the target ref intentionally. For the latest fork main:

```bash
TARGET_REF=origin/main
```

For a specific verified commit:

```bash
TARGET_REF=<full-or-short-sha>
```

Then run:

```bash
ssh "$DEV_VM_SSH" "bash -lc '
  set -euo pipefail
  export PATH=\"\$HOME/.local/node/bin:\$PATH\"

  REPO=https://github.com/jimprince/t3code.git
  TARGET=\$HOME/Programming/t3code-fork
  TARGET_REF=${TARGET_REF:?set TARGET_REF locally before running}

  if ! command -v bun >/dev/null 2>&1; then
    npm install -g bun@1.3.11
  fi

  mkdir -p \"\$HOME/Programming\"
  if [ ! -d \"\$TARGET/.git\" ]; then
    git clone \"\$REPO\" \"\$TARGET\"
  fi

  cd \"\$TARGET\"
  git remote set-url origin \"\$REPO\"
  git fetch origin --prune --tags
  git checkout main
  git reset --hard \"\$TARGET_REF\"

  bun install --ignore-scripts
  bun run build --filter=t3
  npm install -g \"\$TARGET/apps/server\"
  t3 --version
  readlink -f \"\$HOME/.local/node/bin/t3\"
  git rev-parse --short HEAD
'"
```

Notes:

- `bun install --ignore-scripts` is deliberate. A full `bun install` can be killed on the VM during package lifecycle scripts, and the fork release docs use `--ignore-scripts` for build-helper paths.
- `t3 --version` may still report the upstream mirrored package version even when the installed binary comes from the fork. Verify the symlink target and git SHA.

## Restart Service

Prefer systemd when sudo is available:

```bash
ssh "$DEV_VM_SSH" 'bash -lc "sudo systemctl restart t3code.service && systemctl is-active t3code.service"'
```

If sudo cannot prompt in the noninteractive shell, kill only the user-owned service process and let `Restart=always` bring it back:

```bash
ssh "$DEV_VM_SSH" 'bash -lc "
  set -euo pipefail
  pid=\$(pgrep -u \"\$USER\" -f \"^node /home/brad/.local/node/bin/t3 serve --mode web\" | head -n 1 || true)
  if [ -n \"\${pid:-}\" ]; then
    kill \"\$pid\" || true
    sleep 6
  fi
  systemctl is-active t3code.service
"'
```

Avoid broad `pkill -f "t3 serve"` patterns in SSH one-liners; they can match the remote shell command itself and terminate the SSH session.

## Verify

```bash
ssh "$DEV_VM_SSH" 'bash -lc "
  export PATH=\"\$HOME/.local/node/bin:\$PATH\"
  ss -ltnp | awk \"NR==1 || /:3773/\"
  systemctl status t3code.service --no-pager | sed -n \"1,18p\"
  t3 --version
  readlink -f \"\$HOME/.local/node/bin/t3\"
  cd \"\$HOME/Programming/t3code-fork\" && git rev-parse --short HEAD && git remote get-url origin
"'
```

Successful state:

- `t3code.service` is `active (running)`.
- `ss` shows a listener on the tailnet address port `3773`.
- `~/.local/node/bin/t3` resolves into `~/Programming/t3code-fork/apps/server/dist/bin.mjs`.
- `~/Programming/t3code-fork` is at the intended fork commit.

If the root URL hangs, prefer service status, port listening, and journal checks over an unbounded `curl`:

```bash
ssh "$DEV_VM_SSH" 'bash -lc "journalctl -u t3code.service -n 80 --no-pager"'
```

## Generate Pairing URL After Update

```bash
ssh "$DEV_VM_SSH" "bash -lc 't3 auth pairing create --base-dir ~/.local/share/t3code-dev --base-url \"$DESKTOP_DEV_VM_T3CODE_URL\" --label local-client --ttl 15m --json'"
```

Return the `pairUrl` to the user. Do not print unrelated credentials or secrets.
