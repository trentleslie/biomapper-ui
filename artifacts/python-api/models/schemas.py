from pydantic import BaseModel, field_validator
from typing import Literal


class MappingConfig(BaseModel):
    annotation_mode: Literal["missing", "all", "none"] = "missing"
    hints: dict[str, dict[str, str | list[str]]] = {}


class BatchRequest(BaseModel):
    names: list[str]
    config: MappingConfig = MappingConfig()

    @field_validator("names")
    @classmethod
    def validate_names_limit(cls, v: list[str]) -> list[str]:
        if len(v) > 10_000:
            raise ValueError(f"Too many names: {len(v)}. Maximum is 10,000 per job.")
        return v


class JobStatus(BaseModel):
    job_id: str
    status: Literal["pending", "processing", "complete", "error"]
    completed: int
    total: int
    error_count: int
    error_message: str | None = None
    results: list[dict] = []
