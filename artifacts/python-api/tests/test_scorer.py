from services.scorer import (
    Category,
    aggregate,
    average_precision,
    decision_label,
    hit_at_k,
    recall_at_k,
    score_dataset,
    score_row,
)


def _result(hmdb=None, kg_hmdb=None, error_type=None):
    return {
        "identifiers": {"hmdb": list(hmdb or [])},
        "kgEquivalentIds": {"HMDB": list(kg_hmdb or [])} if kg_hmdb else {},
        **({"error_type": error_type} if error_type else {}),
    }


class TestCategories:
    def test_exact_match(self):
        r = score_row("glucose", "hmdb", ["HMDB0000122"], _result(hmdb=["HMDB0000122"]))
        assert r.category is Category.EXACT_MATCH
        assert r.hit_ranks == (0,)

    def test_normalized_match(self):
        r = score_row("glucose", "hmdb", ["HMDB122"], _result(hmdb=["HMDB0000122"]))
        assert r.category is Category.NORMALIZED_MATCH
        assert r.hit_ranks == (0,)

    def test_no_overlap(self):
        r = score_row("x", "hmdb", ["HMDB0000001"], _result(hmdb=["HMDB0000002"]))
        assert r.category is Category.NO_OVERLAP
        assert r.hit_ranks == ()

    def test_ground_truth_empty(self):
        r = score_row("x", "hmdb", [""], _result(hmdb=["HMDB0000002"]))
        assert r.category is Category.GROUND_TRUTH_EMPTY

    def test_returned_empty(self):
        r = score_row("x", "hmdb", ["HMDB0000001"], _result(hmdb=[]))
        assert r.category is Category.RETURNED_EMPTY

    def test_malformed_ground_truth(self):
        r = score_row("x", "hmdb", ["HMDB", "junk"], _result(hmdb=["HMDB0000001"]))
        assert r.category is Category.MALFORMED_GROUND_TRUTH

    def test_malformed_returned(self):
        r = score_row("x", "hmdb", ["HMDB0000001"], _result(hmdb=["HMDB", "junk"]))
        assert r.category is Category.MALFORMED_RETURNED

    def test_run_error_from_error_type(self):
        r = score_row("x", "hmdb", ["HMDB0000001"], _result(error_type="mapping_error"))
        assert r.category is Category.RUN_ERROR

    def test_run_error_from_none(self):
        r = score_row("x", "hmdb", ["HMDB0000001"], None)
        assert r.category is Category.RUN_ERROR


class TestHitRanksAndMetrics:
    def test_hit_ranks_positions(self):
        r = score_row("x", "hmdb", ["HMDB0000003"],
                      _result(hmdb=["HMDB0000001", "HMDB0000002", "HMDB0000003"]))
        assert r.hit_ranks == (2,)
        assert hit_at_k(r, 1) == 0
        assert hit_at_k(r, 5) == 1
        assert hit_at_k(r, None) == 1

    def test_multi_item_recall(self):
        r = score_row("x", "hmdb", ["HMDB0000001", "HMDB0000003", "HMDB0000009"],
                      _result(hmdb=["HMDB0000001", "HMDB0000002", "HMDB0000003"]))
        assert r.hit_ranks == (0, 2)
        assert r.gt_size == 3
        assert recall_at_k(r, 5) == 2 / 3
        assert recall_at_k(r, None) == 2 / 3

    def test_kg_only_hit_scores_as_match(self):
        r = score_row("x", "hmdb", ["HMDB0000294"], _result(hmdb=[], kg_hmdb=["HMDB294"]))
        assert r.category is Category.NORMALIZED_MATCH
        assert r.hit_ranks == (0,)

    def test_single_item_ap_equals_rr(self):
        r = score_row("x", "hmdb", ["HMDB0000002"],
                      _result(hmdb=["HMDB0000001", "HMDB0000002"]))
        # single GT: AP collapses to 1/(rank+1) = RR
        assert average_precision(r) == 1 / 2

    def test_average_precision_multi(self):
        r = score_row("x", "hmdb", ["HMDB0000001", "HMDB0000003"],
                      _result(hmdb=["HMDB0000001", "HMDB0000002", "HMDB0000003"]))
        # ranks (0,2): (1/1 + 2/3) / 2
        assert abs(average_precision(r) - ((1 / 1 + 2 / 3) / 2)) < 1e-9


class TestAggregate:
    def test_empty_and_run_error_excluded_from_denominator(self):
        rows = [
            score_row("a", "hmdb", ["HMDB0000001"], _result(hmdb=["HMDB0000001"])),  # exact
            score_row("b", "hmdb", [""], _result(hmdb=["HMDB0000002"])),             # gt empty (excl)
            score_row("c", "hmdb", ["HMDB0000003"], None),                            # run_error (excl)
        ]
        m = aggregate(rows, "hmdb", order_asserted=True)
        assert m.n == 1  # only the exact-match row is scorable
        assert m.hit_at_1 == 1.0
        assert m.run_error_count == 1

    def test_normalization_lift(self):
        rows = [
            score_row("a", "hmdb", ["HMDB0000001"], _result(hmdb=["HMDB0000001"])),  # exact
            score_row("b", "hmdb", ["HMDB2"], _result(hmdb=["HMDB0000002"])),         # normalized
        ]
        m = aggregate(rows, "hmdb", order_asserted=True)
        assert m.normalization_lift == 0.5

    def test_mean_candidates_guardrail(self):
        rows = [
            score_row("a", "hmdb", ["HMDB0000001"],
                      _result(hmdb=["HMDB0000001", "HMDB0000002", "HMDB0000003"])),
        ]
        m = aggregate(rows, "hmdb", order_asserted=True)
        assert m.mean_candidates == 3.0

    def test_diagnostics_present(self):
        rows = [score_row("a", "hmdb", ["HMDB0000003"],
                          _result(hmdb=["HMDB0000001", "HMDB0000002", "HMDB0000003"]))]
        m = aggregate(rows, "hmdb", order_asserted=True)
        assert "rerankingHeadroom" in m.diagnostics
        assert m.diagnostics["rerankingHeadroom"] == 1.0  # hit5(1) - hit1(0)


class TestDecisionLabel:
    def test_ship_when_ranks_tight(self):
        assert decision_label(0.85, 0.85, 0.85, 0.0, True) == "SHIP"

    def test_rerank_when_top5_beats_top1(self):
        assert decision_label(0.5, 0.85, 0.85, 0.0, True) == "RERANK"

    def test_add_annotators_when_buried(self):
        assert decision_label(0.4, 0.45, 0.85, 0.0, True) == "ADD ANNOTATORS"

    def test_fix_upstream_on_high_norm_lift(self):
        assert decision_label(0.8, 0.85, 0.9, 0.2, True) == "FIX UPSTREAM"

    def test_unasserted_order_only_coverage_claim(self):
        # With ordering not asserted, high coverage still ships but no rank-based rerank call.
        assert decision_label(0.5, 0.85, 0.9, 0.0, False) == "SHIP"


class TestScoreDataset:
    def test_empty_vocab_omitted_not_zeroed(self):
        gt = {"a": {"hmdb": ["HMDB0000001"], "chebi": [""]}}
        results = {"a": _result(hmdb=["HMDB0000001"])}
        out = score_dataset(gt, results, ["hmdb", "chebi"], order_asserted=True)
        vocabs = {c["vocabulary"] for c in out["corpus"]}
        assert vocabs == {"hmdb"}  # chebi omitted (no GT), not shown as 0.0

    def test_rows_and_corpus_returned(self):
        gt = {"a": {"hmdb": ["HMDB0000001"]}, "b": {"hmdb": ["HMDB0000009"]}}
        results = {"a": _result(hmdb=["HMDB0000001"]), "b": _result(hmdb=["HMDB0000002"])}
        out = score_dataset(gt, results, ["hmdb"], order_asserted=True)
        assert len(out["rows"]) == 2
        assert out["corpus"][0]["n"] == 2
        assert out["corpus"][0]["hitAt1"] == 0.5
