"""Ground-truth scoring core.

Implements ``biomapper-eval-metrics-design.md``: per-row ``hit_ranks`` (0-indexed),
seven mutually-exclusive categories (+ a ``RUN_ERROR`` transport bucket excluded from
denominators), corpus metrics per (dataset, vocabulary) cell, and diagnostic gaps with a
reranking decision-matrix label.

Ranking trust (plan RC-1): the SDK exposes no per-candidate confidence, so ``identifiers``
list order is *trusted by contract* as descending confidence. ``kgEquivalentIds`` items are
unscored and are appended last by ``assemble_candidates``.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum

from services.benchmark_normalize import (
    SOURCE_IDENTIFIERS,
    assemble_candidates,
    normalize_gt_set,
)


class Category(str, Enum):
    EXACT_MATCH = "EXACT_MATCH"
    NORMALIZED_MATCH = "NORMALIZED_MATCH"
    NO_OVERLAP = "NO_OVERLAP"
    GROUND_TRUTH_EMPTY = "GROUND_TRUTH_EMPTY"
    RETURNED_EMPTY = "RETURNED_EMPTY"
    MALFORMED_GROUND_TRUTH = "MALFORMED_GROUND_TRUTH"
    MALFORMED_RETURNED = "MALFORMED_RETURNED"
    RUN_ERROR = "RUN_ERROR"  # transport failure — excluded from denominators


# Categories that never enter corpus denominators.
_EXCLUDED = {
    Category.GROUND_TRUTH_EMPTY,
    Category.MALFORMED_GROUND_TRUTH,
    Category.RUN_ERROR,
}
_MATCH_CATEGORIES = {Category.EXACT_MATCH, Category.NORMALIZED_MATCH}


@dataclass
class RowScore:
    name: str
    vocabulary: str
    ground_truth: list[str]
    returned_ids: list[str]  # normalized, in candidate order
    hit_ranks: tuple[int, ...]
    category: Category
    gt_size: int

    def to_log_dict(self) -> dict:
        return {
            "name": self.name,
            "vocabulary": self.vocabulary,
            "ground_truth": ";".join(self.ground_truth),
            "returned_ids": ";".join(self.returned_ids),
            "hit_ranks": ";".join(str(r) for r in self.hit_ranks),
            "category": self.category.value,
        }


def score_row(
    name: str,
    vocabulary: str,
    gt_raw: list[str],
    result: dict | None,
) -> RowScore:
    """Score one (name, vocabulary) pair against its ground-truth set.

    ``result`` is the mapper's per-name result dict, or ``None`` / an error dict for a
    transport failure (→ ``RUN_ERROR``).
    """
    # Transport failure: the name never resolved for infrastructure reasons.
    if result is None or result.get("error_type"):
        return RowScore(name, vocabulary, list(gt_raw), [], (), Category.RUN_ERROR, 0)

    gt_norm, gt_all_malformed = normalize_gt_set(vocabulary, gt_raw)
    candidates, ret_all_malformed = assemble_candidates(result, vocabulary)
    returned_norm = [c.normalized for c in candidates]

    # No ground truth for this cell → excluded from denominators.
    if not any(str(v).strip() for v in gt_raw):
        return RowScore(name, vocabulary, list(gt_raw), returned_norm, (),
                        Category.GROUND_TRUTH_EMPTY, 0)

    if gt_all_malformed:
        return RowScore(name, vocabulary, list(gt_raw), returned_norm, (),
                        Category.MALFORMED_GROUND_TRUTH, len(gt_norm))

    gt_size = len(gt_norm)

    if ret_all_malformed:
        return RowScore(name, vocabulary, list(gt_raw), returned_norm, (),
                        Category.MALFORMED_RETURNED, gt_size)

    if not candidates:
        return RowScore(name, vocabulary, list(gt_raw), returned_norm, (),
                        Category.RETURNED_EMPTY, gt_size)

    # hit_ranks: 0-indexed positions where a GT item appears in the candidate list.
    hit_ranks = tuple(
        sorted(i for i, c in enumerate(candidates) if c.normalized in gt_norm)
    )

    if not hit_ranks:
        return RowScore(name, vocabulary, list(gt_raw), returned_norm, (),
                        Category.NO_OVERLAP, gt_size)

    # EXACT vs NORMALIZED: exact iff at least one GT string matches a returned raw
    # string verbatim; else the match only fired after normalization.
    gt_raw_set = {str(v).strip() for v in gt_raw if str(v).strip()}
    exact = any(c.raw in gt_raw_set for c in candidates if c.normalized in gt_norm)
    category = Category.EXACT_MATCH if exact else Category.NORMALIZED_MATCH
    return RowScore(name, vocabulary, list(gt_raw), returned_norm, hit_ranks,
                    category, gt_size)


# --------------------------------------------------------------------------- #
# Per-row metric helpers (all derive from hit_ranks + gt_size)
# --------------------------------------------------------------------------- #

def hit_at_k(row: RowScore, k: int | None) -> int:
    if not row.hit_ranks:
        return 0
    if k is None:
        return 1
    return 1 if row.hit_ranks[0] < k else 0


def recall_at_k(row: RowScore, k: int | None) -> float:
    if row.gt_size == 0:
        return 0.0
    if k is None:
        found = len(row.hit_ranks)
    else:
        found = sum(1 for r in row.hit_ranks if r < k)
    return found / row.gt_size


def average_precision(row: RowScore) -> float:
    if row.gt_size == 0 or not row.hit_ranks:
        return 0.0
    total = 0.0
    for i, rank in enumerate(row.hit_ranks):
        total += (i + 1) / (rank + 1)
    return total / row.gt_size


def reciprocal_rank(row: RowScore) -> float:
    if not row.hit_ranks:
        return 0.0
    return 1.0 / (row.hit_ranks[0] + 1)


# --------------------------------------------------------------------------- #
# Corpus aggregation
# --------------------------------------------------------------------------- #

@dataclass
class CorpusMetrics:
    vocabulary: str
    n: int
    map: float
    mrr: float
    hit_at_1: float
    hit_at_5: float
    hit_at_inf: float
    mean_recall_at_5: float
    mean_recall_at_inf: float
    mean_candidates: float
    normalization_lift: float
    run_error_count: int
    order_asserted: bool
    decision_label: str
    diagnostics: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        d = {
            "vocabulary": self.vocabulary,
            "n": self.n,
            "map": self.map,
            "mrr": self.mrr,
            "hitAt1": self.hit_at_1,
            "hitAt5": self.hit_at_5,
            "hitAtInf": self.hit_at_inf,
            "meanRecallAt5": self.mean_recall_at_5,
            "meanRecallAtInf": self.mean_recall_at_inf,
            "meanCandidates": self.mean_candidates,
            "normalizationLift": self.normalization_lift,
            "runErrorCount": self.run_error_count,
            "orderAsserted": self.order_asserted,
            "decisionLabel": self.decision_label,
            "diagnostics": self.diagnostics,
        }
        return d


def _mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def aggregate(rows: list[RowScore], vocabulary: str, order_asserted: bool) -> CorpusMetrics:
    """Aggregate per-row scores for one vocabulary into corpus metrics + diagnostics."""
    scored = [r for r in rows if r.category not in _EXCLUDED]
    run_errors = sum(1 for r in rows if r.category is Category.RUN_ERROR)
    n = len(scored)

    if n == 0:
        return CorpusMetrics(
            vocabulary, 0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
            run_errors, order_asserted, "NO DATA",
            {"note": "no scorable rows"},
        )

    hit1 = _mean([hit_at_k(r, 1) for r in scored])
    hit5 = _mean([hit_at_k(r, 5) for r in scored])
    hit_inf = _mean([hit_at_k(r, None) for r in scored])
    recall5 = _mean([recall_at_k(r, 5) for r in scored])
    recall_inf = _mean([recall_at_k(r, None) for r in scored])
    map_ = _mean([average_precision(r) for r in scored])
    mrr = _mean([reciprocal_rank(r) for r in scored])

    cand_counts = [len(r.returned_ids) for r in scored if r.returned_ids]
    mean_candidates = _mean([float(c) for c in cand_counts])

    total_matches = sum(1 for r in scored if r.category in _MATCH_CATEGORIES)
    norm_only = sum(1 for r in scored if r.category is Category.NORMALIZED_MATCH)
    norm_lift = (norm_only / total_matches) if total_matches else 0.0

    diagnostics = {
        "rankingGap": round(hit_inf - hit1, 4),
        "rerankingHeadroom": round(hit5 - hit1, 4),
        "recallHeadroom": round(recall_inf - recall5, 4),
        "normalizationLift": round(norm_lift, 4),
    }
    label = decision_label(hit1, hit5, hit_inf, norm_lift, order_asserted)

    return CorpusMetrics(
        vocabulary=vocabulary,
        n=n,
        map=round(map_, 4),
        mrr=round(mrr, 4),
        hit_at_1=round(hit1, 4),
        hit_at_5=round(hit5, 4),
        hit_at_inf=round(hit_inf, 4),
        mean_recall_at_5=round(recall5, 4),
        mean_recall_at_inf=round(recall_inf, 4),
        mean_candidates=round(mean_candidates, 4),
        normalization_lift=round(norm_lift, 4),
        run_error_count=run_errors,
        order_asserted=order_asserted,
        decision_label=label,
        diagnostics=diagnostics,
    )


def decision_label(
    hit1: float, hit5: float, hit_inf: float, norm_lift: float, order_asserted: bool
) -> str:
    """Reranking decision-matrix label (design doc). Requires trusted ordering to make
    rank-based calls; if ordering is not asserted, only coverage claims are honest."""
    if norm_lift > 0.05:
        return "FIX UPSTREAM"
    tol = 0.03
    if not order_asserted:
        return "SHIP" if hit_inf >= 0.8 else "ADD ANNOTATORS"
    if hit_inf < 0.5:
        return "ADD ANNOTATORS"
    if abs(hit1 - hit_inf) <= tol and abs(hit1 - hit5) <= tol:
        return "SHIP"
    if (hit_inf - hit5) <= tol and (hit5 - hit1) > tol:
        return "RERANK"
    if (hit_inf - hit5) > tol:
        return "ADD ANNOTATORS"
    return "SHIP"


def score_dataset(
    gt_by_name: dict[str, dict[str, list[str]]],
    results_by_name: dict[str, dict | None],
    vocabularies: list[str],
    order_asserted: bool,
) -> dict:
    """Score a whole dataset.

    ``gt_by_name``: name -> {vocab -> [raw gt ids]}. ``results_by_name``: name -> mapper
    result dict (or None/error dict). Returns ``{"corpus": [...], "rows": [...]}``.
    """
    rows: list[RowScore] = []
    for name, per_vocab in gt_by_name.items():
        result = results_by_name.get(name)
        for vocab in vocabularies:
            gt_raw = per_vocab.get(vocab, [])
            rows.append(score_row(name, vocab, gt_raw, result))

    corpus = []
    for vocab in vocabularies:
        vocab_rows = [r for r in rows if r.vocabulary == vocab]
        # Skip vocabularies with no ground truth anywhere (honest omission, not zeros).
        if all(r.category is Category.GROUND_TRUTH_EMPTY for r in vocab_rows):
            continue
        corpus.append(aggregate(vocab_rows, vocab, order_asserted).to_dict())

    return {
        "corpus": corpus,
        "rows": [r.to_log_dict() for r in rows],
    }
