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
    """A synthetic ReplayBackend recordings dir (two_cohort/recording/ and many_cohort/recording/)."""
    from tests.harmonize_fixtures import write_recording

    return write_recording(tmp_path / "recordings")


@pytest.fixture
def two_cohort_report():
    """A real ``harmonize_cohorts`` report.json dict (both arms), generated offline."""
    from tests.harmonize_fixtures import make_two_cohort_report

    return make_two_cohort_report()


@pytest.fixture
def two_cohort_report_names_only():
    """A real ``harmonize_cohorts`` report whose identifier arm was skipped (``None``)."""
    from tests.harmonize_fixtures import make_two_cohort_report

    return make_two_cohort_report(shared_vocabulary=False)


@pytest.fixture
def many_cohort_report():
    """A real ``harmonize_many`` report.json dict over three cohorts, generated offline."""
    from tests.harmonize_fixtures import make_many_cohort_report

    return make_many_cohort_report()


@pytest.fixture
def results_report():
    """The ``harmonize_results`` report shape, built with the package's ``harmonize()``."""
    from tests.harmonize_fixtures import make_results_report

    return make_results_report()


@pytest.fixture
def real_recording_dir(tmp_path, two_cohort_report, many_cohort_report):
    """A ReplayBackend recordings dir whose report.json files are the real reports above."""
    from tests.harmonize_fixtures import write_recording

    return write_recording(tmp_path / "real_recordings", two_cohort_report=two_cohort_report,
                           many_cohort_report=many_cohort_report)


@pytest.fixture
def stub_api():
    """A local HTTP stub of the mapping API that answers /map/batch slowly."""
    from tests.harmonize_fixtures import start_stub_api

    api, server = start_stub_api()
    yield api
    server.shutdown()
    server.server_close()
