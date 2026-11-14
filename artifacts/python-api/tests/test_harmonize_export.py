"""Exports of a finished harmonization run: CSV, TSV, JSON and the EITL pairs file.

Every report here is a real package-generated report (tests/harmonize_fixtures.py).
"""
import copy
import csv
import io
import json
import time

import pytest
from fastapi.testclient import TestClient

from biomapper.jobs import FINISHED_STATES
from services.harmonize_export import (
    EITL_COLUMNS,
    FORMATS,
    TABLES,
    export_filename,
    export_rows,
    neutralize,
    render,
    skipped_one_sided,
)
from services.harmonize_items import items_from_report, with_flags

U1 = {"x-clerk-user-id": "user-1"}
U2 = {"x-clerk-user-id": "user-2"}


def flags_for(report, flagged_refs=None):
    """Effective flags: biomapper's suggestions, or exactly ``flagged_refs`` when given."""
    items = items_from_report(report)
    if flagged_refs is None:
        return with_flags(items, {})
    return with_flags(items, {i.ref: i.ref in flagged_refs for i in items})


def ref_of(report, kind, arm, keys):
    """The ref of the item of ``kind`` in ``arm`` whose member keys are exactly ``keys``."""
    return next(i.ref for i in items_from_report(report)
                if i.kind == kind and i.arm == arm and [m["key"] for m in i.members] == keys)


def parse(body, fmt):
    if fmt == "json":
        return json.loads(body)
    reader = csv.reader(io.StringIO(body.decode("utf-8"), newline=""),
                        delimiter="," if fmt == "csv" else "\t")
    return list(reader)


# ---------------------------------------------------------------------------
# EITL pairs
# ---------------------------------------------------------------------------


def test_eitl_pairs_is_exactly_the_flagged_two_sided_set(two_cohort_report):
    link = ref_of(two_cohort_report, "link", "names_only", ["a1", "b1"])
    header, rows = export_rows(two_cohort_report, flags_for(two_cohort_report, {link}),
                               "eitl_pairs")
    assert header == ["source_text", "source_id", "source_dataset", "target_text", "target_id",
                      "target_dataset", "pair_type", "resolution_layer"]
    assert len(rows) == 1 and rows[0]["source_dataset"] != rows[0]["target_dataset"]
    assert rows[0] == {"source_text": "Glucose", "source_id": "a1", "source_dataset": "a",
                       "target_text": "D-Glucose", "target_id": "b1", "target_dataset": "b",
                       "pair_type": "metabolites", "resolution_layer": "unspecified"}


def test_eitl_pairs_default_flags_take_flagged_links_and_skip_one_sided(two_cohort_report):
    flagged = flags_for(two_cohort_report)
    _, rows = export_rows(two_cohort_report, flagged, "eitl_pairs")
    # biomapper suggests the ambiguous links (a2-b2, a3-b2) in both arms; the same pair in two
    # arms is one EITL pair.
    assert [(r["source_id"], r["target_id"]) for r in rows] == [("a2", "b2"), ("a3", "b2")]
    # Flagged review items (withheld name pairs, possible misses, review queue) are skipped,
    # even the two-member withheld pair.
    expected = sum(f.flagged and f.item.kind in ("review", "unresolved") for f in flagged)
    assert expected > 0 and skipped_one_sided(flagged) == expected


def test_flagged_unresolved_rows_are_counted_not_paired(two_cohort_report):
    refs = {i.ref for i in items_from_report(two_cohort_report) if i.kind == "unresolved"}
    flagged = flags_for(two_cohort_report, refs)
    assert export_rows(two_cohort_report, flagged, "eitl_pairs")[1] == []
    assert skipped_one_sided(flagged) == len(refs)


def test_group_of_n_expands_to_n_minus_one_pairs(many_cohort_report):
    glucose = ref_of(many_cohort_report, "group", "names_only", ["a1", "b1", "c1"])
    leucine = ref_of(many_cohort_report, "group", "names_only", ["a2", "a3", "b2"])
    single = ref_of(many_cohort_report, "group", "names_only", ["b3"])
    flagged = flags_for(many_cohort_report, {glucose, leucine, single})
    _, rows = export_rows(many_cohort_report, flagged, "eitl_pairs")
    # Each other member against the first member (label order, then key).
    assert [(r["source_dataset"], r["source_id"], r["target_dataset"], r["target_id"])
            for r in rows] == [("a", "a2", "a", "a3"), ("a", "a2", "b", "b2"),
                               ("a", "a1", "b", "b1"), ("a", "a1", "c", "c1")]
    assert all(r["pair_type"] == "metabolites" for r in rows)
    # The one-member group gives no pair and is counted as one-sided.
    assert skipped_one_sided(flagged) == 1


def test_group_members_follow_report_label_order(many_cohort_report):
    glucose = ref_of(many_cohort_report, "group", "names_only", ["a1", "b1", "c1"])
    report = {**many_cohort_report, "labels": ["c", "b", "a"]}
    _, rows = export_rows(report, flags_for(report, {glucose}), "eitl_pairs")
    assert [(r["source_id"], r["target_id"]) for r in rows] == [("c1", "b1"), ("c1", "a1")]


def test_eitl_text_falls_back_to_key_without_a_name(results_report):
    flagged = flags_for(results_report, {i.ref for i in items_from_report(results_report)
                                         if i.kind == "link"})
    _, rows = export_rows(results_report, flagged, "eitl_pairs")
    assert rows and all(r["source_text"] == r["source_id"] and r["target_text"] == r["target_id"]
                        for r in rows)


def test_eitl_text_falls_back_to_key_for_a_whitespace_only_name(two_cohort_report):
    report = copy.deepcopy(two_cohort_report)

    def blank_a1(node):
        if isinstance(node, dict):
            if node.get("key") == "a1" and "name" in node:
                node["name"] = "   "
            if node.get("a_key") == "a1" and "a_name" in node:
                node["a_name"] = "   "
            for v in node.values():
                blank_a1(v)
        elif isinstance(node, list):
            for v in node:
                blank_a1(v)

    blank_a1(report)
    link = ref_of(report, "link", "names_only", ["a1", "b1"])
    _, rows = export_rows(report, flags_for(report, {link}), "eitl_pairs")
    assert len(rows) == 1
    assert rows[0]["source_id"] == "a1" and rows[0]["source_text"] == "a1"
    assert rows[0]["target_text"] == "D-Glucose"


# The acceptance rule of expert-in-the-loop's pairs upload, read from
# expert-in-the-loop origin/main 222e4b2c2434d5160b03acae283e955d147f0a21:
#   server/routes.ts, POST /api/campaigns/:id/pairs. The JSON branch requires non-empty
#   sourceText, sourceId, targetText, targetId (source_text || sourceText, ...). The CSV file
#   branch parses with csv-parse `parse(content, {columns: true, skip_empty_lines: true,
#   trim: true})` (default delimiter ","), reading row.source_text, row.source_id,
#   row.source_dataset, row.target_text, row.target_id, row.target_dataset, row.pair_type and
#   row.resolution_layer. The JSON file branch reads `parsed.pairs || parsed`. Every pair's
#   resolution_layer must be one of RESOLUTION_LAYER_VALUES (shared/campaignConfig.ts).
EITL_REQUIRED = ("source_text", "source_id", "target_text", "target_id")
EITL_RESOLUTION_LAYERS = ("authoritative_xref", "ai_assisted", "manual", "unspecified")


def eitl_accepts(pairs):
    return bool(pairs) and all(
        all((p.get(f) or "").strip() for f in EITL_REQUIRED)
        and (p.get("resolution_layer") or "unspecified") in EITL_RESOLUTION_LAYERS
        for p in pairs)


@pytest.mark.parametrize("report_name", ["two_cohort_report", "many_cohort_report",
                                         "results_report"])
def test_eitl_file_is_accepted_by_eitl_parser(report_name, request):
    report = request.getfixturevalue(report_name)
    every = {i.ref for i in items_from_report(report)}
    header, rows = export_rows(report, flags_for(report, every), "eitl_pairs")
    assert header == EITL_COLUMNS
    body, media = render(header, rows, "csv")
    assert media == "text/csv"
    # The CSV branch: comma-delimited, header row as column names, cells trimmed.
    records = [{k: v.strip() for k, v in r.items()}
               for r in csv.DictReader(io.StringIO(body.decode("utf-8"), newline=""))]
    assert list(records[0]) == EITL_COLUMNS
    assert eitl_accepts(records) and len(records) == len(rows)
    # The JSON branch: a list of pair objects (parsed.pairs || parsed).
    body, media = render(header, rows, "json")
    assert media == "application/json"
    pairs = json.loads(body)
    assert isinstance(pairs, list) and eitl_accepts(pairs) and pairs == rows


# ---------------------------------------------------------------------------
# Item tables
# ---------------------------------------------------------------------------


def test_links_table_columns(two_cohort_report):
    header, rows = export_rows(two_cohort_report, flags_for(two_cohort_report), "links")
    assert header[:5] == ["ref", "arm", "flagged", "flag_source", "suggested"]
    assert header[5:13] == ["a_key", "a_name", "a_chosen_kg_id", "b_key", "b_name",
                            "b_chosen_kg_id", "member_count", "basis"]
    assert {"one_to_one", "ambiguous", "review_reasons", "origin"} <= set(header)
    assert len(rows) == 6 and {r["arm"] for r in rows} == {"names_only", "identifier"}
    first = rows[0]
    assert (first["a_key"], first["a_name"], first["b_key"], first["basis"]) == (
        "a1", "Glucose", "b1", "node")
    assert (first["flagged"], first["flag_source"], first["member_count"]) == (
        False, "biomapper", 2)


def test_organizer_flag_shows_in_tables(two_cohort_report):
    link = ref_of(two_cohort_report, "link", "names_only", ["a1", "b1"])
    flagged = with_flags(items_from_report(two_cohort_report), {link: True})
    _, rows = export_rows(two_cohort_report, flagged, "links")
    row = next(r for r in rows if r["ref"] == link)
    assert (row["flagged"], row["flag_source"]) == (True, "organizer")


def test_table_that_does_not_apply_has_header_and_no_rows(two_cohort_report,
                                                          many_cohort_report):
    header, rows = export_rows(two_cohort_report, flags_for(two_cohort_report), "groups")
    assert rows == [] and "a_key" in header and "flagged" in header
    header, rows = export_rows(many_cohort_report, flags_for(many_cohort_report), "links")
    assert rows == [] and "c_chosen_kg_id" in header
    body, _ = render(header, rows, "csv")
    assert parse(body, "csv") == [header]


def test_multiplicity_joins_same_cohort_members(many_cohort_report):
    flagged = flags_for(many_cohort_report)
    header, rows = export_rows(many_cohort_report, flagged, "groups")
    row = next(r for r in rows if r["node"] == "CHEBI:25017" and r["arm"] == "names_only")
    assert (row["a_key"], row["a_name"]) == ("a2 | a3", "Leucine | Isoleucine")
    assert (row["b_key"], row["c_key"], row["member_count"]) == ("b2", "", 3)
    # JSON keeps the members as a list, ordered by label then key.
    header, rows = export_rows(many_cohort_report, flagged, "groups", nested=True)
    assert "members" in header and "a_key" not in header
    row = next(r for r in rows if r["node"] == "CHEBI:25017" and r["arm"] == "names_only")
    assert row["members"] == [
        {"cohort": "a", "key": "a2", "name": "Leucine", "chosen_kg_id": "CHEBI:25017"},
        {"cohort": "a", "key": "a3", "name": "Isoleucine", "chosen_kg_id": "CHEBI:25017"},
        {"cohort": "b", "key": "b2", "name": "Leucine", "chosen_kg_id": "CHEBI:25017"}]
    assert row["member_count"] == 3


def test_review_table_holds_every_review_reason(two_cohort_report, many_cohort_report):
    _, rows = export_rows(two_cohort_report, flags_for(two_cohort_report), "review")
    assert {r["origin"] for r in rows} == {"review_queue", "name_match_withheld",
                                           "possible_missed"}
    assert {r["reason"] for r in rows} >= {"possible_missed", "name_match_withheld"}
    _, rows = export_rows(many_cohort_report, flags_for(many_cohort_report), "review")
    assert {r["origin"] for r in rows} == {"cross_node", "id_check_review", "withheld"}
    cross = next(r for r in rows if r["origin"] == "cross_node")
    assert (cross["a_key"], cross["b_key"], cross["member_count"]) == ("a4", "b3", 2)


def test_unresolved_table_includes_errored_rows_with_status(two_cohort_report,
                                                            many_cohort_report):
    for report in (two_cohort_report, many_cohort_report):
        _, rows = export_rows(report, flags_for(report), "unresolved")
        errored = [r for r in rows if r["status"] == "errored"]
        assert errored and all(r["error"] == "simulated mapping failure" for r in errored)
        assert {r["status"] for r in rows} == {"unresolved", "errored"}


def test_null_identifier_arm_exports_names_only_rows_without_error(
        two_cohort_report_names_only):
    report = two_cohort_report_names_only
    flagged = flags_for(report)
    for table in TABLES:
        for fmt in FORMATS:
            if table == "eitl_pairs" and fmt == "tsv":
                continue
            header, rows = export_rows(report, flagged, table, nested=fmt == "json")
            render(header, rows, fmt)
            if table != "eitl_pairs":
                assert {r["arm"] for r in rows} <= {"names_only"}
    assert export_rows(report, flagged, "links")[1]


def test_unknown_table_raises(two_cohort_report):
    with pytest.raises(ValueError):
        export_rows(two_cohort_report, flags_for(two_cohort_report), "nope")


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------


@pytest.fixture(params=["csv", "tsv"])
def fmt_csv_tsv(request):
    return request.param


@pytest.mark.parametrize("name", ["=SUM(A1)", "+1", "-1", "@x", "\tx", "\rx"])
def test_delimited_exports_neutralize_formulas(name, fmt_csv_tsv):
    body, _ = render(["name"], [{"name": name}], fmt_csv_tsv)
    assert parse(body, fmt_csv_tsv)[1][0].startswith("'")


def test_neutralize_leaves_plain_text_and_numbers():
    assert neutralize("Glucose") == "Glucose" and neutralize("") == ""
    body, _ = render(["n", "b", "x"], [{"n": -1, "b": True, "x": None}], "csv")
    assert parse(body, "csv")[1] == ["-1", "true", ""]


def test_json_export_is_not_neutralized():
    body, media = render(["name", "n"], [{"name": "=SUM(A1)", "n": -1}], "json")
    assert media == "application/json"
    assert json.loads(body) == [{"name": "=SUM(A1)", "n": -1}]


def test_header_cells_are_neutralized(fmt_csv_tsv):
    body, _ = render(["=x_key"], [], fmt_csv_tsv)
    assert parse(body, fmt_csv_tsv) == [["'=x_key"]]


def test_csv_quotes_delimiter_quote_and_newline():
    tricky = ['a,b', 'say "hi"', "line1\nline2"]
    body, _ = render(["x", "y", "z"], [dict(zip("xyz", tricky))], "csv")
    assert parse(body, "csv") == [["x", "y", "z"], tricky]


def test_tsv_cells_hold_no_raw_tab_or_newline():
    body, media = render(["x", "y"], [{"x": "a\tb", "y": 'c\r\nd "e"'}], "tsv")
    assert media == "text/tab-separated-values"
    lines = body.decode("utf-8").split("\r\n")
    assert lines[-1] == "" and len(lines) == 3  # header, one row, trailing terminator
    assert lines[1].count("\t") == 1
    assert parse(body, "tsv")[1] == ["a b", 'c  d "e"']


def test_lists_and_maps_are_json_in_delimited_cells(many_cohort_report):
    header, rows = export_rows(many_cohort_report, flags_for(many_cohort_report), "groups")
    body, _ = render(header, rows, "csv")
    table = parse(body, "csv")
    col = table[0].index("rows_per_cohort")
    assert json.loads(table[1][col]) == rows[0]["rows_per_cohort"]


def test_export_filename_uses_labels_in_order_sanitized(two_cohort_report, many_cohort_report):
    assert export_filename(two_cohort_report, "links", "csv") == "harmonize_cohorts_a_b_links.csv"
    assert (export_filename(many_cohort_report, "eitl_pairs", "json")
            == "harmonize_many_a_b_c_eitl_pairs.json")
    report = {**two_cohort_report, "labels": {"a": "UK Bio/bank 1", "b": 'x"; rm'}}
    assert (export_filename(report, "review", "tsv")
            == "harmonize_cohorts_UK_Bio_bank_1_x___rm_review.tsv")


# ---------------------------------------------------------------------------
# Route
# ---------------------------------------------------------------------------

A_TSV = b"name\thmdb\nGlucose\tHMDB0000122\n"
SPEC_TWO = {"entity": "metabolites",
            "a": {"label": "a", "nameColumn": "name"}, "b": {"label": "b", "nameColumn": "name"}}
SPEC_MANY = {"entity": "metabolites",
             "cohorts": [{"label": x, "nameColumn": "name"} for x in ("a", "b", "c")]}


def _client(tmp_path, monkeypatch, recordings):
    from services.database import database

    monkeypatch.setenv("BIOMAPPER_HARMONIZE_REPLAY_DIR", str(recordings))
    monkeypatch.setattr(database, "_path", tmp_path / "harmonize_export.db")
    from main import app

    return TestClient(app)


@pytest.fixture(autouse=True)
def _fresh_items_cache():
    from routes.harmonize import clear_items_cache

    clear_items_cache()
    yield
    clear_items_cache()


@pytest.fixture
def client(tmp_path, monkeypatch, real_recording_dir):
    with _client(tmp_path, monkeypatch, real_recording_dir) as c:
        yield c


def wait_complete(client, job, timeout_s=30.0):
    deadline = time.monotonic() + timeout_s
    while client.get(f"/harmonize/runs/{job}", headers=U1).json()["state"] not in FINISHED_STATES:
        assert time.monotonic() < deadline, f"run {job} did not finish"
        time.sleep(0.02)


def submit_two(client):
    files = {"fileA": ("a.tsv", A_TSV, "text/tab-separated-values"),
             "fileB": ("b.tsv", A_TSV, "text/tab-separated-values")}
    r = client.post("/harmonize/cohorts", files=files, data={"spec": json.dumps(SPEC_TWO)},
                    headers=U1)
    assert r.status_code == 200, r.text
    return r.json()["jobId"]


def submit_many(client):
    files = [("files", (f"c{i}.tsv", A_TSV, "text/tab-separated-values")) for i in range(3)]
    r = client.post("/harmonize/many", files=files, data={"spec": json.dumps(SPEC_MANY)},
                    headers=U1)
    assert r.status_code == 200, r.text
    return r.json()["jobId"]


@pytest.fixture
def finished_job(client):
    job = submit_two(client)
    wait_complete(client, job)
    return job


def export(client, job, table, fmt, headers=U1):
    return client.get(f"/harmonize/runs/{job}/export", params={"table": table, "format": fmt},
                      headers=headers)


def test_export_route_downloads_a_file(client, finished_job, two_cohort_report):
    r = export(client, finished_job, "links", "csv")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("text/csv")
    assert (r.headers["content-disposition"]
            == 'attachment; filename="harmonize_cohorts_a_b_links.csv"')
    assert "x-harmonize-skipped-one-sided" not in r.headers
    header, rows = export_rows(two_cohort_report, flags_for(two_cohort_report), "links")
    assert parse(r.content, "csv") == parse(render(header, rows, "csv")[0], "csv")
    r = export(client, finished_job, "groups", "tsv")
    assert r.status_code == 200 and len(parse(r.content, "tsv")) == 1  # header only
    r = export(client, finished_job, "review", "json")
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/json")
    assert all(isinstance(row["members"], list) for row in r.json())


def test_export_route_eitl_pairs_uses_the_users_flags(client, finished_job, two_cohort_report):
    link = ref_of(two_cohort_report, "link", "names_only", ["a1", "b1"])
    r = client.put(f"/harmonize/runs/{finished_job}/flags", json={"refs": [link], "flagged": True},
                   headers=U1)
    assert r.status_code == 200, r.text
    r = export(client, finished_job, "eitl_pairs", "csv")
    assert r.status_code == 200, r.text
    assert (r.headers["content-disposition"]
            == 'attachment; filename="harmonize_cohorts_a_b_eitl_pairs.csv"')
    rows = parse(r.content, "csv")
    assert rows[0] == EITL_COLUMNS
    assert [(x[1], x[4]) for x in rows[1:]] == [("a1", "b1"), ("a2", "b2"), ("a3", "b2")]
    flagged = flags_for(two_cohort_report)
    assert int(r.headers["x-harmonize-skipped-one-sided"]) == skipped_one_sided(flagged)
    # A cross-origin browser may read both headers.
    r = export(client, finished_job, "eitl_pairs", "csv",
               headers={**U1, "Origin": "http://example.test"})
    exposed = {h.strip().lower() for h in r.headers["access-control-expose-headers"].split(",")}
    assert {"content-disposition", "x-harmonize-skipped-one-sided"} <= exposed
    # The other user's flags are not used (and they cannot see the run at all).
    assert export(client, finished_job, "eitl_pairs", "csv", headers=U2).status_code == 404


def test_export_route_many_cohort(client):
    job = submit_many(client)
    wait_complete(client, job)
    r = export(client, job, "groups", "csv")
    assert r.status_code == 200
    assert 'filename="harmonize_many_a_b_c_groups.csv"' in r.headers["content-disposition"]
    assert "c_chosen_kg_id" in parse(r.content, "csv")[0]


def test_export_route_404_for_other_user(client, finished_job):
    assert export(client, finished_job, "links", "csv", headers=U2).status_code == 404
    assert export(client, "no-such-run", "links", "csv").status_code == 404


def test_export_route_needs_user_header(client, finished_job):
    assert export(client, finished_job, "links", "csv", headers={}).status_code == 400


@pytest.mark.parametrize("table,fmt", [("nope", "csv"), ("links", "xlsx"), (None, "csv"),
                                       ("links", None), ("eitl_pairs", "tsv")])
def test_export_route_rejects_unknown_table_or_format(client, finished_job, table, fmt):
    params = {k: v for k, v in (("table", table), ("format", fmt)) if v is not None}
    r = client.get(f"/harmonize/runs/{finished_job}/export", params=params, headers=U1)
    assert r.status_code == 400 and r.json()["detail"]


def test_export_route_409_until_finished(tmp_path, monkeypatch, real_recording_dir):
    monkeypatch.setenv("BIOMAPPER_HARMONIZE_REPLAY_PACE", "5")
    with _client(tmp_path, monkeypatch, real_recording_dir) as c:
        job = submit_two(c)
        assert export(c, job, "links", "csv").status_code == 409


def test_export_has_no_server_path(tmp_path, monkeypatch, two_cohort_report,
                                   many_cohort_report):
    from services import harmonize_storage
    from tests.harmonize_fixtures import write_recording

    home = str(harmonize_storage.HARMONIZE_HOME)
    leaky = json.loads(json.dumps(two_cohort_report).replace(
        "simulated mapping failure", f"could not read {home}/runs/x/inputs/b.tsv"))
    recordings = write_recording(tmp_path / "leaky", two_cohort_report=leaky,
                                 many_cohort_report=many_cohort_report)
    with _client(tmp_path, monkeypatch, recordings) as c:
        job = submit_two(c)
        wait_complete(c, job)
        for fmt in FORMATS:
            r = export(c, job, "unresolved", fmt)
            assert r.status_code == 200
            assert "runs/x/inputs/b.tsv" in r.text and home not in r.text
