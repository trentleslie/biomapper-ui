"""Record one live harmonization run of a built-in example for ``ReplayBackend``.

Usage, from ``artifacts/python-api``::

    .venv/bin/python scripts/record_harmonize_run.py two_cohort
    .venv/bin/python scripts/record_harmonize_run.py many_cohort [--out DIR]

Runs the example in ``data/harmonize_examples/<kind>/`` through the real backend (the package's
``HarmonizeJobs``, pointed at the deployment and key the app is configured with: the public,
keyless one by default). It always saves, by default to a new
``data/harmonize/recordings/<kind>-<UTC stamp>/`` (``--out`` overrides the folder), and prints
where. The recording is ``<out>/recording/``:

* ``progress.jsonl``: every ``on_progress`` update, one ``HarmonizeProgress.to_dict()`` per line.
* ``status.json``: the finished ``HarmonizeStatus``.
* ``report.json``: the finished report.
* ``review_items.json``: ``{"skipped_no_node", "items", "details"}``, every review item.
* ``PINS.md``: biomapper version, the report's pins, UTC date, command, this repo's git SHA.

Paths in the recording are relative to the job's root (``inputs/a.tsv``, ``report``, ``store``); no absolute path
or key is written. ``<out>/work/`` holds the job's home and inputs. An interrupted run is not
resumed: run the script again into a new folder. To install a recording, copy
``<out>/recording/`` over ``data/harmonize_examples/<kind>/recording/``.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import shlex
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from importlib.metadata import version
from pathlib import Path
from typing import Any

API_DIR = Path(__file__).resolve().parent.parent
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

from biomapper.jobs import FINISHED_STATES, HarmonizeProgress  # noqa: E402

from routes.harmonize import EXAMPLES_DIR, CohortsSpec, ManySpec, example_files  # noqa: E402
from services.harmonize_backend import _api_key, real_backend  # noqa: E402
from services.mapper import MapperService  # noqa: E402

KINDS = ("two_cohort", "many_cohort")
REVIEW_PAGE = 50


def _stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _git_sha() -> str:
    try:
        sha = subprocess.run(["git", "rev-parse", "HEAD"], cwd=API_DIR, check=True,
                             capture_output=True, text=True).stdout.strip()
        dirty = subprocess.run(["git", "status", "--porcelain"], cwd=API_DIR, check=True,
                               capture_output=True, text=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return "unknown"
    return f"{sha} (working tree had uncommitted changes)" if dirty else sha


def _relative(value: Any, root: str) -> Any:
    """``value`` with every string under ``root`` made relative to it (``inputs/a.tsv``,
    ``report``, ``store``), at any depth."""
    if isinstance(value, dict):
        return {k: _relative(v, root) for k, v in value.items()}
    if isinstance(value, list):
        return [_relative(v, root) for v in value]
    if isinstance(value, str) and (value == root or value.startswith(root + "/")):
        return value[len(root) + 1:] or "."
    return value


def _review_dump(backend: Any, job_id: str) -> dict[str, Any]:
    items: list[dict[str, Any]] = []
    offset: int | None = 0
    skipped = 0
    while offset is not None:
        page = backend.review_items(job_id, offset=offset, limit=REVIEW_PAGE)
        skipped = page.skipped_no_node
        items.extend(i.model_dump(mode="json") for i in page.items)
        offset = page.next_offset
    details = {i["ref"]: backend.review_item(job_id, i["ref"]).model_dump(mode="json")
               for i in items}
    return {"skipped_no_node": skipped, "items": items, "details": details}


def _pins_md(kind: str, report: dict[str, Any], command: str, started: str) -> str:
    pins = json.dumps(report.get("pins"), indent=2, sort_keys=True)
    return (
        f"# Recording pins: {kind}\n\n"
        f"- biomapper version: {version('biomapper')}\n"
        f"- recorded (UTC): {started}\n"
        f"- command (from `artifacts/python-api`): `{command}`\n"
        f"- biomapper-ui git SHA: {_git_sha()}\n\n"
        "The report's `pins` block:\n\n"
        f"```json\n{pins}\n```\n"
    )


def _check_no_paths(recording: Path, forbidden: list[str]) -> None:
    for path in recording.iterdir():
        text = path.read_text(encoding="utf-8")
        for needle in forbidden:
            if needle and needle in text:
                raise SystemExit(f"{recording / path.name} contains a local path ({needle!r}); "
                                 "do not install this recording.")


async def record(kind: str, out: Path, command: str) -> Path:
    example = EXAMPLES_DIR / kind
    spec_raw = (example / "spec.json").read_text(encoding="utf-8")
    model = CohortsSpec if kind == "two_cohort" else ManySpec
    spec = model.model_validate_json(spec_raw)
    cohorts = [spec.a, spec.b] if kind == "two_cohort" else list(spec.cohorts)
    sources = example_files(example, kind, [c.label for c in cohorts])

    work = out / "work"
    inputs = work / "runs" / "inputs"
    inputs.mkdir(parents=True, exist_ok=True)
    recording = out / "recording"
    recording.mkdir(parents=True, exist_ok=True)
    specs = []
    for cohort, src in zip(cohorts, sources):
        dest = inputs / src.name
        shutil.copyfile(src, dest)
        specs.append(cohort.to_spec(dest))

    progress_path = recording / "progress.jsonl"
    progress_path.write_text("", encoding="utf-8")  # one attempt per recording
    started = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    def on_progress(job_id: str, p: HarmonizeProgress) -> None:
        with progress_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(p.to_dict()) + "\n")
        print(f"  {job_id} {p.to_dict()}", flush=True)

    async with real_backend(work / "home", [work / "runs"], base_url=MapperService._get_base_url(),
                            api_key=_api_key(), on_progress=on_progress) as backend:
        report_dir = work / "runs" / "report"
        if kind == "two_cohort":
            status = await backend.submit_cohorts(specs[0], specs[1], entity=spec.entity,
                                                  category=spec.category, output_dir=report_dir)
        else:
            status = await backend.submit_many(specs, entity=spec.entity, category=spec.category,
                                               output_dir=report_dir,
                                               store_dir=work / "runs" / "store",
                                               remap_all=spec.remap_all)
        print(f"job {status.job_id}: {status.state}, {status.entities_total} entities", flush=True)
        done = await backend.wait(status.job_id, poll_s=5.0)
        if done.state not in FINISHED_STATES:
            raise SystemExit(
                f"job {done.job_id} ended {done.state}: {done.reason}. Nothing was recorded; "
                "run the script again.")
        report = backend.load_report(done.job_id)
        review = _review_dump(backend, done.job_id)

    status_json = _relative(done.model_dump(mode="json"), str(work / "runs"))
    (recording / "status.json").write_text(json.dumps(status_json, indent=1) + "\n",
                                           encoding="utf-8")
    shutil.copyfile(report_dir / "report.json", recording / "report.json")
    (recording / "review_items.json").write_text(json.dumps(review, indent=1) + "\n",
                                                 encoding="utf-8")
    (recording / "PINS.md").write_text(_pins_md(kind, report, command, started),
                                       encoding="utf-8")
    _check_no_paths(recording, [str(out.resolve()), str(API_DIR), str(Path.home())])
    return recording


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("kind", choices=KINDS)
    parser.add_argument("--out", type=Path, default=None,
                        help="folder to save into (default: a new timestamped folder)")
    args = parser.parse_args(argv)
    out = args.out or API_DIR / "data" / "harmonize" / "recordings" / f"{args.kind}-{_stamp()}"
    out = out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    words = ["python", "scripts/record_harmonize_run.py", args.kind]
    if args.out is not None:
        # As given, relative to artifacts/python-api, so no absolute path reaches PINS.md.
        words += ["--out", os.path.relpath(out, API_DIR)]
    command = shlex.join(words)
    print(f"Recording {args.kind} into {out}", flush=True)
    recording = asyncio.run(record(args.kind, out, command))
    print(f"Saved the recording to {recording}")


if __name__ == "__main__":
    main()
