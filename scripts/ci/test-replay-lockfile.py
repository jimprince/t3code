#!/usr/bin/env python3
"""Real StGit replay regression; run where Git, StGit, Bun and Python are installed."""

import os
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

DRIVER = Path(__file__).with_name("reproduce-sync-upstream").resolve()


class ReplayLockfileTest(unittest.TestCase):
    def test_generation_and_failure_restore(self):
        for mode in ("pass", "generation-fails", "semantic-conflict"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory(
                prefix="fork-replay-"
            ) as temp:
                root = Path(temp)
                repo = root / "repo"
                repo.mkdir()
                env = dict(
                    os.environ,
                    PATH="/usr/bin:/opt/homebrew/bin:" + os.environ["PATH"],
                    HUSKY="0",
                    VITE_GIT_HOOKS="0",
                )

                def run(*argv):
                    return subprocess.check_output(
                        argv, cwd=repo, env=env, text=True, stderr=subprocess.STDOUT
                    ).strip()

                def write(name, value):
                    path = repo / name
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text(value)

                run("git", "init", "-b", "main")
                run("git", "config", "user.name", "Fixture")
                run("git", "config", "user.email", "fixture@example.com")
                run("git", "config", "commit.gpgsign", "false")
                write("pnpm-lock.yaml", "upstream old\n")
                write("semantic.txt", "base\n")
                run("git", "add", "pnpm-lock.yaml", "semantic.txt")
                run("git", "commit", "-m", "upstream base")
                base = run("git", "rev-parse", "HEAD")
                write("pnpm-lock.yaml", "upstream new\n")
                if mode == "semantic-conflict":
                    write("semantic.txt", "upstream semantic change\n")
                run("git", "add", "pnpm-lock.yaml", "semantic.txt")
                run("git", "commit", "-m", "new upstream")
                run("git", "tag", "new-upstream")
                run("git", "switch", "-c", "stgit/adopt", base)
                run("git", "remote", "add", "upstream", str(repo))
                run("stg", "init")
                run("stg", "new", "build", "-m", "build fixture")
                write(
                    "docs/operations/fork-inventory.toml",
                    '[[patch]]\nname="build"\nroles=["lockfile-owner"]\n',
                )
                write("pnpm-lock.yaml", "fork generated old\n")
                run(
                    "git",
                    "add",
                    "pnpm-lock.yaml",
                    "docs/operations/fork-inventory.toml",
                )
                run("stg", "refresh", "--index")
                run("stg", "new", "workspace", "-m", "late workspace")
                write("apps/late/package.json", "{}\n")
                write("semantic.txt", "fork semantic change\n")
                run("git", "add", "apps/late/package.json", "semantic.txt")
                run("stg", "refresh", "--index")
                original_head = run("git", "rev-parse", "HEAD")
                original_stack = json.loads(
                    run("git", "show", "refs/stacks/stgit/adopt:stack.json")
                )
                bin_dir = root / "bin"
                bin_dir.mkdir()
                corepack = bin_dir / "corepack"
                corepack.write_text(
                    '#!/bin/sh\nset -eu\ntest -f apps/late/package.json\ntest "$(cat pnpm-lock.yaml)" = "upstream new"\n'
                    + (
                        "exit 47\n"
                        if mode == "generation-fails"
                        else 'printf "generated complete tip\\n" > pnpm-lock.yaml\n'
                    )
                )
                corepack.chmod(0o755)
                env.update(
                    PATH=str(bin_dir) + ":" + env["PATH"],
                    CI_REPAIR_BOT_METADATA_REMOTE="",
                    CI_REPAIR_BOT_UPSTREAM_TARGET="refs/tags/upstream/new-upstream",
                    CI_REPAIR_BOT_UPSTREAM_SOURCE_REF="refs/tags/new-upstream",
                )
                result = subprocess.run(
                    [str(DRIVER)], cwd=repo, env=env, text=True, capture_output=True
                )
                if mode == "pass":
                    self.assertEqual(
                        result.returncode, 0, result.stdout + result.stderr
                    )
                    self.assertEqual(
                        (repo / "pnpm-lock.yaml").read_text(),
                        "generated complete tip\n",
                    )
                    self.assertEqual(
                        run("stg", "series", "--all", "--noprefix").splitlines(),
                        ["build", "workspace"],
                    )
                    self.assertEqual(run("git", "status", "--porcelain"), "")
                    self.assertEqual(
                        run(
                            "git",
                            "show",
                            "refs/patches/stgit/adopt/build:pnpm-lock.yaml",
                        ),
                        "generated complete tip",
                    )
                else:
                    self.assertEqual(
                        result.returncode,
                        47 if mode == "generation-fails" else 1,
                        result.stdout + result.stderr,
                    )
                    self.assertEqual(run("git", "rev-parse", "HEAD"), original_head)
                    restored = json.loads(
                        run("git", "show", "refs/stacks/stgit/adopt:stack.json")
                    )
                    for key in ("head", "applied", "unapplied", "patches"):
                        self.assertEqual(restored[key], original_stack[key])
                    self.assertEqual(run("git", "status", "--porcelain"), "")
                    if mode == "semantic-conflict":
                        self.assertIn("failing patch: workspace", result.stdout)
                        self.assertIn("semantic.txt", result.stdout)


if __name__ == "__main__":
    unittest.main()
