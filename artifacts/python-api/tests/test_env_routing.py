import os
import pytest
from unittest.mock import patch

from fastapi import HTTPException

from services.env_routing import resolve_env_base_url
from services.jobs import Job, JobStore


class TestResolveEnvBaseUrl:
    """Tests for the resolve_env_base_url helper."""

    @patch.dict(os.environ, {"BIOMAPPER_BASE_URL": "http://localhost:8001/api/v1"})
    def test_production_explicit(self):
        env, url = resolve_env_base_url("production")
        assert env == "production"
        assert url == "http://localhost:8001/api/v1"

    @patch.dict(os.environ, {"BIOMAPPER_BASE_URL": "http://localhost:8001/api/v1"})
    def test_production_default_when_none(self):
        env, url = resolve_env_base_url(None)
        assert env == "production"
        assert url == "http://localhost:8001/api/v1"

    @patch.dict(os.environ, {"BIOMAPPER_DEV_BASE_URL": "http://localhost:8003/api/v1"})
    def test_dev_env(self):
        env, url = resolve_env_base_url("dev")
        assert env == "dev"
        assert url == "http://localhost:8003/api/v1"

    @patch.dict(os.environ, {}, clear=True)
    def test_dev_env_not_configured(self):
        # Remove any existing env vars
        os.environ.pop("BIOMAPPER_DEV_BASE_URL", None)
        with pytest.raises(HTTPException) as exc_info:
            resolve_env_base_url("dev")
        assert exc_info.value.status_code == 503
        assert "not configured" in str(exc_info.value.detail)

    def test_invalid_env_value(self):
        with pytest.raises(HTTPException) as exc_info:
            resolve_env_base_url("staging")
        assert exc_info.value.status_code == 400
        assert "Invalid" in str(exc_info.value.detail)

    @patch.dict(os.environ, {"BIOMAPPER_BASE_URL": "http://localhost:8001/api/v1"})
    def test_empty_string_defaults_to_production(self):
        """Empty string should default to production."""
        env, url = resolve_env_base_url("")
        assert env == "production"

    @patch.dict(os.environ, {"BIOMAPPER_DEV_BASE_URL": "http://localhost:8003/api/v1"})
    def test_case_insensitive(self):
        env, url = resolve_env_base_url("Dev")
        assert env == "dev"
        assert url == "http://localhost:8003/api/v1"


class TestJobEnvField:
    """Tests for the env field on Job and JobStore."""

    def test_job_default_env(self):
        job = Job("test-id", total=5)
        assert job.env == "production"

    def test_job_custom_env(self):
        job = Job("test-id", total=5, env="dev")
        assert job.env == "dev"

    def test_job_to_dict_includes_env(self):
        job = Job("test-id", total=5, env="dev")
        d = job.to_dict()
        assert d["env"] == "dev"

    def test_job_store_create_with_env(self):
        store = JobStore()
        job = store.create("test-id", total=3, env="dev")
        assert job.env == "dev"
        retrieved = store.get("test-id")
        assert retrieved is not None
        assert retrieved.env == "dev"

    def test_job_store_create_default_env(self):
        store = JobStore()
        job = store.create("test-id", total=3)
        assert job.env == "production"
