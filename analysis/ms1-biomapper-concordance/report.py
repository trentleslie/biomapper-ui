"""Unit 4: concordance metrics + markdown report.

All concordance is computed from the NAME-ONLY pass over an explicit, sized denominator
(features where both sides have an ID), stratified by tier. New-coverage is reported as
unvalidated candidates by confidence tier with a spot-check protocol. Hinted results
contribute resolution lift only — hinted-namespace agreement is circular and excluded.
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd

import compare as C
import io_and_normalize as io

ALL_NAMESPACES: tuple[str, ...] = io.SCORED_NAMESPACES + ("refmet",)
SPOT_CHECK_MIN_PER_TIER = 20


def _counts(classes: pd.Series) -> dict[str, int]:
    vc = classes.value_counts().to_dict()
    return {k: int(vc.get(k, 0)) for k in
            (C.AGREE_EXACT, C.AGREE_PARTIAL, C.DISAGREE, C.NEW_COVERAGE, C.MISSED,
             C.NONE, C.BRIDGE_UNAVAILABLE)}


def metrics_for(sub: pd.DataFrame, ns: str) -> dict:
    """Concordance metrics for one namespace over a subset of features."""
    c = _counts(pd.Series(sub[f"{ns}__class"]))
    comparable = c[C.AGREE_EXACT] + c[C.AGREE_PARTIAL] + c[C.DISAGREE]
    agree = c[C.AGREE_EXACT] + c[C.AGREE_PARTIAL]
    total = len(sub)
    return {
        **c,
        "total": total,
        "comparable": comparable,
        "comparable_frac": (comparable / total) if total else 0.0,
        "agree": agree,
        "agreement_rate": (agree / comparable) if comparable else None,
        "exact_rate": (c[C.AGREE_EXACT] / comparable) if comparable else None,
        "new_coverage": c[C.NEW_COVERAGE],
        "missed": c[C.MISSED],
    }


def _partial_cardinality(sub: pd.DataFrame, ns: str) -> dict[str, int]:
    if f"{ns}__card" not in sub.columns:
        return {}
    partial = sub[sub[f"{ns}__class"] == C.AGREE_PARTIAL]
    buckets = {"2": 0, "3-5": 0, "6+": 0}
    for card in partial[f"{ns}__card"]:
        n = int(card)
        if n <= 2:
            buckets["2"] += 1
        elif n <= 5:
            buckets["3-5"] += 1
        else:
            buckets["6+"] += 1
    return buckets


def _new_coverage_by_conf(sub: pd.DataFrame, ns: str) -> dict[str, int]:
    nc = sub[sub[f"{ns}__class"] == C.NEW_COVERAGE]
    tiers = pd.Series(nc["confidence_tier"]).fillna("unknown")
    return {str(k): int(v) for k, v in tiers.value_counts().items()}


def aggregate(comp: pd.DataFrame) -> dict:
    tiers = list(comp["match_level"].unique())
    out: dict = {
        "total": len(comp),
        "tiers": tiers,
        "namespaces": {},
        "by_tier": {},
        "partial_cardinality": {},
        "new_coverage_by_conf": {},
        "refmet_available": bool((comp["refmet__class"] != C.BRIDGE_UNAVAILABLE).any()),
    }
    for ns in ALL_NAMESPACES:
        out["namespaces"][ns] = metrics_for(comp, ns)
        out["by_tier"][ns] = {
            t: metrics_for(pd.DataFrame(comp[comp["match_level"] == t]), ns) for t in tiers
        }
        out["partial_cardinality"][ns] = _partial_cardinality(comp, ns)
        out["new_coverage_by_conf"][ns] = _new_coverage_by_conf(comp, ns)

    resolved = int(comp["resolved"].sum())
    hinted_resolved = int(comp["hinted_resolved"].sum()) if "hinted_resolved" in comp else 0
    lift = int((comp.get("hinted_resolved", pd.Series(dtype=bool)) & ~comp["resolved"]).sum()) \
        if "hinted_resolved" in comp else 0
    out["lift"] = {"name_only_resolved": resolved, "hinted_resolved": hinted_resolved,
                   "resolution_lift": lift}

    # Hinted-pass cross-namespace agreement (only meaningful if a hinted pass actually ran).
    out["hinted_ran"] = bool(comp["hinted_resolved"].any()) if "hinted_resolved" in comp else False
    out["hinted"] = {}
    if out["hinted_ran"]:
        for ns in io.SCORED_NAMESPACES:
            hh = f"{ns}__hinted_here"
            sub = comp[~comp[hh]] if hh in comp else comp.iloc[0:0]
            no = metrics_for(pd.DataFrame(sub), ns)  # name-only on the same un-hinted subset
            hsub = _counts(pd.Series(sub[f"{ns}__class_hinted"])) if len(sub) else _counts(pd.Series([], dtype=object))
            comparable = hsub[C.AGREE_EXACT] + hsub[C.AGREE_PARTIAL] + hsub[C.DISAGREE]
            agree = hsub[C.AGREE_EXACT] + hsub[C.AGREE_PARTIAL]
            out["hinted"][ns] = {
                "n_excluded_circular": int(comp[hh].sum()) if hh in comp else 0,
                "name_only_agreement": no["agreement_rate"],
                "hinted_agreement": (agree / comparable) if comparable else None,
                "comparable": comparable,
            }
    return out


# --- rendering ------------------------------------------------------------

def _pct(x: float | None) -> str:
    return "n/a" if x is None else f"{x * 100:.1f}%"


def render_markdown(m: dict, meta: dict) -> str:
    L: list[str] = []
    L.append("# MS1 ↔ Biomapper Concordance Report\n")
    L.append(f"- Run: {meta.get('timestamp', '(unstamped)')}")
    L.append(f"- Backend base_url: `{meta.get('base_url', 'default')}`")
    L.append(f"- Features: {m['total']} | tiers: {', '.join(map(str, m['tiers']))}")
    L.append(f"- Name-only resolved: {m['lift']['name_only_resolved']}/{m['total']}")
    L.append("")
    L.append("> Concordance is computed from the **name-only** pass over a **sized comparable "
             "denominator** (features where both sides have an ID). It describes only the "
             "double-annotated subset and says nothing about the ID-poor half — see New Coverage "
             "and Missed. The **hinted** pass contributes resolution lift only; hinted-namespace "
             "agreement is circular and excluded.\n")

    # Per-namespace
    L.append("## Concordance by namespace (name-only)\n")
    L.append("| Namespace | Comparable (n, % of all) | Exact | Agreement (exact+partial) | New coverage | Missed |")
    L.append("|---|---|---|---|---|---|")
    for ns in ALL_NAMESPACES:
        d = m["namespaces"][ns]
        if ns == "refmet" and not m["refmet_available"]:
            L.append(f"| {ns} | bridge unavailable — RefMet master list not in data/ | — | — | — | — |")
            continue
        L.append(f"| {ns} | {d['comparable']} ({_pct(d['comparable_frac'])}) | "
                 f"{_pct(d['exact_rate'])} | {_pct(d['agreement_rate'])} | "
                 f"{d['new_coverage']} | {d['missed']} |")
    L.append("")

    # Per-tier agreement
    L.append("## Agreement by tier (name-only)\n")
    L.append("| Namespace | " + " | ".join(str(t) for t in m["tiers"]) + " |")
    L.append("|---" * (len(m["tiers"]) + 1) + "|")
    for ns in ALL_NAMESPACES:
        if ns == "refmet" and not m["refmet_available"]:
            continue
        cells = []
        for t in m["tiers"]:
            d = m["by_tier"][ns][t]
            cells.append(f"{_pct(d['agreement_rate'])} (n={d['comparable']})")
        L.append(f"| {ns} | " + " | ".join(cells) + " |")
    L.append("")

    # Partial agreement by cardinality
    L.append("## Partial-agreement by Biomapper candidate-set size\n")
    L.append("_A partial agreement on a large candidate set is weaker (overlap by chance)._\n")
    L.append("| Namespace | card 2 | card 3-5 | card 6+ |")
    L.append("|---|---|---|---|")
    for ns in ALL_NAMESPACES:
        b = m["partial_cardinality"].get(ns) or {}
        if not b or ns == "refmet":
            continue
        L.append(f"| {ns} | {b.get('2', 0)} | {b.get('3-5', 0)} | {b.get('6+', 0)} |")
    L.append("")

    # New coverage (unvalidated)
    L.append("## New coverage — UNVALIDATED candidates\n")
    L.append(f"_No ground truth exists where the reference has no ID. Spot-check ≥{SPOT_CHECK_MIN_PER_TIER} "
             "per confidence tier against an authority and report precision with a confidence "
             "interval before treating any of this as real coverage._\n")
    L.append("| Namespace | by confidence tier |")
    L.append("|---|---|")
    for ns in ALL_NAMESPACES:
        if ns == "refmet" and not m["refmet_available"]:
            continue
        by = m["new_coverage_by_conf"].get(ns) or {}
        desc = ", ".join(f"{k}: {v}" for k, v in sorted(by.items())) or "0"
        L.append(f"| {ns} | {desc} |")
    L.append("")

    # Hinted pass
    lift = m["lift"]
    if not m.get("hinted_ran"):
        L.append("## Hinted pass\n")
        L.append("- Not run for this report (`--no-hinted`). Hints would come from the **input "
                 "side only** (HMDB parsed from MS1/MS2 names + CAS from `ms2_cas_id`), never "
                 "from the curated reference.\n")
    else:
        L.append("## Hinted-pass resolution lift\n")
        L.append(f"- Resolved name-only: {lift['name_only_resolved']} | with hints: "
                 f"{lift['hinted_resolved']} | **lift (newly resolved via hint): "
                 f"{lift['resolution_lift']}**\n")
        L.append("## Hinted-pass cross-namespace agreement (input-side hints)\n")
        L.append("_Hints are input-side (HMDB-from-names + CAS). Each namespace is scored only "
                 "on features where it was **not** itself the hint (circular cases excluded). "
                 "Compares name-only vs hinted agreement on that same un-hinted subset._\n")
        L.append("| Namespace | Name-only | Hinted | Δ | Comparable (excl. circular) |")
        L.append("|---|---|---|---|---|")
        for ns in io.SCORED_NAMESPACES:
            d = m["hinted"].get(ns) or {}
            no_a, hi_a = d.get("name_only_agreement"), d.get("hinted_agreement")
            delta = "n/a" if (no_a is None or hi_a is None) else f"{(hi_a - no_a) * 100:+.1f} pts"
            L.append(f"| {ns} | {_pct(no_a)} | {_pct(hi_a)} | {delta} | "
                     f"{d.get('comparable', 0)} (−{d.get('n_excluded_circular', 0)} HMDB-hinted) |")
        L.append("")

    L.append("## Confident-but-wrong\n")
    L.append("- The SDK exposes no resolved-entity *name*, so name-divergence flagging isn't "
             "available; the new-coverage spot-check above is the real backstop for "
             "confident-but-wrong fuzzy matches (e.g. Glucose → Blood Glucose).\n")
    return "\n".join(L)


def write_report(comp: pd.DataFrame, path: str | Path, meta: dict | None = None) -> dict:
    m = aggregate(comp)
    md = render_markdown(m, meta or {})
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(md)
    return m
