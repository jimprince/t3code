"""Exercise the Linux updater with cron's environment and a disposable release."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("headless-auto-upgrade.sh")
VERSION = "0.0.39-nightly.20260906.1293-fork.2"


@unittest.skipUnless(sys.platform == "linux", "Linux release installer")
class CronUpgradeTest(unittest.TestCase):
    def test_cron_installs_release_using_user_local_node(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            commands = home / "commands"
            commands.mkdir()
            # Deliberately expose system utilities without any system Node.
            for name in ("bash", "python3", "mktemp", "rm", "mkdir", "tar", "mv",
                         "ln", "readlink", "find", "sort", "awk", "seq", "gzip"):
                (commands / name).symlink_to(shutil.which(name))
            node = home / ".local/node/bin/node"
            node.parent.mkdir(parents=True)
            node.write_text(f'#!/bin/sh\necho "T3 Code {VERSION}"\n')
            node.chmod(0o755)
            release = home / "artifact/bin"
            release.mkdir(parents=True)
            launcher = release / "t3"
            launcher.write_text('#!/bin/sh\nexec node "$@"\n')
            launcher.chmod(0o755)
            archive = home / "release.tar.gz"
            with tarfile.open(archive, "w:gz") as tar:
                tar.add(release.parent, arcname="headless")
            metadata = home / "release.json"
            metadata.write_text(json.dumps([{
                "tag_name": "v" + VERSION, "prerelease": True,
                "assets": [{"name": f"t3-headless-{VERSION}-linux-x64.tar.gz",
                            "browser_download_url": "https://fixture.invalid/artifact"}],
            }]))
            curl = commands / "curl"
            curl.write_text('''#!/usr/bin/env python3
import json, os, pathlib, shutil, sys
args = sys.argv[1:]
if args[-1].endswith('/.well-known/t3/environment'):
    print(json.dumps({'serverVersion': os.environ['FIXTURE_VERSION']}))
else:
    source = 'release.tar.gz' if args[-1].endswith('/artifact') else 'release.json'
    shutil.copyfile(pathlib.Path(os.environ['HOME']) / source, args[args.index('-o') + 1])
''')
            curl.chmod(0o755)
            env = {"HOME": str(home), "PATH": str(commands),
                   "T3CODE_HEADLESS_CHANNEL": "nightly", "T3CODE_HEADLESS_NO_RESTART": "1",
                   "T3CODE_HEADLESS_BASE_URL": "https://fixture.invalid", "FIXTURE_VERSION": VERSION}
            result = subprocess.run(["/bin/bash", str(SCRIPT)], env=env,
                                    text=True, capture_output=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)
            root = home / ".local/share/t3code-server"
            self.assertEqual((root / "current").resolve(), root / "releases" / VERSION)
            self.assertTrue((root / "current/bin/t3").is_file())
            self.assertIn(f"updated t3code.service to {VERSION}", result.stderr)


if __name__ == "__main__":
    unittest.main()
