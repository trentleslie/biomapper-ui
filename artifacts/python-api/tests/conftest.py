"""Conftest: mock the biomapper SDK if it is not installed locally."""
import sys
from unittest.mock import MagicMock

# Only install the mock if biomapper is not already importable (e.g. CI or
# local dev without the private package).
if "biomapper" not in sys.modules:
    try:
        import biomapper  # noqa: F401
    except ModuleNotFoundError:
        mock_biomapper = MagicMock()
        # Expose the exception classes the mapper module imports.
        mock_biomapper.BioMapperAuthError = type("BioMapperAuthError", (Exception,), {})
        mock_biomapper.BioMapperConfigError = type("BioMapperConfigError", (Exception,), {})
        mock_biomapper.BioMapperRateLimitError = type("BioMapperRateLimitError", (Exception,), {})
        mock_biomapper.BioMapperError = type("BioMapperError", (Exception,), {})
        sys.modules["biomapper"] = mock_biomapper


import pytest  # noqa: E402


@pytest.fixture(autouse=True)
def _isolated_harmonize(request, tmp_path, monkeypatch):
    """Every test gets a temp harmonize home and, by default, the replay backend.

    HARMONIZE_HOME is read when harmonize_storage is imported, so it is patched on the module;
    make_backend() reads BIOMAPPER_HARMONIZE_REPLAY_DIR when it is entered, so the env var
    works. Without this, any TestClient(app) lifespan would open the developer's real home and
    re-queue its unfinished jobs against the configured deployment. Tests that need the real
    backend opt out of the replay default with @pytest.mark.real_harmonize (the home stays temp).
    """
    from services import harmonize_storage

    monkeypatch.setattr(harmonize_storage, "HARMONIZE_HOME", tmp_path / "harmonize_home")
    if request.node.get_closest_marker("real_harmonize") is not None:
        monkeypatch.delenv("BIOMAPPER_HARMONIZE_REPLAY_DIR", raising=False)
    else:
        from tests.harmonize_fixtures import write_recording

        recordings = write_recording(tmp_path / "harmonize_default_recordings")
        monkeypatch.setenv("BIOMAPPER_HARMONIZE_REPLAY_DIR", str(recordings))


@pytest.fixture
def recording_dir(tmp_path):
    """A synthetic ReplayBackend recordings dir (two_cohort/ and many_cohort/)."""
    from tests.harmonize_fixtures import write_recording

    return write_recording(tmp_path / "recordings")


@pytest.fixture
def stub_api():
    """A local HTTP stub of the mapping API that answers /map/batch slowly."""
    from tests.harmonize_fixtures import start_stub_api

    api, server = start_stub_api()
    yield api
    server.shutdown()
    server.server_close()
