"""Reusable harmonization test helpers: a synthetic replay recording and a local mapping API stub.

``write_recording(root)`` builds a recordings directory in the layout ``ReplayBackend`` reads:
``two_cohort/`` and ``many_cohort/``, each with ``report.json``, ``status.json`` (a finished
``HarmonizeStatus`` dump), ``progress.jsonl`` (one ``HarmonizeProgress.to_dict()`` per line) and
``review_items.json`` (``{"skipped_no_node", "items": [ReviewItemSummary], "details": {ref:
ReviewItemDetail}}``). The ``recording_dir`` and ``stub_api`` fixtures in ``conftest.py`` wrap
these. Everything here is synthetic panel metadata; no participant data.
"""
from __future__ import annotations

import asyncio
import json
import threading
import time
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from biomapper.jobs import WAITING_STATES, HarmonizeStatus

_ROW_REF = "r-glucose"
_LINK_REF = "l-lactate"


def _status(kind: str, labels: list[str]) -> dict[str, Any]:
    return {
        "job_id": "recorded-job",
        "state": "complete",
        "reason": None,
        "kind": kind,
        "stage": "done",
        "cohorts": [{"label": lb, "path": f"/recorded/{lb}.tsv", "rows": 3} for lb in labels],
        "entity": "metabolites",
        "output_dir": "/recorded/out",
        "store_dir": "/recorded/store" if kind == "harmonize_many" else None,
        "entities_total": 4,
        "entities_mapped": 4,
        "rows_errored": 0,
        "eta_s": None,
        "kg_build": "synthetic-build",
        "kg_verified": False,
        "owner": None,
        "created_utc": "2026-11-13T00:00:00Z",
        "updated_utc": "2026-11-13T00:01:00Z",
        "summary": {"links": 2, "warnings": []},
        "review_items": {"row": 1, "link": 1, "skipped_no_node": 0,
                         "candidates_captured": 1, "candidates_not_captured": 0},
        "progress": {"function": kind, "arm": "names_only", "cohort": None,
                     "cohorts": labels, "entities_done": 4, "entities_total": 4},
    }


def _progress(kind: str, labels: list[str]) -> list[dict[str, Any]]:
    cohort_of = (lambda lb: lb) if kind == "harmonize_cohorts" else (lambda lb: None)
    lines = []
    for lb in labels[: 2 if kind == "harmonize_cohorts" else 1]:
        for done in (0, 2, 4):
            lines.append({"function": kind, "arm": "names_only", "cohort": cohort_of(lb),
                          "cohorts": labels, "entities_done": done, "entities_total": 4})
    return lines


def _review(labels: list[str]) -> dict[str, Any]:
    row = {"cohort": labels[0], "key": "1", "name": "Glucose"}
    side = {"node": "CHEBI:4167", "node_name": "D-glucose", "node_name_status": "captured",
            "rows": [row], "n_rows": 1, "certificate_states": {"corroborated": 1},
            "identifiers": {"HMDB": ["HMDB0000122"]}}
    return {
        "skipped_no_node": 0,
        "items": [
            {"ref": _ROW_REF, "kind": "row", "impact": 2, "label": "Glucose",
             "reasons": ["uncorroborated"], "engine_choice": "CHEBI:4167", "nodes": [],
             "n_rows": 2, "cohorts": labels[:1], "evidence": "present", "suggestion": None},
            {"ref": _LINK_REF, "kind": "link", "impact": 1, "label": "Lactate | L-Lactate",
             "reasons": ["name"], "engine_choice": None, "nodes": ["CHEBI:1", "CHEBI:2"],
             "n_rows": 2, "cohorts": labels[:2], "evidence": "names_captured",
             "suggestion": None},
        ],
        "details": {
            _ROW_REF: {
                "ref": _ROW_REF, "kind": "row", "job_id": "recorded-job", "impact": 2,
                "row": {"name": "Glucose", "category": "biolink:SmallMolecule",
                        "weak_trigger": "uncorroborated", "engine_choice": "CHEBI:4167",
                        "certificate_state": "uncorroborated", "rows": [row], "n_rows": 2,
                        "cohorts": labels[:1], "candidates_status": "present"},
                "next_step": "get_candidates with this ref",
            },
            _LINK_REF: {
                "ref": _LINK_REF, "kind": "link", "job_id": "recorded-job", "impact": 1,
                "link": {"link_kind": "two_cohort", "basis": "name", "bases": ["name"],
                         "review_reasons": [], "n_row_pairs": 1, "cohorts": labels[:2],
                         "question": "Same entity?", "a": side, "b": side},
                "next_step": "record_suggestion",
            },
        },
    }


def write_recording(root: Path) -> Path:
    """Write a synthetic recordings directory under ``root`` and return it."""
    for sub, kind, labels in (("two_cohort", "harmonize_cohorts", ["a", "b"]),
                              ("many_cohort", "harmonize_many", ["a", "b", "c"])):
        d = root / sub
        d.mkdir(parents=True, exist_ok=True)
        status = _status(kind, labels)
        HarmonizeStatus.model_validate(status)  # the recording must be a real status
        (d / "status.json").write_text(json.dumps(status), encoding="utf-8")
        (d / "progress.jsonl").write_text(
            "".join(json.dumps(p) + "\n" for p in _progress(kind, labels)), encoding="utf-8")
        (d / "report.json").write_text(
            json.dumps({"schema_version": 1, "kind": kind, "cohorts": labels, "links": []}),
            encoding="utf-8")
        (d / "review_items.json").write_text(json.dumps(_review(labels)), encoding="utf-8")
    return root


async def wait_finished(backend: Any, job_id: str, *, timeout_s: float = 60.0,
                        poll_s: float = 0.05) -> HarmonizeStatus:
    """Poll ``backend.status`` until the job leaves queued/running."""
    deadline = time.monotonic() + timeout_s
    while True:
        st = await backend.status(job_id)
        if st.state not in WAITING_STATES:
            return st
        if time.monotonic() > deadline:
            raise TimeoutError(f"job {job_id} still {st.state} after {timeout_s}s")
        await asyncio.sleep(poll_s)


# ---------------------------------------------------------------------------
# Local stub of the BioMapper mapping API (and Kestrel /health)
# ---------------------------------------------------------------------------


@dataclass
class StubApi:
    url: str
    kestrel_url: str
    batch_calls: list[int]


def _result(name: str) -> dict[str, Any]:
    curie = f"CHEBI:{abs(hash(name.lower())) % 100000}"
    return {
        "name": name,
        "curies": [curie],
        "primary_curie": curie,
        "chosen_kg_id": curie,
        "kg_equivalent_ids": {"CHEBI": [curie]},
        "resolution_certificate": {"state": "corroborated"},
    }


def start_stub_api(delay_s: float = 0.25) -> tuple[StubApi, ThreadingHTTPServer]:
    """Serve ``/health``, ``/map/batch``, ``/map/entity`` and ``/kestrel/health`` on localhost.

    Every ``/map/batch`` request sleeps ``delay_s`` first, so a job is still running when a
    test closes the runner.
    """
    batch_calls: list[int] = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args: Any) -> None:  # keep test output quiet
            pass

        def _send(self, payload: Any, status: int = 200) -> None:
            body = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802
            if self.path.endswith("/kestrel/health"):
                self._send({"kestrel_version": "stub", "kg_build": {"kg_label": "stub-kg"}})
            elif self.path.endswith("/health"):
                self._send({"status": "healthy", "version": "stub", "mapper_initialized": True})
            else:
                self._send({"detail": "not found"}, 404)

        def do_POST(self) -> None:  # noqa: N802
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
            if self.path.endswith("/map/batch"):
                entities = body.get("entities", [])
                batch_calls.append(len(entities))
                time.sleep(delay_s)
                self._send({"results": [_result(e.get("name", "")) for e in entities]})
            elif self.path.endswith("/map/entity"):
                self._send({"result": _result(body.get("name", ""))})
            else:
                self._send({"detail": "not found"}, 404)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    return StubApi(url=base, kestrel_url=f"{base}/kestrel", batch_calls=batch_calls), server
