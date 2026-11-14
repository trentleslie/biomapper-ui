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
review         top-level ``review_queue`` (arm          ``arms.<arm>.cross_node`` and
               ``names_only``: each entry compares a    ``arms.<arm>.id_check_review``
               one-sided code with the row's
               names-only entry); absent for
               ``harmonize_results``
unresolved     ``arms.<arm>.unresolved_rows``, or       ``arms.<arm>.not_grouped`` (every bucket
               ``arms.<arm>.unresolved`` (keys only)    but ``grouped``: ``no_node``,
               when the arm has no ``unresolved_rows``  ``unresolved``, ``errored``)
=============  =======================================  ==========================================

A skipped identifier arm (``None`` in a two-cohort report, absent in a many-cohort one) yields
no items. ``detail`` holds what the report gives for the item, snake_case, plus ``origin``: the
report list it came from.

``suggested`` is biomapper's own flag: every review item, a link with ``ambiguous: true`` and a
group with ``multiplicity: true``. An organizer override, when there is one, wins
(:func:`with_flags`).

Refs are ``f"{kind}:{arm}:{sha1[:16]}"``, the digest taken over the item's sorted
``(cohort, key)`` member pairs plus, for review items, what tells two entries on the same rows
apart (``review_queue``: vocabulary and code; ``cross_node``: the node pair;
``id_check_review``: its origin). They depend on the report's content, never on list order or
the process. Two items that would still share a ref within one kind and arm carry identical
members and discriminator; the second and later get ``~2``, ``~3``... in report order.
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


def _two_cohort_arm(arm: str, data: Mapping[str, Any]) -> Iterator[_Draft]:
    labels = data.get("labels") or {}
    a_label, b_label = labels.get("a", "a"), labels.get("b", "b")
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
    if "unresolved_rows" in data:
        for label, rows in (data.get("unresolved_rows") or {}).items():
            for row in rows:
                yield _Draft(kind="unresolved", arm=arm, suggested=False,
                             members=(_member(label, row["key"], row.get("name"), None),),
                             detail={"bucket": "unresolved", "origin": "unresolved_rows"})
    else:  # harmonize() output (harmonize_results): keys only
        for label, keys in (data.get("unresolved") or {}).items():
            for key in keys:
                yield _Draft(kind="unresolved", arm=arm, suggested=False,
                             members=(_member(label, key, None, None),),
                             detail={"bucket": "unresolved", "origin": "unresolved"})


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
        yield from _two_cohort_arm(arm, data)
        if arm == "names_only":
            yield from _review_queue(report.get("review_queue") or [])


# ---------------------------------------------------------------------------
# Many cohorts
# ---------------------------------------------------------------------------


def _many_cohort_arm(arm: str, data: Mapping[str, Any]) -> Iterator[_Draft]:
    chosen = {(r["cohort"], r["key"]): r.get("chosen_kg_id") for r in data.get("rows") or []}
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
            discriminator=("id_check_review",),
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
    items: list[Item] = []
    seen: dict[str, int] = {}
    for d in drafts:
        ref = f"{d.kind}:{d.arm}:{_digest(d)}"
        seen[ref] = seen.get(ref, 0) + 1
        if seen[ref] > 1:
            ref = f"{ref}~{seen[ref]}"
        items.append(Item(ref=ref, kind=d.kind, arm=d.arm, suggested=d.suggested,
                          members=d.members, detail=d.detail))
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
