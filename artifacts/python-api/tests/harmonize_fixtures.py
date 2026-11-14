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
import warnings
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


# ---------------------------------------------------------------------------
# Real report.json dicts, generated offline by the package with a fake mapper
# ---------------------------------------------------------------------------

# What the fake mapper answers, by name: (chosen_kg_id, kg_equivalent_ids). A name not listed
# resolves to nothing (an unresolved row). Synthetic panel metadata only.
_GLUCOSE = ("CHEBI:4167", {"HMDB": ["HMDB0000122"]})
_LEUCINE = ("CHEBI:25017", {"HMDB": ["HMDB0000687"]})
_ANSWERS: dict[str, tuple[str, dict[str, list[str]]]] = {
    "Glucose": _GLUCOSE,
    "D-Glucose": _GLUCOSE,
    "Leucine": _LEUCINE,
    "Isoleucine": _LEUCINE,  # two rows on one node: the ambiguous link / multiplicity group
    "Leucine/Isoleucine": _LEUCINE,
    # Same HMDB on two different chosen nodes: an identifier link across nodes (cross-node).
    "Lactate": ("CHEBI:24996", {"HMDB": ["HMDB0000190"]}),
    "L-Lactic acid": ("CHEBI:422", {"HMDB": ["HMDB0000190"]}),
}
# What a one-sided code resolves to on its own (the two-cohort review pass): a different node.
_CODE_ANSWERS: dict[str, tuple[str, dict[str, list[str]]]] = {
    "C00031": ("CHEBI:17634", {"KEGG": ["C00031"]}),
}


def fake_mapper(records: list[dict[str, Any]], *, entity_type: str,
                annotation_mode: str) -> list[Any]:
    """A ``biomapper`` mapper callable that answers from fixed tables, with no network."""
    from biomapper import MappingResult

    out = []
    for rec in records:
        name = rec["name"]
        codes = [c for cs in (rec.get("identifiers") or {}).values() for c in cs]
        hit = None
        if annotation_mode == "none" and codes:
            hit = _CODE_ANSWERS.get(codes[0])
        if hit is None:
            hit = _ANSWERS.get(name)
        if hit is None:
            out.append(MappingResult(query_name=name))
        else:
            node, equivalents = hit
            out.append(MappingResult(query_name=name, resolved=True, primary_curie=node,
                                     chosen_kg_id=node, kg_equivalent_ids=equivalents))
    return out


def _json_round_trip(value: dict[str, Any]) -> dict[str, Any]:
    """The report exactly as ``report.json`` holds it."""
    return json.loads(json.dumps(value))


def make_two_cohort_report(*, shared_vocabulary: bool = True) -> dict[str, Any]:
    """A real ``harmonize_cohorts`` report.

    Cohort ``a`` declares HMDB and KEGG, cohort ``b`` HMDB (or nothing when
    ``shared_vocabulary`` is False, which skips the identifier arm: ``arms.identifier`` is
    ``None``). It holds a one-to-one link (Glucose), two ambiguous links (Leucine and
    Isoleucine both to Leucine/Isoleucine), a review-queue item (a's KEGG code disagrees with
    its name) and one unresolved row per cohort.
    """
    from biomapper import harmonize_cohorts

    a = [
        {"id": "a1", "name": "Glucose", "hmdb": "HMDB0000122", "kegg": "C00031"},
        {"id": "a2", "name": "Leucine", "hmdb": "HMDB0000687", "kegg": ""},
        {"id": "a3", "name": "Isoleucine", "hmdb": "", "kegg": ""},
        {"id": "a4", "name": "Mystery peak 12", "hmdb": "", "kegg": ""},
    ]
    b = [
        {"id": "b1", "name": "D-Glucose", "hmdb": "HMDB0000122"},
        {"id": "b2", "name": "Leucine/Isoleucine", "hmdb": ""},
        {"id": "b3", "name": "Unknown 7", "hmdb": ""},
    ]
    with warnings.catch_warnings():
        # The package warns about every one-sided vocabulary; that is the point of this input.
        warnings.simplefilter("ignore", UserWarning)
        report = harmonize_cohorts(
            a, b, entity="metabolites", a_key_column="id", b_key_column="id",
            a_vocabularies={"HMDB": "hmdb", "KEGG": "kegg"},
            b_vocabularies={"HMDB": "hmdb"} if shared_vocabulary else None,
            mapper=fake_mapper, probe_pins=False, save=False,
        )
    return _json_round_trip(report.to_dict())


def make_many_cohort_report() -> dict[str, Any]:
    """A real ``harmonize_many`` report over cohorts ``a``, ``b`` and ``c``.

    Every cohort declares HMDB, so both arms run. It holds a plain group (Glucose in all
    three), a group with multiplicity (Leucine and Isoleucine in ``a``), a cross-node entry
    (Lactate in ``a`` and L-Lactic acid in ``b`` share an HMDB on different nodes), an
    identifier check that does not confirm (``c``'s Glucose declares the wrong HMDB) and a
    row that is not grouped (``c``'s unresolved name).
    """
    from biomapper import harmonize_many

    cohorts = {
        "a": [{"id": "a1", "name": "Glucose", "hmdb": "HMDB0000122"},
              {"id": "a2", "name": "Leucine", "hmdb": ""},
              {"id": "a3", "name": "Isoleucine", "hmdb": ""},
              {"id": "a4", "name": "Lactate", "hmdb": "HMDB0000190"}],
        "b": [{"id": "b1", "name": "D-Glucose", "hmdb": "HMDB0000122"},
              {"id": "b2", "name": "Leucine", "hmdb": ""},
              {"id": "b3", "name": "L-Lactic acid", "hmdb": "HMDB0000190"}],
        "c": [{"id": "c1", "name": "Glucose", "hmdb": "HMDB0000999"},
              {"id": "c2", "name": "Mystery peak 12", "hmdb": ""}],
    }
    report = harmonize_many(
        cohorts, entity="metabolites", key_columns={k: "id" for k in cohorts},
        vocabularies={k: {"HMDB": "hmdb"} for k in cohorts},
        mapper=fake_mapper, probe_pins=False, save=False,
    )
    return _json_round_trip(report.to_dict())


def make_results_report() -> dict[str, Any]:
    """The ``harmonize_results`` report shape (offline harmonize of two finished mapping jobs).

    ``arms.names_only`` is ``biomapper.harmonize.harmonize(...).to_dict()`` (no row names, no
    ``unresolved_rows``; ``unresolved`` lists keys), ``arms.identifier`` is ``None`` and there is
    no ``review_queue``.
    """
    from biomapper.cohorts import name_linking_info, resolve_category
    from biomapper.harmonize import harmonize

    a = fake_mapper([{"name": n} for n in ("Glucose", "Leucine", "Isoleucine", "Mystery peak 12")],
                    entity_type="", annotation_mode="missing")
    b = fake_mapper([{"name": n} for n in ("D-Glucose", "Leucine/Isoleucine", "Unknown 7")],
                    entity_type="", annotation_mode="missing")
    result = harmonize(a, b, a_label="a", b_label="b", link_by_name=True)
    return _json_round_trip({
        "schema_version": 1,
        "kind": "harmonize_results",
        "labels": ["a", "b"],
        "name_linking": name_linking_info(resolve_category("metabolites", None)),
        "arms": {"names_only": result.to_dict(), "identifier": None},
    })


def write_recording(root: Path, *, two_cohort_report: dict[str, Any] | None = None,
                    many_cohort_report: dict[str, Any] | None = None) -> Path:
    """Write a synthetic recordings directory under ``root`` and return it.

    ``report.json`` is a minimal stub unless a real report is given for that kind.
    """
    reports = {"two_cohort": two_cohort_report, "many_cohort": many_cohort_report}
    for sub, kind, labels in (("two_cohort", "harmonize_cohorts", ["a", "b"]),
                              ("many_cohort", "harmonize_many", ["a", "b", "c"])):
        d = root / sub
        d.mkdir(parents=True, exist_ok=True)
        status = _status(kind, labels)
        HarmonizeStatus.model_validate(status)  # the recording must be a real status
        (d / "status.json").write_text(json.dumps(status), encoding="utf-8")
        (d / "progress.jsonl").write_text(
            "".join(json.dumps(p) + "\n" for p in _progress(kind, labels)), encoding="utf-8")
        report = reports[sub] or {"schema_version": 1, "kind": kind, "cohorts": labels,
                                  "links": []}
        (d / "report.json").write_text(json.dumps(report), encoding="utf-8")
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
