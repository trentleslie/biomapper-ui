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
