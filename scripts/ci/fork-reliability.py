#!/usr/bin/env python3
"""Rebuild fork update outcomes from cached evidence; no repository or live-state writes.

Collection uses GitHub CLI credentials and a read-only bot SQLite connection.
Analyst annotations remain explicit inputs: absent human evidence is unknown.
Outputs and downloaded logs belong outside the source checkout.
"""

import argparse, os, pathlib

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--output", type=pathlib.Path, required=True)
parser.add_argument("--checkout", required=True)
parser.add_argument("--from-date", required=True)
parser.add_argument("--to-date", required=True)
parser.add_argument("--collect", action="store_true")
parser.add_argument(
    "--annotations",
    type=pathlib.Path,
    help="Directory containing classifications.json, bot-classifications.json and human-interventions.json",
)
parser.add_argument(
    "--surface",
    action="store_true",
    help="Rebuild current patch conflict-surface ledger from fetched upstream history",
)
parser.add_argument(
    "--bot-db",
    default=os.path.expanduser(
        "~/Programming/ci-repair-bot/state/ci-repair-bot.sqlite3"
    ),
)
parser.add_argument(
    "--gitea",
    action="store_true",
    help="Collect reviewed issues using GITEA_API_URL and GITEA_TOKEN",
)
parser.add_argument(
    "--memory-dir",
    type=pathlib.Path,
    default=pathlib.Path.home() / ".shared/memories/projects/t3code-fork",
)
args = parser.parse_args()
if args.from_date > args.to_date:
    parser.error("from-date must not be after to-date")
if (
    pathlib.Path(args.checkout).resolve() in args.output.resolve().parents
    or args.output.resolve() == pathlib.Path(args.checkout).resolve()
):
    parser.error("output must be outside the source checkout")
args.output.mkdir(parents=True, exist_ok=True)
if args.annotations:
    import shutil

    for name in (
        "classifications.json",
        "bot-classifications.json",
        "human-interventions.json",
    ):
        source = args.annotations / name
        if source.exists() and source.resolve() != (args.output / name).resolve():
            shutil.copyfile(source, args.output / name)

if args.collect:
    import concurrent.futures, datetime, json, pathlib, sqlite3, subprocess

    ROOT = args.output / "evidence"
    ROOT.mkdir(exist_ok=True)

    # Preserve contextual evidence separately from measured run outcomes. These notes
    # never silently turn an unknown intervention or failure cause into a known one.
    import shutil

    if args.memory_dir.is_dir():
        context = ROOT / "project-memory"
        context.mkdir(exist_ok=True)
        for note in args.memory_dir.glob("*.md"):
            shutil.copyfile(note, context / note.name)
    if args.gitea:
        import urllib.request

        api = os.environ["GITEA_API_URL"].rstrip("/")
        token = os.environ["GITEA_TOKEN"]
        for repo, issues in {
            "ci-repair-bot": [5, 6, 47, 54],
            "t3code-fork": [1, 6, 40],
        }.items():
            for issue in issues:
                path = f"{api}/repos/brad/{repo}/issues/{issue}"
                request = urllib.request.Request(
                    path, headers={"Authorization": "token " + token}
                )
                with urllib.request.urlopen(request) as response:
                    (ROOT / f"{repo}-{issue}.json").write_bytes(response.read())
                comments = []
                page = 1
                while True:
                    request = urllib.request.Request(
                        f"{path}/comments?limit=50&page={page}",
                        headers={"Authorization": "token " + token},
                    )
                    with urllib.request.urlopen(request) as response:
                        batch = json.load(response)
                    comments.extend(batch)
                    if len(batch) < 50:
                        break
                    page += 1
                (ROOT / f"{repo}-{issue}-comments.json").write_text(
                    json.dumps(comments, indent=2)
                )

    def gh(path):
        p = subprocess.run(
            ["gh", "api", "--paginate", "--slurp", path], capture_output=True, text=True
        )
        if p.returncode:
            raise RuntimeError(p.stderr)
        return json.loads(p.stdout)

    def collect(w):
        data = gh(
            f"repos/jimprince/t3code/actions/workflows/{w}/runs?per_page=100&created={args.from_date}..{args.to_date}"
        )
        rows = [r for p in data for r in p["workflow_runs"]]
        if data[0]["total_count"] > 1000:
            raise SystemExit("GitHub search limit exceeded: use a shorter date window")
        (ROOT / (w + ".json")).write_text(json.dumps(rows, indent=2))
        return w, len(rows)

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as e:
        for result in e.map(
            collect,
            ["sync-upstream.yml", "fork-push-nightly.yml", "release.yml", "ci.yml"],
        ):
            print(result, flush=True)
    for repo in ["jimprince/t3code", "pingdotgg/t3code"]:
        rows = [r for page in gh(f"repos/{repo}/releases?per_page=100") for r in page]
        (ROOT / (repo.replace("/", "-") + "-releases.json")).write_text(
            json.dumps(rows, indent=2)
        )
        print(repo, len(rows), flush=True)
    c = sqlite3.connect(
        pathlib.Path(args.bot_db).expanduser().resolve().as_uri() + "?mode=ro", uri=True
    )
    c.row_factory = sqlite3.Row
    for table in ["runs", "incidents"]:
        rows = [
            dict(r)
            for r in c.execute(
                f"select * from {table} where repository='jimprince/t3code'"
            )
        ]
        (ROOT / ("bot-" + table + ".json")).write_text(json.dumps(rows, indent=2))
        print(table, len(rows), flush=True)

    import re

    artifact_root = (
        pathlib.Path(args.bot_db).expanduser().resolve().parent.parent
        / "artifacts"
        / "jimprince__t3code"
    )
    artifact_index = []
    for row in json.loads((ROOT / "bot-runs.json").read_text()):
        if not args.from_date <= row["created_at"][:10] <= args.to_date:
            continue
        files = sorted(x.name for x in (artifact_root / row["run_id"]).glob("*"))
        artifact_index.append(
            {
                "run_id": row["run_id"],
                "files": files,
                "agent_invocations_lower_bound": sum(
                    name == "agent.stdout"
                    or bool(re.fullmatch(r"verification-repair-\d+.agent.stdout", name))
                    for name in files
                ),
            }
        )
    (ROOT / "bot-artifact-index.json").write_text(json.dumps(artifact_index, indent=2))
    all_runs = []
    previous = []
    for workflow in [
        "sync-upstream.yml",
        "fork-push-nightly.yml",
        "release.yml",
        "ci.yml",
    ]:
        for run in json.loads((ROOT / (workflow + ".json")).read_text()):
            run["workflow_file"] = workflow
            all_runs.append(run)
            for attempt in range(1, run["run_attempt"]):
                old = gh(
                    f"repos/jimprince/t3code/actions/runs/{run['id']}/attempts/{attempt}"
                )[0]
                old["workflow_file"] = workflow
                previous.append(old)
    (ROOT / "previous-attempts.json").write_text(json.dumps(previous, indent=2))
    log_root = ROOT / "logs"
    log_root.mkdir(exist_ok=True)

    def download_log(run):
        destination = log_root / f"{run['id']}-{run['run_attempt']}.txt"
        if destination.exists() and not destination.read_text().startswith(
            "COLLECTION_ERROR:"
        ):
            return
        if run["status"] != "completed":
            return
        replay = run["workflow_file"] in ["sync-upstream.yml", "fork-push-nightly.yml"]
        if not replay and run["conclusion"] == "success":
            return
        result = subprocess.run(
            [
                "gh",
                "run",
                "view",
                str(run["id"]),
                "--repo",
                "jimprince/t3code",
                "--attempt",
                str(run["run_attempt"]),
                "--log" if replay else "--log-failed",
            ],
            capture_output=True,
            text=True,
        )
        destination.write_text(
            result.stdout
            if result.returncode == 0
            else "COLLECTION_ERROR: " + result.stderr
        )

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        list(executor.map(download_log, all_runs + previous))

    def git(*argv):
        return subprocess.check_output(
            ["git", "-C", args.checkout, *argv], text=True
        ).strip()

    # Fetch read-only evidence refs; no main/worktree/lease changes.
    subprocess.run(
        [
            "git",
            "-C",
            args.checkout,
            "fetch",
            "origin",
            "+refs/stack-history/*:refs/stack-history/*",
        ],
        check=True,
        stdout=subprocess.DEVNULL,
    )
    subprocess.run(
        [
            "git",
            "-C",
            args.checkout,
            "fetch",
            "https://github.com/pingdotgg/t3code.git",
            "+refs/tags/*:refs/tags/upstream/*",
        ],
        check=True,
        stdout=subprocess.DEVNULL,
    )
    ci_targets = {}
    for run in all_runs:
        if run["workflow_file"] != "ci.yml":
            continue
        result = subprocess.run(
            [
                "git",
                "-C",
                args.checkout,
                "describe",
                "--tags",
                "--match",
                "upstream/*nightly*",
                "--abbrev=0",
                run["head_sha"],
            ],
            capture_output=True,
            text=True,
        )
        if result.returncode == 0:
            ci_targets[str(run["id"])] = result.stdout.strip().removeprefix("upstream/")
    (ROOT / "ci-targets.json").write_text(json.dumps(ci_targets, indent=2))
    publications = []
    for ref in git(
        "for-each-ref", "--format=%(refname)", "refs/stack-history/"
    ).splitlines():
        if ref.endswith("-previous"):
            continue
        state = json.loads(git("show", ref + ":stack.json"))
        tag = git(
            "describe",
            "--tags",
            "--match",
            "upstream/*nightly*",
            "--abbrev=0",
            state["head"],
        ).removeprefix("upstream/")
        timestamp = (
            datetime.datetime.strptime(ref.split("/")[-1], "%Y%m%dT%H%M%SZ")
            .replace(tzinfo=datetime.timezone.utc)
            .isoformat()
        )
        publications.append(
            {
                "ref": ref,
                "published_at": timestamp,
                "head": state["head"],
                "target": tag,
                "patch_count": len(state["applied"]),
            }
        )
    (ROOT / "stack-publications.json").write_text(json.dumps(publications, indent=2))

import json, pathlib, re, collections, csv, datetime

P = args.output / "evidence"
O = args.output
ansi = re.compile(r"\x1b\[[0-9;]*m")
tagpat = r"v\d+\.\d+\.\d+-nightly\.\d{8}\.\d+"


def read(n):
    return json.loads((P / n).read_text())


def log(r):
    p = P / "logs" / f"{r['id']}-{r['run_attempt']}.txt"
    return ansi.sub("", p.read_text()) if p.exists() else ""


def target(r, s):
    for pat in [
        r"Latest upstream nightly release: (" + tagpat + ")",
        r"CI_REPAIR_BOT_UPSTREAM_TARGET: refs/tags/upstream/(" + tagpat + ")",
        r'upstream_tag="(' + tagpat + ')"',
    ]:
        m = re.findall(pat, s)
        if m:
            return m[-1]
    m = re.search(tagpat, r["head_branch"])
    return m[0] if m else None


annotation_path = O / "classifications.json"
reviewed_classes = (
    json.loads(annotation_path.read_text()) if annotation_path.exists() else {}
)
runs = []
targets = collections.defaultdict(list)
for w in ["sync-upstream.yml", "fork-push-nightly.yml", "release.yml", "ci.yml"]:
    attempts = read(w + ".json") + [
        r for r in read("previous-attempts.json") if r.get("workflow_file") == w
    ]
    for r in sorted(
        attempts, key=lambda r: (r["created_at"], r["id"], r["run_attempt"])
    ):
        s = log(r)
        r["target"] = (
            read("ci-targets.json").get(str(r["id"])) if w == "ci.yml" else target(r, s)
        )
        r["target_evidence"] = (
            "CI ancestry" if w == "ci.yml" else "workflow log or release ref"
        )
        if not r["target"]:
            classification = reviewed_classes.get(
                f"{r['id']}:{r['run_attempt']}", reviewed_classes.get(str(r["id"]), {})
            )
            r["target"] = classification.get("target")
            r["target_evidence"] = "reviewed annotation" if r["target"] else "unknown"
        r["workflow_file"] = w
        r["patches"] = sorted(set(re.findall(r"failing patch: (fork-[\w-]+)", s)))
        files = []
        lines = s.splitlines()
        for i, l in enumerate(lines):
            if l.endswith("conflicting files:"):
                for ll in lines[i + 1 :]:
                    txt = re.sub(r"^.*?\d{4}-\d\d-\d\dT\S+Z ", "", ll)
                    if not txt.startswith("  "):
                        break
                    files.append(txt.strip())
        r["conflicting_files"] = sorted(set(files))
        r["noop"] = bool(
            re.search(r"Z Fork already has upstream-containing build\(s\)", s)
        )
        runs.append(r)
        if r["target"]:
            targets[r["target"]].append(r)
bot = read("bot-runs.json")
artifacts = {r["run_id"]: r for r in read("bot-artifact-index.json")}
releases = [
    r
    for r in read("jimprince-t3code-releases.json")
    if r["published_at"] and args.from_date <= r["published_at"][:10] <= args.to_date
]
for r in releases:
    m = re.search(tagpat, r["tag_name"])
    if m:
        targets.setdefault(m[0], [])
upstream = [
    r
    for r in read("pingdotgg-t3code-releases.json")
    if r["published_at"]
    and args.from_date <= r["published_at"][:10] <= args.to_date
    and "nightly" in r["tag_name"]
]
for r in upstream:
    targets.setdefault(r["tag_name"], [])
rows = []
for tag, rs in sorted(targets.items()):
    sync = [r for r in rs if r["workflow_file"] == "sync-upstream.yml"]
    rr = [r for r in releases if r["tag_name"].startswith(tag + "-fork.")]
    br = [
        r
        for r in bot
        if r["target"].endswith("/" + tag)
        and args.from_date <= r["created_at"][:10] <= args.to_date
    ]
    pub = [r for r in br if r["status"] == "auto_landed"]
    start = min([r["created_at"] for r in sync], default=None)
    end = min([r["updated_at"] for r in pub], default=None)
    elapsed = (
        (
            datetime.datetime.fromisoformat(end)
            - datetime.datetime.fromisoformat(start.replace("Z", "+00:00"))
        ).total_seconds()
        / 60
        if start and end
        else None
    )
    row = {
        "target": tag,
        "sync_runs": [r["id"] for r in sync],
        "sync_attempts": [f"{r['id']}:{r['run_attempt']}" for r in sync],
        "sync_outcomes": [
            r["conclusion"] + (" (no-op)" if r["noop"] else "") for r in sync
        ],
        "failing_patches": sorted({p for r in sync for p in r["patches"]}),
        "conflicting_files": sorted({p for r in sync for p in r["conflicting_files"]}),
        "bot_runs": [
            {
                "id": r["run_id"],
                "status": r["status"],
                "error": r["error"] or r["needs_attention_reason"],
                "observed_agent_invocations_lower_bound": artifacts.get(
                    r["run_id"], {}
                ).get("agent_invocations_lower_bound"),
            }
            for r in br
        ],
        "first_sync": start,
        "bot_published_at": end,
        "elapsed_minutes_bot_publication": elapsed,
        "human_intervention": "unknown",
        "unattended": "unknown",
        "releases": [r["tag_name"] for r in rr],
        "incidents": [r["id"] for r in rs if r["conclusion"] == "failure"],
        "evidence": [r["html_url"] for r in rs],
    }
    rows.append(row)
(O / "updates.json").write_text(json.dumps(rows, indent=2))
(O / "runs.json").write_text(json.dumps(runs, indent=2))
with (O / "updates.csv").open("w", newline="") as f:
    wr = csv.DictWriter(f, fieldnames=list(rows[0]) if rows else ["target"])
    wr.writeheader()
    wr.writerows(
        {k: json.dumps(v) if isinstance(v, (list, dict)) else v for k, v in r.items()}
        for r in rows
    )
print("targets", len(rows), "sync targets", sum(bool(r["sync_runs"]) for r in rows))
print(
    "scheduled",
    collections.Counter(
        r["conclusion"]
        for r in runs
        if r["workflow_file"] == "sync-upstream.yml" and r["event"] == "schedule"
    ),
)
print(
    "no-op successes",
    sum(r["noop"] for r in runs if r["workflow_file"] == "sync-upstream.yml"),
)
print(
    "patches",
    collections.Counter(
        p
        for r in runs
        if r["workflow_file"] == "sync-upstream.yml"
        for p in r["patches"]
    ),
)
print(
    "release counts",
    [
        (r["target"].split(".")[-1], len(r["releases"]))
        for r in rows
        if len(r["releases"]) > 2
    ],
)
print(
    "unjoined failed",
    [
        (r["id"], r["workflow_file"])
        for r in runs
        if not r["target"] and r["conclusion"] == "failure"
    ],
)

import json, pathlib, datetime, collections, csv, re

p = args.output
read = lambda n: json.loads((p / n).read_text()) if (p / n).exists() else {}
rows = read("updates.json")
ann = read("human-interventions.json")
snap = read("evidence/stack-publications.json")
classes = read("classifications.json")
botclasses = read("bot-classifications.json")
runs = read("runs.json")
run_ids = {str(r["id"]) for r in runs}
classes = {k: v for k, v in classes.items() if k.split(":")[0] in run_ids}
bot_ids = {
    r["run_id"] for r in bot if args.from_date <= r["created_at"][:10] <= args.to_date
}
botclasses = {k: v for k, v in botclasses.items() if k in bot_ids}


def dt(v):
    return datetime.datetime.fromisoformat(v.replace("Z", "+00:00"))


for r in rows:
    t = r["target"]
    r["failure_categories"] = [
        {"run": k, **v} for k, v in classes.items() if v["target"] == t
    ]
    r["bot_failure_categories"] = [
        {"run": k, **v} for k, v in botclasses.items() if v["target"].endswith("/" + t)
    ]
    r["snapshot_publications"] = [s for s in snap if s["target"] == t]
    r["human_intervention_detail"] = ann.get(t, {}).get(
        "what", "No definitive historical human-intervention record recovered."
    )
    if t in ann:
        r.update({k: ann[t][k] for k in ["human_intervention", "unattended"]})
    # Lower bound preserves overwritten/missing historical attempt artifacts.
    r["bot_attempts_lower_bound"] = sum(
        b["observed_agent_invocations_lower_bound"] or 0 for b in r["bot_runs"]
    )
    publication = [
        (s["published_at"], "stack snapshot " + s["ref"])
        for s in r["snapshot_publications"]
    ]
    if r["bot_published_at"]:
        publication.append((r["bot_published_at"], "bot auto_landed row"))
    for run in runs:
        if (
            run["target"] != t
            or run["workflow_file"]
            not in ["sync-upstream.yml", "fork-push-nightly.yml"]
            or run["conclusion"] != "success"
            or run["noop"]
        ):
            continue
        f = p / "evidence/logs" / f"{run['id']}-{run['run_attempt']}.txt"
        txt = f.read_text()
        for line in txt.splitlines():
            if (
                re.search(r"\b(?:HEAD|[0-9a-f]{7,40}|main) -> main\b", line)
                and "[command]" not in line
                and "echo " not in line
            ):
                m = re.search(r"\d{4}-\d\d-\d\dT\S+Z", line)
                if m:
                    publication.append((m[0], run["html_url"]))
    if r["first_sync"]:
        publication = [v for v in publication if dt(v[0]) >= dt(r["first_sync"])]
    publication.sort(key=lambda x: dt(x[0]))
    r["first_published_main_at"] = publication[0][0] if publication else None
    r["publication_evidence"] = publication[0][1] if publication else None
    r["elapsed_minutes_to_main"] = (
        (dt(publication[0][0]) - dt(r["first_sync"])).total_seconds() / 60
        if publication and r["first_sync"]
        else None
    )
    r["selection"] = (
        "sync-selected"
        if r["sync_runs"]
        else (
            "fork-push/release-only"
            if r["releases"] or any(x["target"] == t for x in runs)
            else "not selected"
        )
    )
    if r["selection"] == "not selected":
        r["unattended"] = "not applicable"
        r["human_intervention"] = "not applicable"
(p / "updates.json").write_text(json.dumps(rows, indent=2))
with (p / "updates.csv").open("w") as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0]) if rows else ["target"])
    w.writeheader()
    w.writerows(
        {k: json.dumps(v) if isinstance(v, (list, dict)) else v for k, v in r.items()}
        for r in rows
    )
print("selection", collections.Counter(r["selection"] for r in rows))
print("human", collections.Counter(r["human_intervention"] for r in rows))
print(
    "main timing coverage", sum(r["elapsed_minutes_to_main"] is not None for r in rows)
)

# Scope annotations to this query so a later or shorter report cannot reuse old counts.
run_ids = {str(r["id"]) for r in runs}
classes = {k: v for k, v in classes.items() if k.split(":")[0] in run_ids}
bot_ids = {
    str(r["run_id"])
    for r in bot
    if args.from_date <= r["created_at"][:10] <= args.to_date
}
botclasses = {k: v for k, v in botclasses.items() if k in bot_ids}
summary = {
    "workflow_attempts": len(runs),
    "workflow_runs": len({r["id"] for r in runs}),
    "upstream_nightlies": len(rows),
    "selection_counts": dict(collections.Counter(r["selection"] for r in rows)),
    "human_intervention_counts": dict(
        collections.Counter(r["human_intervention"] for r in rows)
    ),
    "github_failure_classifications": dict(
        collections.Counter(str(v["category"]) for v in classes.values())
    ),
    "bot_failure_classifications": dict(
        collections.Counter(str(v["category"]) for v in botclasses.values())
    ),
    "unknown_failure_classification_runs": [
        r["id"]
        for r in runs
        if r["conclusion"] == "failure"
        and str(r["id"]) not in classes
        and f"{r['id']}:{r['run_attempt']}" not in classes
    ],
    "timing_coverage": sum(r["elapsed_minutes_to_main"] is not None for r in rows),
}
(p / "summary.json").write_text(json.dumps(summary, indent=2))

if args.surface:
    import subprocess

    def git(*argv):
        return subprocess.check_output(["git", "-C", args.checkout, *argv], text=True)

    state = json.loads(git("show", "refs/stacks/stgit/adopt:stack.json"))
    if state["unapplied"]:
        raise SystemExit("Surface ledger requires a fully applied stack")
    base = git("rev-parse", state["patches"][state["applied"][0]]["oid"] + "^").strip()
    counts = collections.Counter(
        x
        for x in git(
            "log",
            base,
            "--since=" + args.from_date + "T00:00:00Z",
            "--until=" + args.to_date + "T23:59:59Z",
            "--format=",
            "--name-only",
        ).splitlines()
        if x
    )
    upstream = set(git("ls-tree", "-r", "--name-only", base).splitlines())
    patches = []
    for name in state["applied"]:
        oid = state["patches"][name]["oid"]
        files = git(
            "diff-tree", "--no-commit-id", "--name-only", "-r", oid
        ).splitlines()
        edited = [
            {"path": f, "upstream_commits": counts[f]} for f in files if f in upstream
        ]
        patches.append(
            {
                "patch": name,
                "oid": oid,
                "in_place": sorted(
                    edited, key=lambda x: (-x["upstream_commits"], x["path"])
                ),
                "additive_files": len(files) - len(edited),
                "upstream_touch_sum": sum(counts[f] for f in files if f in upstream),
            }
        )
    (p / "conflict-surface.json").write_text(
        json.dumps(
            {
                "base": base,
                "head": state["head"],
                "from": args.from_date,
                "to": args.to_date,
                "patches": patches,
            },
            indent=2,
        )
    )
