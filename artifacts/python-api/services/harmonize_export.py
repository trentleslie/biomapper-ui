"""Downloads of a finished harmonization run: item tables as CSV, TSV or JSON, and the EITL
pairs file.

Everything is built from the run's reviewable items (:mod:`services.harmonize_items`, which
reads ``report.json`` and nothing else) with their effective flags, plus the report's
``kind``, ``labels`` and ``entity``.

Item tables (``links``, ``groups``, ``review``, ``unresolved``) hold every item of that kind
in both arms, in report order, one row per item:

- ``ref``, ``arm``, ``flagged``, ``flag_source``, ``suggested``;
- one column group per cohort label, in the report's label order: ``<label>_key``,
  ``<label>_name``, ``<label>_chosen_kg_id``. A group or review item can hold more than one row
  of one cohort (multiplicity); their values are joined with ``" | "`` in key order, and
  ``member_count`` gives the number of rows. JSON exports instead carry ``members``, a list of
  ``{cohort, key, name, chosen_kg_id}`` in label order then key;
- ``member_count``, ``basis`` and every detail field the table's items have, in first-seen
  order (a detail field whose name would repeat a column above is written ``detail_<name>``).
  The ``unresolved`` table always has ``status``: the report's own, else the row's bucket
  (``unresolved``, ``errored``, ``no_node``).

A table that does not apply to the run's kind (``groups`` on a two-cohort run) has its header
and no rows.

The EITL pairs file holds only flagged links and flagged groups, in the columns the
expert-in-the-loop pairs upload reads (:data:`EITL_COLUMNS`). A link gives one pair (its
``a`` row as source, ``b`` row as target); a flagged group of n rows gives n - 1 pairs, each
other row against the first, rows ordered by the report's label order then key. Text is the
row's name (its key when it has none, because EITL requires a text), id is its key, dataset
is its cohort label, ``pair_type`` is the report's entity type. ``resolution_layer`` is
``unspecified``: EITL accepts only its own provenance values (``authoritative_xref``,
``ai_assisted``, ``manual``, ``unspecified``) and rejects the upload on any other, so the link
basis cannot go there. A pair already in the file (the same link flagged in both arms) is
written once. Flagged items that give no pair (review and unresolved items, and one-row
groups) are counted by :func:`skipped_one_sided`.

CSV and TSV cells that could start a spreadsheet formula are neutralized (:func:`neutralize`);
JSON values are written as they are. CSV and TSV are written with the csv module, so a cell
holding the delimiter, a quote or a line break is quoted; TSV cells never hold a raw tab or
line break (each becomes a space). Lists and maps in a CSV or TSV cell are written as JSON.
"""
from __future__ import annotations

import csv
import io
import json
import re
from collections.abc import Iterable, Mapping
from typing import Any

from services.harmonize_items import FlaggedItem

TABLES = ("links", "groups", "review", "unresolved", "eitl_pairs")
FORMATS = ("csv", "tsv", "json")
# EITL's file upload reads CSV (comma-delimited) or JSON; it has no TSV branch.
EITL_FORMATS = ("csv", "json")
EITL_COLUMNS = ["source_text", "source_id", "source_dataset", "target_text", "target_id",
                "target_dataset", "pair_type", "resolution_layer"]
EITL_RESOLUTION_LAYER = "unspecified"
MEDIA_TYPES = {"csv": "text/csv", "tsv": "text/tab-separated-values", "json": "application/json"}
MULTI_SEPARATOR = " | "

_TABLE_KIND = {"links": "link", "groups": "group", "review": "review",
               "unresolved": "unresolved"}
_PAIR_KINDS = frozenset({"link", "group"})
_FIXED = ["ref", "arm", "flagged", "flag_source", "suggested"]
_MEMBER_FIELDS = (("key", "key"), ("name", "name"), ("chosen_kg_id", "chosenKgId"))
_FORMULA_START = ("=", "+", "-", "@", "\t", "\r")
_UNSAFE_FILENAME = re.compile(r"[^A-Za-z0-9._-]")


def report_labels(report: Mapping[str, Any]) -> list[str]:
    """The cohort labels in report order: ``{a, b}`` for two cohorts, a list for many."""
    labels = report.get("labels")
    if isinstance(labels, Mapping):
        return [labels.get("a", "a"), labels.get("b", "b")]
    return list(labels or [])


def export_filename(report: Mapping[str, Any], table: str, fmt: str) -> str:
    """``<kind>_<labels joined by _>_<table>.<fmt>``, each label reduced to ``[A-Za-z0-9._-]``."""
    labels = [_UNSAFE_FILENAME.sub("_", str(label)) for label in report_labels(report)]
    kind = _UNSAFE_FILENAME.sub("_", str(report.get("kind") or "harmonize"))
    return f"{'_'.join([kind, *labels, table])}.{fmt}"


def neutralize(cell: str) -> str:
    """Prefix ``'`` when the cell would start a spreadsheet formula."""
    return "'" + cell if cell.startswith(_FORMULA_START) else cell


def _member_order(labels: list[str]):
    rank = {label: i for i, label in enumerate(labels)}
    return lambda m: (rank.get(m["cohort"], len(rank)), str(m["cohort"]), str(m["key"]))


def _cohorts(labels: list[str], flagged: Iterable[FlaggedItem]) -> list[str]:
    """The report's labels, then any member cohort not among them (first seen)."""
    out = list(labels)
    for f in flagged:
        for m in f.item.members:
            if m["cohort"] not in out:
                out.append(m["cohort"])
    return out


# ---------------------------------------------------------------------------
# Item tables
# ---------------------------------------------------------------------------


def _item_rows(report: Mapping[str, Any], flagged: list[FlaggedItem], table: str,
               nested: bool) -> tuple[list[str], list[dict]]:
    kind = _TABLE_KIND[table]
    chosen = [f for f in flagged if f.item.kind == kind]
    cohorts = _cohorts(report_labels(report), chosen)
    order = _member_order(cohorts)
    member_cols = ([] if nested else
                   [f"{c}_{field}" for c in cohorts for field, _ in _MEMBER_FIELDS])
    taken = set(_FIXED) | set(member_cols) | {"members", "member_count", "basis"}

    detail_keys: list[str] = []
    for f in chosen:
        for key in f.item.detail:
            if key != "basis" and key not in detail_keys:
                detail_keys.append(key)
    if table == "unresolved" and "status" not in detail_keys:
        detail_keys.append("status")
    detail_cols = {key: (f"detail_{key}" if key in taken else key) for key in detail_keys}

    header = [*_FIXED, *(["members"] if nested else member_cols), "member_count", "basis",
              *detail_cols.values()]
    rows = []
    for f in chosen:
        item = f.item
        members = sorted(item.members, key=order)
        row: dict[str, Any] = {"ref": item.ref, "arm": item.arm, "flagged": f.flagged,
                               "flag_source": f.source, "suggested": item.suggested}
        if nested:
            row["members"] = [{"cohort": m["cohort"], **{out: m.get(src)
                                                         for out, src in _MEMBER_FIELDS}}
                              for m in members]
        else:
            for cohort in cohorts:
                mine = [m for m in members if m["cohort"] == cohort]
                for out, src in _MEMBER_FIELDS:
                    row[f"{cohort}_{out}"] = MULTI_SEPARATOR.join(
                        "" if m.get(src) is None else str(m.get(src)) for m in mine)
        row["member_count"] = len(members)
        row["basis"] = item.detail.get("basis")
        for key, col in detail_cols.items():
            row[col] = item.detail.get(key)
        if table == "unresolved" and row[detail_cols["status"]] is None:
            row[detail_cols["status"]] = item.detail.get("bucket")
        rows.append(row)
    return header, rows


# ---------------------------------------------------------------------------
# EITL pairs
# ---------------------------------------------------------------------------


def _pair(source: Mapping[str, Any], target: Mapping[str, Any], entity: str) -> dict[str, Any]:
    def side(m: Mapping[str, Any]) -> tuple[str, str, str]:
        key = str(m["key"])
        return (m.get("name") or key), key, str(m["cohort"])

    s_text, s_id, s_dataset = side(source)
    t_text, t_id, t_dataset = side(target)
    return {"source_text": s_text, "source_id": s_id, "source_dataset": s_dataset,
            "target_text": t_text, "target_id": t_id, "target_dataset": t_dataset,
            "pair_type": entity, "resolution_layer": EITL_RESOLUTION_LAYER}


def _eitl_rows(report: Mapping[str, Any], flagged: list[FlaggedItem]) -> list[dict]:
    entity = str(report.get("entity") or "")
    order = _member_order(report_labels(report))
    rows: list[dict] = []
    seen: set[tuple[str, str, str, str]] = set()
    for f in flagged:
        if not f.flagged or f.item.kind not in _PAIR_KINDS:
            continue
        if f.item.kind == "link":
            source, target = f.item.members
            pairs = [(source, target)]
        else:
            members = sorted(f.item.members, key=order)
            pairs = [(members[0], m) for m in members[1:]]
        for source, target in pairs:
            row = _pair(source, target, entity)
            ident = (row["source_dataset"], row["source_id"], row["target_dataset"],
                     row["target_id"])
            if ident not in seen:
                seen.add(ident)
                rows.append(row)
    return rows


def skipped_one_sided(flagged: Iterable[FlaggedItem]) -> int:
    """Flagged items the EITL pairs file cannot hold: review and unresolved items, and groups
    of one row."""
    return sum(1 for f in flagged if f.flagged and (
        f.item.kind not in _PAIR_KINDS or (f.item.kind == "group" and len(f.item.members) < 2)))


# ---------------------------------------------------------------------------
# Public
# ---------------------------------------------------------------------------


def export_rows(report: Mapping[str, Any], flagged: list[FlaggedItem], table: str, *,
                nested: bool = False) -> tuple[list[str], list[dict]]:
    """The header and rows of ``table``.

    Args:
        report: The run's ``report.json`` dict; only ``kind``, ``labels`` and ``entity`` are
            read here.
        flagged: Every item of the run with its effective flag
            (:func:`services.harmonize_items.with_flags` over
            :func:`~services.harmonize_items.items_from_report` of the same report).
        table: One of :data:`TABLES`.
        nested: Members as a ``members`` list instead of per-label column groups (for JSON).
            The EITL pairs table has no members and ignores it.

    Raises:
        ValueError: ``table`` is not one of :data:`TABLES`.
    """
    if table not in TABLES:
        raise ValueError(f"Unknown table {table!r}.")
    if table == "eitl_pairs":
        return list(EITL_COLUMNS), _eitl_rows(report, flagged)
    return _item_rows(report, flagged, table, nested)


def _delimited_cell(value: Any, fmt: str) -> str:
    if value is None:
        text = ""
    elif isinstance(value, bool):
        text = "true" if value else "false"
    elif isinstance(value, (int, float)):
        text = str(value)
    elif isinstance(value, (list, dict)):
        text = neutralize(json.dumps(value, ensure_ascii=False))
    else:
        text = neutralize(str(value))
    if fmt == "tsv":
        text = text.replace("\t", " ").replace("\r", " ").replace("\n", " ")
    return text


def render(header: list[str], rows: list[dict], fmt: str) -> tuple[bytes, str]:
    """``(body, media type)`` of the table in ``fmt``.

    JSON is a list of row objects with keys in header order (EITL's JSON upload reads a bare
    list of pairs). CSV and TSV have a header row and CRLF line ends, no byte order mark.

    Raises:
        ValueError: ``fmt`` is not one of :data:`FORMATS`.
    """
    if fmt not in FORMATS:
        raise ValueError(f"Unknown format {fmt!r}.")
    if fmt == "json":
        body = json.dumps([{h: row.get(h) for h in header} for row in rows], ensure_ascii=False)
        return body.encode("utf-8"), MEDIA_TYPES[fmt]
    out = io.StringIO(newline="")
    writer = csv.writer(out, delimiter="," if fmt == "csv" else "\t", lineterminator="\r\n")
    writer.writerow([_delimited_cell(h, fmt) for h in header])
    for row in rows:
        writer.writerow([_delimited_cell(row.get(h), fmt) for h in header])
    return out.getvalue().encode("utf-8"), MEDIA_TYPES[fmt]
