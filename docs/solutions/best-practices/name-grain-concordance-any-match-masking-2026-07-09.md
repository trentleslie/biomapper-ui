---
title: Name-grain concordance must expose the one-to-many spectral→name problem, not average it away
date: 2026-07-09
category: docs/solutions/best-practices
module: analysis/ms1-biomapper-concordance
problem_type: best_practice
component: tooling
severity: medium
applies_when:
  - Aggregating a per-feature (per-spectrum) metric up to a coarser grain (compound name, gene, sample)
  - Comparing a one-to-many annotation source against a source that is already collapsed to the coarse grain
  - Reporting a single "concordance" or "agreement" headline that could hide within-group disagreement
  - Building offline/deterministic analysis layers on top of an existing feature-grain table
tags: [concordance, metabolomics, aggregation, measurement-design, any-match, biomapper, matched-name]
related_components: [analysis-harness, hmdb-mapping]
---

# Name-grain concordance must expose the one-to-many spectral→name problem, not average it away

## Context

The MS1↔BioMapper concordance harness (`analysis/ms1-biomapper-concordance/`, PR
[#24](https://github.com/trentleslie/biomapper-ui/pull/24)) already produced a feature-grain
(per-spectrum) tiered table. BioMapper, however, maps each `matched_name` to HMDB exactly once —
its output is *already* name-grain — while the embedded spectral HMDB is a per-feature annotation and
many features share a name (758 names over 1,556 features). Comparing the two at the feature grain
double-counts the collapsed side and blends genuinely different spectra under one label.

The friction: any single roll-up to the name grain risks producing a reassuring headline
("X% concordant") that averages away exactly the phenomenon under investigation — one compound name
carrying several distinct spectral IDs, some of which agree with BioMapper and some of which do not.
The `name_concordance.py` layer was designed to make that one-to-many structure visible rather than
to collapse it into a single number.

Supplementary context (auto memory [claude]): the *MS1 reliability reframe* — embedded HMDB is MSI
Level 3 (least reliable), MS2/CURATION "disagreements" are mostly tier artifacts of wrong MS1
annotations, and the analysis must not silently revert to trusting raw MS1. This is why the name-grain
roll-up keys on the **cleanest-tier** HMDB (`best_tier_hmdb`, group_MS2 → MS2 → MS1), not the raw
all-tier `spectral_hmdb`.

## Guidance

When aggregating a one-to-many metric up to a coarser grain, do not emit a single overlap number.
Emit a small vector of axes chosen so that the aggregation *cannot* hide the very structure you are
measuring. The name-grain layer uses four:

1. **A permissive "any-match" state, labeled as such.** `name_state` = set-overlap of the name's
   best-tier spectral HMDB union against BioMapper's union (`concordant` if the sets intersect at all,
   else `disagree`, or `no_biomapper` when BioMapper returned nothing). This is deliberately an
   *upper bound* — one agreeing feature makes the whole name "concordant." It is useful only when
   named honestly and paired with the next axis.

2. **The resolution the any-match state hides.** `agreement_fraction` = concordant / *comparable*
   features (comparable = BioMapper actually returned an ID to agree or disagree with). This is the
   number that falls when a name's features disagree among themselves. Report `agreement_lt_1` — how
   many names have `agreement_fraction < 1.0` — as a first-class headline.

3. **A within-group consistency descriptor over comparable features only.**
   `single` / `unanimous` / `mixed` over the comparable features' `best_tier_state`. Crucially,
   `no_biomapper` features are **excluded** from consistency and reported *separately* as coverage —
   folding "no ID returned" into "disagreement" is a category error that inflates the disagree count.

4. **An identity-homogeneity flag.** `spectral_homogeneous` = the name carries a single distinct
   best-tier spectral ID. State agreement is blind to *agreement-via-different-molecules*: a name can
   be `unanimous` yet heterogeneous (all its features agree on *state* while pointing at different
   molecules). The summary surfaces this as `spectral_heterogeneous` = `unanimous & not homogeneous`.

Keep the layer offline and deterministic (reads the existing tiered CSV, reuses cached
`group_character` characterization — no SDK/LLM calls), and prepend a self-describing provenance
comment to the output CSV so the "any-match upper bound" caveat travels with the data.

## Why This Matters

The trap this design defends against: a naïve name-grain roll-up would have reported a high
concordance headline while silently absorbing the one-to-many disagreements that are the *entire point*
of the investigation. Two features sharing a name but carrying different spectral IDs — one matching
BioMapper, one not — would collapse to a single "concordant" row and vanish from the report.

The validation caught by keeping the axes separate:
- **`agreement_fraction` exposed the masking directly** — it is defined as the fraction the any-match
  `name_state` throws away, so any gap between the two is precisely the hidden within-name
  disagreement.
- **`spectral_heterogeneous` (unanimous-yet-multi-ID) surfaced a subtler failure** — names where
  every feature agrees on *state* but the underlying molecules differ, i.e. agreement for the wrong
  reason. A single overlap metric is structurally incapable of catching this.
- **Separating `no_biomapper` as coverage** prevented conflating "BioMapper declined to map" with
  "BioMapper disagreed," which would have overstated disagreement.

More generally: whenever you collapse a one-to-many relation to report an agreement rate, the
collapse operator (union / any-match / majority) *is* a modeling choice that can manufacture or erase
the finding. Make that choice explicit and always ship the complementary "what did the collapse hide"
axis alongside it.

## When to Apply

- Rolling a per-feature / per-spectrum / per-row metric up to a compound name, gene, sample, or any
  coarser key where one coarse key spans many fine rows.
- Comparing a one-to-many source against a source already collapsed to the coarse grain (the join
  double-counts the collapsed side otherwise).
- Any time a single "concordance %" headline is about to be reported over grouped data — pair it with
  a within-group agreement fraction and a homogeneity flag.
- Reusing a tier-resolved / cleanest-value column (here `best_tier_hmdb`) so the roll-up stays
  consistent with an upstream reliability reframe instead of silently reintroducing the noisy raw
  values.

## Examples

Two axes on the same name make the masking visible:

```python
# name_state is a permissive upper bound: ANY overlapping id -> "concordant"
def name_state(spectral: set[str], bmap: set[str]) -> str:
    if not bmap:
        return NO_BIOMAPPER            # reported as coverage, NOT as disagreement
    return CONCORDANT if (spectral & bmap) else DISAGREE

# agreement_fraction is the resolution name_state hides: concordant / comparable features.
# comparable = features where BioMapper returned an id (CONCORDANT or DISAGREE), excluding no_biomapper.
def agreement_fraction(best_tier_states: list[str]) -> float | None:
    comparable = [s for s in best_tier_states if s in COMPARABLE]
    if not comparable:
        return None
    return sum(1 for s in comparable if s == CONCORDANT) / len(comparable)
```

Concrete masking case: a `matched_name` with 3 features whose best-tier states are
`[concordant, disagree, no_biomapper]`.

| Axis | Value | What it tells you |
|------|-------|-------------------|
| `name_state` | `concordant` | at least one feature's spectral id overlaps BioMapper (upper bound) |
| `agreement_fraction` | `0.5` | of the 2 *comparable* features, only 1 agrees — the disagreement the state hid |
| `consistency` | `mixed` | comparable features do not agree among themselves |
| `n_no_bmap_features` | `1` | reported as coverage, not counted as disagreement |

The headline the summary reports is therefore not just `concordance_pct` but also `agreement_lt_1`
(names with sub-1.0 agreement) and `spectral_heterogeneous` (unanimous-yet-multi-id names) — the two
tallies a single overlap number would have erased. Validated with 5 unit tests
(`tests/test_name_concordance.py`); full suite 94 passing.

## Related

- Auto-memory: *MS1 reliability reframe* (`project_ms1_reliability_reframe.md`) — why the roll-up keys
  on cleanest-tier HMDB, and why raw MS1 must not be re-trusted.
- Upstream layer: `tier_resolved.py` (per-feature concordance cut by HMDB source tier) produces
  `two_way_comprehensive_tiered.csv`, the input to `name_concordance.py`.
- Curated-free two-way delta (`two_way.py`) — origin of the shared `concordant` / `disagree` /
  `no_biomapper` state vocabulary reused here.
- PR [#24](https://github.com/trentleslie/biomapper-ui/pull/24) — MS1 ↔ BioMapper concordance harness.
