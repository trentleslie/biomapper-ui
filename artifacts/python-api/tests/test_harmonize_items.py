"""items_from_report and with_flags on real report.json dicts the package generated offline."""
import copy
import re
from collections import Counter

import pytest

from services.harmonize_items import (
    SOURCE_BIOMAPPER,
    SOURCE_ORGANIZER,
    items_from_report,
    with_flags,
)

REF = re.compile(r"^(link|group|review|unresolved):(names_only|identifier):[0-9a-f]{16}(~\d+)?$")


def _counts(items):
    return Counter((i.kind, i.arm) for i in items)


def _by_ref(items):
    return {i.ref: i for i in items}


def test_items_cover_every_kind_and_seed_suggestions(two_cohort_report):
    items = items_from_report(two_cohort_report)
    assert {i.kind for i in items} == {"link", "review", "unresolved"}
    ambiguous = [i for i in items if i.detail.get("ambiguous")]
    assert ambiguous and all(i.suggested for i in ambiguous)
    assert len({i.ref for i in items}) == len(items)
    assert all(REF.match(i.ref) for i in items)
    assert items_from_report(two_cohort_report) == items                  # refs are stable


def test_two_cohort_items_per_arm(two_cohort_report):
    items = items_from_report(two_cohort_report)
    assert _counts(items) == {
        ("link", "names_only"): 3, ("link", "identifier"): 3,
        ("unresolved", "names_only"): 3, ("unresolved", "identifier"): 3,
        ("review", "names_only"): 3, ("review", "identifier"): 2,
    }
    plain = [i for i in items if i.kind == "link" and i.arm == "names_only"
             and not i.detail["ambiguous"]]
    assert len(plain) == 1 and plain[0].suggested is False
    assert plain[0].detail["one_to_one"] is True and plain[0].detail["basis"] == "node"
    assert plain[0].detail["origin"] == "links"
    assert plain[0].members == (
        {"cohort": "a", "key": "a1", "name": "Glucose", "chosenKgId": "CHEBI:4167"},
        {"cohort": "b", "key": "b1", "name": "D-Glucose", "chosenKgId": "CHEBI:4167"},
    )
    review = next(i for i in items if i.detail["origin"] == "review_queue")
    assert review.suggested is True
    assert review.members == ({"cohort": "a", "key": "a1", "name": "Glucose",
                               "chosenKgId": "CHEBI:4167"},)
    assert review.detail["status"] == "disagree" and review.detail["vocabulary"] == "KEGG"
    unresolved = {(i.members[0]["cohort"], i.members[0]["key"]): i
                  for i in items if i.kind == "unresolved" and i.arm == "names_only"}
    assert set(unresolved) == {("a", "a4"), ("b", "b3"), ("b", "b5")}
    assert unresolved[("a", "a4")].detail["bucket"] == "unresolved"
    errored = unresolved[("b", "b5")]
    assert errored.detail == {"bucket": "errored", "status": "errored",
                              "error": "simulated mapping failure", "origin": "errored_rows"}
    assert errored.members[0]["name"] == "Broken row"
    assert unresolved[("a", "a4")].members[0]["name"] == "Mystery peak 12"
    assert not any(i.suggested for i in unresolved.values())


def test_two_cohort_withheld_pairs_and_possible_misses(two_cohort_report):
    items = items_from_report(two_cohort_report)
    for arm in ("names_only", "identifier"):
        reviews = {i.detail["origin"]: i for i in items if i.kind == "review" and i.arm == arm}
        withheld, missed = reviews["name_match_withheld"], reviews["possible_missed"]
        assert withheld.suggested and missed.suggested
        assert withheld.detail["reason"] == "name_match_withheld"
        assert [(m["cohort"], m["key"], m["name"]) for m in withheld.members] == [
            ("a", "a5", "Co"), ("b", "b4", "CO")]
        assert missed.detail["reason"] == "possible_missed"
        assert missed.detail["reasons"] == ["divergent_refmet"]
        assert missed.members == ({"cohort": "a", "key": "a6", "name": "Hexose",
                                   "chosenKgId": "CHEBI:18133"},)
    # A withheld pair is never also a link, and its ref differs from every other review ref.
    assert len({i.ref for i in items}) == len(items)


def test_duplicates_are_numbered_by_detail_not_report_order(many_cohort_report):
    report = copy.deepcopy(many_cohort_report)
    arm = report["arms"]["names_only"]
    entry = arm["id_check_review"][0]
    arm["id_check_review"] = [
        {**entry, "check": {**entry["check"], "reason": "first"}},
        {**entry, "check": {**entry["check"], "reason": "second"}},
    ]

    def refs_by_reason(rep):
        return {i.detail["check"]["reason"]: i.ref for i in items_from_report(rep)
                if i.arm == "names_only" and i.detail["origin"] == "id_check_review"}

    before = refs_by_reason(report)
    assert len(set(before.values())) == 2
    arm["id_check_review"].reverse()
    assert refs_by_reason(report) == before


def test_null_identifier_arm_yields_no_items_and_no_error(two_cohort_report_names_only):
    assert two_cohort_report_names_only["arms"]["identifier"] is None
    items = items_from_report(two_cohort_report_names_only)
    assert {i.arm for i in items} == {"names_only"}
    assert _counts(items) == {("link", "names_only"): 3, ("unresolved", "names_only"): 3,
                              ("review", "names_only"): 3}


def test_refs_do_not_depend_on_list_order(two_cohort_report, many_cohort_report):
    for report in (two_cohort_report, many_cohort_report):
        before = _by_ref(items_from_report(report))
        shuffled = copy.deepcopy(report)
        for arm in shuffled["arms"].values():
            if arm is None:
                continue
            for key in ("links", "groups", "cross_node", "id_check_review"):
                if key in arm:
                    arm[key].reverse()
            for rows in (arm.get("unresolved_rows") or arm.get("not_grouped") or {}).values():
                rows.reverse()
        if "review_queue" in shuffled:
            shuffled["review_queue"].reverse()
        assert _by_ref(items_from_report(shuffled)) == before


def test_duplicate_entries_get_distinct_deterministic_refs(two_cohort_report):
    report = copy.deepcopy(two_cohort_report)
    report["review_queue"].append(copy.deepcopy(report["review_queue"][0]))
    refs = [i.ref for i in items_from_report(report) if i.detail["origin"] == "review_queue"]
    assert len(set(refs)) == 2 and refs[1] == refs[0] + "~2"
    assert refs == [i.ref for i in items_from_report(report)
                    if i.detail["origin"] == "review_queue"]


def test_same_rows_with_different_codes_are_different_review_items(two_cohort_report):
    report = copy.deepcopy(two_cohort_report)
    other = {**report["review_queue"][0], "code": "C99999"}
    report["review_queue"].append(other)
    refs = [i.ref for i in items_from_report(report) if i.detail["origin"] == "review_queue"]
    assert len(set(refs)) == 2 and not any("~" in r for r in refs)


def test_many_cohort_report_yields_groups(many_cohort_report):
    items = items_from_report(many_cohort_report)
    assert {i.kind for i in items} == {"group", "review", "unresolved"}
    assert {i.arm for i in items} == {"names_only", "identifier"}
    assert len({i.ref for i in items}) == len(items)
    groups = {i.detail["node"]: i for i in items if i.kind == "group" and i.arm == "names_only"}
    assert groups["CHEBI:4167"].suggested is False
    assert {(m["cohort"], m["key"]) for m in groups["CHEBI:4167"].members} == {
        ("a", "a1"), ("b", "b1"), ("c", "c1")}
    assert groups["CHEBI:25017"].suggested is True
    assert groups["CHEBI:25017"].detail["multiplicity"] is True
    reviews = [i for i in items if i.kind == "review" and i.arm == "names_only"]
    assert {i.detail["origin"] for i in reviews} == {"cross_node", "id_check_review",
                                                      "withheld"}
    assert all(i.suggested for i in reviews)
    cross = next(i for i in reviews if i.detail["origin"] == "cross_node")
    assert {(m["cohort"], m["key"]) for m in cross.members} == {("a", "a4"), ("b", "b3")}
    idc = next(i for i in reviews if i.detail["origin"] == "id_check_review")
    assert idc.members == ({"cohort": "c", "key": "c1", "name": "Glucose",
                            "chosenKgId": "CHEBI:4167"},)
    assert idc.detail["check"]["status"] == "not_confirmed"
    unresolved = [i for i in items if i.kind == "unresolved" and i.arm == "names_only"]
    assert [(i.members[0]["cohort"], i.members[0]["key"], i.detail["bucket"])
            for i in unresolved] == [("c", "c2", "unresolved"), ("c", "c4", "errored")]
    assert not any(i.suggested for i in unresolved)
    withheld = next(i for i in reviews if i.detail["origin"] == "withheld")
    assert withheld.detail["reason"] == "name_match_withheld"
    assert withheld.members == (
        {"cohort": "a", "key": "a5", "name": "Co", "chosenKgId": "CHEBI:27638"},
        {"cohort": "c", "key": "c3", "name": "CO", "chosenKgId": "CHEBI:17245"},
    )


def test_many_cohort_skipped_identifier_arm(many_cohort_report):
    report = copy.deepcopy(many_cohort_report)
    del report["arms"]["identifier"]  # how harmonize_many reports a skipped arm
    assert {i.arm for i in items_from_report(report)} == {"names_only"}


def test_harmonize_results_shape(results_report):
    items = items_from_report(results_report)
    assert _counts(items) == {("link", "names_only"): 3, ("unresolved", "names_only"): 2}
    unresolved = {i.members[0]["key"] for i in items if i.kind == "unresolved"}
    assert unresolved == {"Mystery peak 12", "Unknown 7"}
    assert sum(i.suggested for i in items) == 2


def test_unknown_report_kind_is_an_error():
    with pytest.raises(ValueError, match="no reviewable items"):
        items_from_report({"schema_version": 1, "kind": "something_else"})


def test_with_flags_override_wins_else_suggested(two_cohort_report):
    items = items_from_report(two_cohort_report)
    suggested = next(i for i in items if i.suggested)
    plain = next(i for i in items if not i.suggested)
    flagged = {f.item.ref: f for f in with_flags(items, {suggested.ref: False, plain.ref: True})}
    assert (flagged[suggested.ref].flagged, flagged[suggested.ref].source) == (
        False, SOURCE_ORGANIZER)
    assert (flagged[plain.ref].flagged, flagged[plain.ref].source) == (True, SOURCE_ORGANIZER)
    rest = [f for r, f in flagged.items() if r not in {suggested.ref, plain.ref}]
    assert all(f.source == SOURCE_BIOMAPPER and f.flagged == f.item.suggested for f in rest)
