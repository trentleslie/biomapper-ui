from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel
from typing import Literal


class FeedbackMeta(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    page_url: str | None = None
    job_id: str | None = None
    user_agent: str | None = None
    expected_result: str | None = None
    steps_to_reproduce: str | None = None


class FeedbackRequest(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    category: Literal["annotation_issue", "feature_request", "ui_error"]
    description: str = Field(min_length=10, max_length=5000)
    metadata: FeedbackMeta = FeedbackMeta()
    user_email: str
