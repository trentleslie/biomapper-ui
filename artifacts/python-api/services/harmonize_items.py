"""Reviewable items of a finished harmonization run, and the organizer's flags on them.

An item is one thing biomapper produced that an organizer may want an expert to look at: a
link between two rows, a node group across cohorts, a review entry, or a row that resolved to
nothing. :func:`items_from_report` reads them from ``report.json`` (``schema_version: 1``) and
nothing else. Where each kind lives:

=============  =======================================  ==========================================
kind           two cohorts (``harmonize_cohorts``,      many cohorts (``harmonize_many``)
               ``harmonize_results``)
=============  =======================================  ==========================================
link           ``arms.<arm>.links``                     none
group          none                                     ``arms.<arm>.groups``
review         top-level ``review_queue`` (arm          ``arms.<arm>.cross_node``,
               ``names_only``: each entry compares a    ``arms.<arm>.id_check_review``,
               one-sided code with the row's            ``arms.<arm>.withheld`` (reason
               names-only entry; absent for             ``name_match_withheld``)
               ``harmonize_results``);
               ``arms.<arm>.possible_missed`` (reason
               ``possible_missed``);
               ``arms.<arm>.name_match_withheld``
               (reason ``name_match_withheld``)
unresolved     ``arms.<arm>.unresolved_rows`` and       ``arms.<arm>.not_grouped`` (every bucket
               ``arms.<arm>.errored_rows`` (bucket      but ``grouped``: ``no_node``,
               ``errored``), or ``unresolved`` and      ``unresolved``, ``errored``)
               ``errors`` (keys only) when the arm
               has no row lists (``harmonize_results``)
=============  =======================================  ==========================================

A skipped identifier arm (``None`` in a two-cohort report, absent in a many-cohort one) yields
no items. ``detail`` holds what the report gives for the item, snake_case, plus ``origin``: the
report list it came from (and ``reason`` for possible misses and withheld name pairs; ``bucket``,
``status`` and, for errored two-cohort rows, the mapping ``error``).

``suggested`` is biomapper's own flag: every review item, a link with ``ambiguous: true`` and a
group with ``multiplicity: true``. An organizer override, when there is one, wins
(:func:`with_flags`).

Refs are ``f"{kind}:{arm}:{sha1[:16]}"``, the digest taken over the item's sorted
``(cohort, key)`` member pairs plus, for review items, what tells two entries on the same rows
apart (``review_queue``: vocabulary and code; ``cross_node``: the node pair;
``id_check_review``: its origin and comparison rule; ``possible_missed``,
``name_match_withheld``, ``withheld``: their origin). They depend on the report's content, never
on list order or the process. Items that would still share a ref within one kind and arm are
numbered by their detail (sorted as canonical JSON): the first keeps the ref, the others get
``~2``, ``~3``... Only byte-identical duplicates are then told apart by nothing but count.
"""
from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable, Iterator, Mapping
from dataclasses import dataclass
from typing import Any

ARMS = ("names_only", "identifier")
KINDS = ("link", "group", "review", "unresolved")
SOURCE_BIOMAPPER = "biomapper"
SOURCE_ORGANIZER = "organizer"

_TWO_COHORT_KINDS = frozenset({"harmonize_cohorts", "harmonize_results"})
_MANY_COHORT_KIND = "harmonize_many"
# Link fields that become members rather than detail.
_LINK_MEMBER_FIELDS = frozenset({"a_key", "b_key", "a_name", "b_name",
                                 "a_chosen_kg_id", "b_chosen_kg_id"})


@dataclass(frozen=True)
class Item:
    ref: str            # stable across reloads: f"{kind}:{arm}:{sha1(sorted member keys)[:16]}"
    kind: str           # "link" | "group" | "review" | "unresolved"
    arm: str            # "names_only" | "identifier"
    suggested: bool     # biomapper's own flag
    members: tuple[dict, ...]   # each {"cohort", "key", "name", "chosenKgId"}
    detail: dict        # basis, ambiguous, one_to_one, multiplicity, status, reason: whatever the report gives


@dataclass(frozen=True)
class FlaggedItem:
    """An item with its effective flag: the organizer's override if any, else ``suggested``."""

    item: Item
    flagged: bool
    source: str  # "biomapper" (no override) or "organizer"


@dataclass(frozen=True)
class _Draft:
    kind: str
    arm: str
    suggested: bool
    members: tuple[dict, ...]
    detail: dict
    discriminator: tuple[str, ...] = ()


def _member(cohort: str, key: str, name: str | None, chosen_kg_id: str | None) -> dict:
    return {"cohort": cohort, "key": key, "name": name, "chosenKgId": chosen_kg_id}


def _digest(draft: _Draft) -> str:
    pairs = sorted([m["cohort"], m["key"]] for m in draft.members)
    payload = json.dumps([pairs, list(draft.discriminator)], ensure_ascii=False,
                         separators=(",", ":"))
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()[:16]


# ---------------------------------------------------------------------------
# Two cohorts
# ---------------------------------------------------------------------------


def _rows(data: Mapping[str, Any], rows_key: str, keys_key: str) -> Iterator[tuple[str, str, Any]]:
    """``(label, key, name)`` per row of a per-cohort row list, or of a key list (no names)."""
    if rows_key in data:
        for label, rows in (data.get(rows_key) or {}).items():
            for row in rows:
                yield label, row["key"], row.get("name")
    else:  # harmonize() output (harmonize_results): keys only
        for label, keys in (data.get(keys_key) or {}).items():
            for key in keys:
                yield label, key, None


def _two_cohort_arm(arm: str, data: Mapping[str, Any],
                    mappings: Mapping[str, Any]) -> Iterator[_Draft]:
    labels = data.get("labels") or {}
    a_label, b_label = labels.get("a", "a"), labels.get("b", "b")
    # The mapping error of each row, from the report's per-arm mapping rows when it has them.
    errors = {(label, row.get("key")): row.get("error")
              for label, rows in (mappings.get(arm) or {}).items() for row in rows}
    for link in data.get("links") or []:
        yield _Draft(
            kind="link", arm=arm, suggested=bool(link.get("ambiguous")),
            members=(
                _member(a_label, link["a_key"], link.get("a_name"), link.get("a_chosen_kg_id")),
                _member(b_label, link["b_key"], link.get("b_name"), link.get("b_chosen_kg_id")),
            ),
            detail={**{k: v for k, v in link.items() if k not in _LINK_MEMBER_FIELDS},
                    "origin": "links"},
        )
    for pair in data.get("name_match_withheld") or []:
        yield _Draft(
            kind="review", arm=arm, suggested=True,
            members=(_member(a_label, pair["a_key"], pair.get("a_name"), None),
                     _member(b_label, pair["b_key"], pair.get("b_name"), None)),
            detail={"reason": "name_match_withheld", "origin": "name_match_withheld"},
            discriminator=("name_match_withheld",),
        )
    for miss in data.get("possible_missed") or []:
        yield _Draft(
            kind="review", arm=arm, suggested=True,
            members=(_member(miss["cohort"], miss["key"], miss.get("name"),
                             miss.get("chosen_kg_id")),),
            detail={**{k: v for k, v in miss.items()
                       if k not in {"cohort", "key", "name", "chosen_kg_id"}},
                    "reason": "possible_missed", "origin": "possible_missed"},
            discriminator=("possible_missed",),
        )
    unresolved_origin = "unresolved_rows" if "unresolved_rows" in data else "unresolved"
    for label, key, name in _rows(data, "unresolved_rows", "unresolved"):
        yield _Draft(kind="unresolved", arm=arm, suggested=False,
                     members=(_member(label, key, name, None),),
                     detail={"bucket": "unresolved", "status": "unresolved",
                             "origin": unresolved_origin})
    errored_origin = "errored_rows" if "errored_rows" in data else "errors"
    for label, key, name in _rows(data, "errored_rows", "errors"):
        yield _Draft(kind="unresolved", arm=arm, suggested=False,
                     members=(_member(label, key, name, None),),
                     detail={"bucket": "errored", "status": "errored",
                             "error": errors.get((label, key)), "origin": errored_origin})


def _review_queue(entries: Iterable[Mapping[str, Any]]) -> Iterator[_Draft]:
    # Each entry compares a one-sided code with the row's names-only entry.
    for entry in entries:
        detail = {k: v for k, v in entry.items() if k not in {"cohort", "key", "name"}}
        yield _Draft(
            kind="review", arm="names_only", suggested=True,
            members=(_member(entry["cohort"], entry["key"], entry.get("name"),
                             entry.get("name_entry")),),
            detail={**detail, "origin": "review_queue"},
            discriminator=("review_queue", str(entry.get("vocabulary")), str(entry.get("code"))),
        )


def _two_cohort(report: Mapping[str, Any]) -> Iterator[_Draft]:
    arms = report.get("arms") or {}
    for arm in ARMS:
        data = arms.get(arm)
        if data is None:
            continue
        yield from _two_cohort_arm(arm, data, report.get("mappings") or {})
        if arm == "names_only":
            yield from _review_queue(report.get("review_queue") or [])


# ---------------------------------------------------------------------------
# Many cohorts
# ---------------------------------------------------------------------------


def _many_cohort_arm(arm: str, data: Mapping[str, Any]) -> Iterator[_Draft]:
    chosen = {(r["cohort"], r["key"]): r.get("chosen_kg_id") for r in data.get("rows") or []}
    names = {(r["cohort"], r["key"]): r.get("name") for r in data.get("rows") or []}
    groups = {g["node"]: g for g in data.get("groups") or []}

    def group_members(group: Mapping[str, Any]) -> tuple[dict, ...]:
        return tuple(_member(m["cohort"], m["key"], m.get("name"),
                             chosen.get((m["cohort"], m["key"]), group["node"]))
                     for m in group.get("members") or [])

    for group in groups.values():
        yield _Draft(
            kind="group", arm=arm, suggested=bool(group.get("multiplicity")),
            members=group_members(group),
            detail={**{k: v for k, v in group.items() if k != "members"}, "origin": "groups"},
        )
    for entry in data.get("cross_node") or []:
        # The entry names two nodes; its members are both nodes' group members. A side with no
        # node ("<no node>") has no group and adds none.
        members = tuple(m for node in (entry["node_a"], entry["node_b"]) if node in groups
                        for m in group_members(groups[node]))
        yield _Draft(kind="review", arm=arm, suggested=True, members=members,
                     detail={**entry, "origin": "cross_node"},
                     discriminator=("cross_node", entry["node_a"], entry["node_b"]))
    for entry in data.get("id_check_review") or []:
        yield _Draft(
            kind="review", arm=arm, suggested=True,
            members=(_member(entry["cohort"], entry["key"], entry.get("name"),
                             chosen.get((entry["cohort"], entry["key"]), entry.get("node"))),),
            detail={**{k: v for k, v in entry.items() if k not in {"cohort", "key", "name"}},
                    "origin": "id_check_review"},
            discriminator=("id_check_review", str((entry.get("check") or {}).get("rule"))),
        )
    for pair in data.get("withheld") or []:
        yield _Draft(
            kind="review", arm=arm, suggested=True,
            members=tuple(_member(cohort, key, names.get((cohort, key)), chosen.get((cohort, key)))
                          for cohort, key in ((pair["a_cohort"], pair["a_key"]),
                                              (pair["b_cohort"], pair["b_key"]))),
            detail={"reason": "name_match_withheld", "origin": "withheld"},
            discriminator=("withheld",),
        )
    for label, rows in (data.get("not_grouped") or {}).items():
        for row in rows:
            yield _Draft(
                kind="unresolved", arm=arm, suggested=False,
                members=(_member(label, row["key"], row.get("name"), row.get("chosen_kg_id")),),
                detail={**{k: v for k, v in row.items()
                           if k not in {"cohort", "key", "name", "chosen_kg_id"}},
                        "origin": "not_grouped"},
            )


def _many_cohort(report: Mapping[str, Any]) -> Iterator[_Draft]:
    arms = report.get("arms") or {}
    for arm in ARMS:
        data = arms.get(arm)
        if data is not None:
            yield from _many_cohort_arm(arm, data)


# ---------------------------------------------------------------------------
# Public
# ---------------------------------------------------------------------------


def items_from_report(report: dict) -> list[Item]:
    """Every reviewable item in ``report`` (a ``report.json`` dict), in report order.

    Raises:
        ValueError: The report's ``kind`` is not one this reads.
    """
    kind = report.get("kind")
    if kind in _TWO_COHORT_KINDS:
        drafts = _two_cohort(report)
    elif kind == _MANY_COHORT_KIND:
        drafts = _many_cohort(report)
    else:
        raise ValueError(f"Reports of kind {kind!r} have no reviewable items.")
    drafts = list(drafts)
    bases = [f"{d.kind}:{d.arm}:{_digest(d)}" for d in drafts]
    # Drafts sharing a ref are numbered in the order of their detail, not of the report, so
    # the numbering does not depend on list order.
    by_ref: dict[str, list[int]] = {}
    for index, ref in enumerate(bases):
        by_ref.setdefault(ref, []).append(index)
    refs = list(bases)
    for ref, indices in by_ref.items():
        if len(indices) > 1:
            ordered = sorted(indices, key=lambda i: json.dumps(drafts[i].detail, sort_keys=True,
                                                                ensure_ascii=False))
            for n, index in enumerate(ordered[1:], start=2):
                refs[index] = f"{ref}~{n}"
    items = [Item(ref=ref, kind=d.kind, arm=d.arm, suggested=d.suggested, members=d.members,
                  detail=d.detail) for ref, d in zip(refs, drafts)]
    return items


def with_flags(items: Iterable[Item], overrides: Mapping[str, bool]) -> list[FlaggedItem]:
    """Each item with its effective flag. ``overrides`` maps ref to the organizer's flag."""
    out = []
    for item in items:
        if item.ref in overrides:
            out.append(FlaggedItem(item, bool(overrides[item.ref]), SOURCE_ORGANIZER))
        else:
            out.append(FlaggedItem(item, item.suggested, SOURCE_BIOMAPPER))
    return out
