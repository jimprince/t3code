#!/usr/bin/env python3
"""Exercise the report CLI with a successful no-op and missing intervention evidence."""

import json
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("fork-reliability.py")


class ReportTest(unittest.TestCase):
    def test_noop_unknown_and_window_scope(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            evidence = root / "evidence"
            evidence.mkdir()
            (evidence / "logs").mkdir()
            tag = "v0.0.1-nightly.20260909.1"
            run = {
                "id": 1,
                "run_attempt": 1,
                "status": "completed",
                "conclusion": "success",
                "event": "schedule",
                "created_at": "2026-09-09T09:00:00Z",
                "head_sha": "a" * 40,
                "head_branch": "main",
                "html_url": "https://example.test/run/1",
            }
            for name, value in {
                "sync-upstream.yml.json": [run],
                "fork-push-nightly.yml.json": [],
                "release.yml.json": [],
                "ci.yml.json": [],
                "bot-runs.json": [],
                "bot-artifact-index.json": [],
                "ci-targets.json": {},
                "stack-publications.json": [],
                "previous-attempts.json": [],
                "jimprince-t3code-releases.json": [],
                "pingdotgg-t3code-releases.json": [
                    {"tag_name": tag, "published_at": "2026-09-09T08:00:00Z"}
                ],
            }.items():
                (evidence / name).write_text(json.dumps(value))
            (root / "classifications.json").write_text(
                json.dumps({"999": {"category": 3, "target": tag}})
            )
            log = evidence / "logs/1-1.txt"
            log.write_text(
                "Job\tStep\t2026-09-09T09:00:01Z Latest upstream nightly release: "
                + tag
                + "\nJob\tStep\t2026-09-09T09:00:02Z Fork already has upstream-containing build(s) for "
                + tag
                + ":\n"
            )

            def report():
                result = subprocess.run(
                    [
                        "python3",
                        str(SCRIPT),
                        "--output",
                        str(root),
                        "--checkout",
                        str(root / "checkout"),
                        "--from-date",
                        "2026-09-09",
                        "--to-date",
                        "2026-09-09",
                    ],
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                return json.loads((root / "updates.json").read_text())[0]

            row = report()
            self.assertEqual(row["sync_outcomes"], ["success (no-op)"])
            self.assertEqual(row["human_intervention"], "unknown")
            self.assertEqual(row["unattended"], "unknown")
            self.assertIsNone(row["elapsed_minutes_to_main"])
            self.assertEqual(
                json.loads((root / "summary.json").read_text())[
                    "github_failure_classifications"
                ],
                {},
            )
            # Actions prints shell source too: an echo statement is not an executed no-op.
            log.write_text(
                log.read_text().replace("Z Fork already", 'Z echo "Fork already')
            )
            self.assertEqual(report()["sync_outcomes"], ["success"])


if __name__ == "__main__":
    unittest.main()
