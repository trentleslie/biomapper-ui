from services import sdk_meta


class TestVersionParse:
    def test_order_asserted_for_known_versions(self):
        assert sdk_meta.order_is_asserted("1.2.1") is True
        assert sdk_meta.order_is_asserted("1.0.0") is True

    def test_below_min_not_asserted(self):
        assert sdk_meta.order_is_asserted("0.9.5") is False

    def test_unknown_not_asserted(self):
        assert sdk_meta.order_is_asserted("unknown") is False
        assert sdk_meta.order_is_asserted("") is False


class TestCapture:
    def test_capture_shape(self):
        meta = sdk_meta.capture("production", "https://example.test")
        assert set(meta) == {"sdkVersion", "env", "baseUrl", "orderAsserted"}
        assert meta["env"] == "production"
        assert meta["baseUrl"] == "https://example.test"
        assert isinstance(meta["orderAsserted"], bool)

    def test_capture_defaults_env(self):
        meta = sdk_meta.capture("")
        assert meta["env"] == "unknown"

    def test_get_sdk_version_never_raises(self):
        # biomapper is mocked in CI; version lookup must degrade to a string, not raise.
        assert isinstance(sdk_meta.get_sdk_version(), str)
