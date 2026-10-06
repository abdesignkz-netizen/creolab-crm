import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("installer", Path(__file__).with_name("install-speech-model.py"))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallSafetyTest(unittest.TestCase):
    def test_active_model_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / "model.bin").write_bytes(b"existing")
            with patch.object(installer, "snapshot_download") as download:
                with self.assertRaisesRegex(ValueError, "empty model directory"):
                    installer.install(path)
                download.assert_not_called()
            self.assertEqual((path / "model.bin").read_bytes(), b"existing")

    def test_failed_download_never_creates_ready_marker(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "model"
            with patch.object(installer, "snapshot_download", side_effect=RuntimeError("network unavailable")):
                with self.assertRaises(RuntimeError):
                    installer.install(target, "tiny")
            self.assertFalse((target / "basqar-profile.json").exists())

    def test_unknown_profile_is_rejected_without_network(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(installer, "snapshot_download") as download:
                with self.assertRaisesRegex(ValueError, "Unsupported"):
                    installer.install(Path(directory) / "model", "unknown")
                download.assert_not_called()


if __name__ == "__main__":
    unittest.main()
