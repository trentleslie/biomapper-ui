"""Guard: the real biomapper package must be importable (not the conftest mock)."""
import biomapper


def test_biomapper_is_real_package():
    assert isinstance(biomapper.__version__, str)
