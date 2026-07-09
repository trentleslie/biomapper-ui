"""Request/response schemas for ground-truth benchmarking."""
from pydantic import BaseModel, ConfigDict, Field, field_validator
from pydantic.alias_generators import to_camel

from models.schemas import MappingConfig

_MAX_NAMES = 10_000
_MAX_VOCABS_PER_NAME = 20
_MAX_IDS_PER_CELL = 500

# Ground truth: name -> vocabulary -> list of raw ids.
GroundTruth = dict[str, dict[str, list[str]]]


class BenchmarkRequest(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    names: list[str]
    ground_truth: GroundTruth
    vocabularies: list[str] | None = None
    dataset_name: str | None = Field(default=None, max_length=255)
    config: MappingConfig = MappingConfig()

    @field_validator("names")
    @classmethod
    def _validate_names(cls, v: list[str]) -> list[str]:
        if len(v) > _MAX_NAMES:
            raise ValueError(f"Too many names: {len(v)}. Maximum is {_MAX_NAMES}.")
        return v

    @field_validator("ground_truth")
    @classmethod
    def _validate_ground_truth(cls, v: GroundTruth) -> GroundTruth:
        if len(v) > _MAX_NAMES:
            raise ValueError(
                f"Ground truth covers too many names: {len(v)}. Maximum is {_MAX_NAMES}."
            )
        for name, per_vocab in v.items():
            if len(per_vocab) > _MAX_VOCABS_PER_NAME:
                raise ValueError(
                    f"Too many vocabularies for '{name}': {len(per_vocab)}. "
                    f"Maximum is {_MAX_VOCABS_PER_NAME}."
                )
            for vocab, ids in per_vocab.items():
                if len(ids) > _MAX_IDS_PER_CELL:
                    raise ValueError(
                        f"Too many ids for '{name}'/{vocab}: {len(ids)}. "
                        f"Maximum is {_MAX_IDS_PER_CELL}."
                    )
        return v


class BenchmarkRunSummary(BaseModel):
    """List-view of a benchmark run (input_names excluded — can be up to 10k)."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    run_id: str
    display_name: str | None = None
    dataset_name: str | None = None
    status: str
    error_message: str | None = None
    sdk_version: str | None = None
    env: str
    order_asserted: bool = False
    total: int = 0
    corpus_metrics: list[dict] | None = None
    created_at: float
    updated_at: float


class BenchmarkRunUpdate(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    display_name: str | None = Field(default=None, max_length=255)
