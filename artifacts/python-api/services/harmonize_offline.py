"""Finished-jobs mode: harmonize two finished mapping jobs offline, with no re-mapping.

A mapping job stores one UI-shaped row per name (``services.mapper.MapperService._process_result``).
:func:`to_mapping_result` rebuilds the package's ``MappingResult`` from such a row, carrying
exactly what :func:`biomapper.harmonize.harmonize` reads: ``query_name``, ``error``,
``chosen_kg_id``, ``kg_equivalent_ids``, ``chosen_kg_id_review``, the certificate state and the
mixture flag. Rows stored before ``chosenKgId`` was recorded cannot be rebuilt faithfully (the
chosen node seeds the identifier set and the ``node`` basis), so they are refused, never
approximated.

:func:`harmonize_finished_jobs` wraps ``HarmonizationResult.to_dict()`` as a ``report.json``
of kind ``harmonize_results``, with the result under ``arms.names_only`` so items, flags and
exports read it like the other two kinds.
"""
from __future__ import annotations

from collections import Counter
from typing import Any

from biomapper import MappingResult
from biomapper.harmonize import harmonize
from biomapper.models import ResolutionCertificate

KIND_RESULTS = "harmonize_results"
DEFAULT_ENTITY_TYPE = "biolink:SmallMolecule"  # MappingConfig's default entity_type

REMAP_MESSAGE = ("This job was mapped before harmonizing finished jobs was supported. "
                 "Map the file again, then harmonize.")
SKIPPED_MESSAGE = "This row was not mapped because its job stopped early."

_NAME_LINKS_ON = (
    "Name links are on because they were turned on for this run. Two resolved rows whose names "
    "are equal (exactly, or ignoring case when both names are longer than 4 characters) are "
    "linked even when they resolved to different nodes, and each such link says so in its basis "
    "(name_exact or name_casefold)."
)
_NAME_LINKS_OFF = (
    "Name links are off because they were left off for this run, so rows link by identifier "
    "only."
)


class StaleMappingJobError(ValueError):
    """A stored row lacks the fields harmonize() needs. The message is written for end users."""

    def __init__(self) -> None:
        super().__init__(REMAP_MESSAGE)


def entity_type(job: dict[str, Any]) -> str:
    """The entity type a mapping job was run with."""
    return (job.get("config") or {}).get("entity_type") or DEFAULT_ENTITY_TYPE


def is_stale_row(stored_row: dict[str, Any]) -> bool:
    """True for a successfully mapped row stored before ``chosenKgId`` was recorded."""
    return not stored_row.get("error") and not stored_row.get("skipped") \
        and "chosenKgId" not in stored_row


def to_mapping_result(stored_row: dict[str, Any]) -> MappingResult:
    """Rebuild the ``MappingResult`` harmonize() reads from one stored mapping-job row.

    Raises:
        StaleMappingJobError: The row was mapped before ``chosenKgId`` was stored.
    """
    name = str(stored_row.get("name", ""))
    if stored_row.get("error"):
        return MappingResult(query_name=name, error=str(stored_row["error"]))
    if stored_row.get("skipped"):
        return MappingResult(query_name=name, error=SKIPPED_MESSAGE)
    if is_stale_row(stored_row):
        raise StaleMappingJobError()
    state = stored_row.get("certificateState")
    return MappingResult(
        query_name=name,
        resolved=bool(stored_row.get("resolved")),
        primary_curie=stored_row.get("primaryCurie"),
        chosen_kg_id=stored_row.get("chosenKgId"),
        chosen_kg_id_review=stored_row.get("chosenKgIdReview"),
        kg_equivalent_ids=dict(stored_row.get("kgEquivalentIds") or {}),
        certificate=ResolutionCertificate(state=state) if state is not None else None,
        name_is_mixture=stored_row.get("nameIsMixture"),
    )


def _results(job: dict[str, Any], side: str) -> list[MappingResult]:
    rows = job.get("results") or []
    repeated = [n for n, c in Counter(str(r.get("name", "")) for r in rows).items() if c > 1]
    if repeated:
        raise ValueError(
            f"Job {side} lists the name '{repeated[0]}' more than once, so its rows cannot be "
            "told apart. Map a file that lists each name once, then harmonize."
        )
    return [to_mapping_result(r) for r in rows]


def harmonize_finished_jobs(
    job_a: dict[str, Any],
    job_b: dict[str, Any],
    *,
    a_label: str,
    b_label: str,
    link_by_name: bool,
) -> dict[str, Any]:
    """Harmonize two finished mapping jobs (``database.get_job`` dicts) into a report dict.

    The caller checks ownership, that both jobs finished and that they share an entity type.

    Raises:
        StaleMappingJobError: A row was mapped before ``chosenKgId`` was stored.
        ValueError: Equal or reserved labels, or a job that lists one name twice (end-user
            messages).
    """
    result = harmonize(_results(job_a, "A"), _results(job_b, "B"),
                       a_label=a_label, b_label=b_label, link_by_name=link_by_name)
    return {
        "schema_version": 1,
        "kind": KIND_RESULTS,
        "labels": [a_label, b_label],
        "entity": entity_type(job_a),
        "name_linking": {
            "enabled": link_by_name,
            "decided_by": "user",
            "overridable": True,
            "reason": _NAME_LINKS_ON if link_by_name else _NAME_LINKS_OFF,
        },
        "arms": {"names_only": result.to_dict(), "identifier": None},
    }
