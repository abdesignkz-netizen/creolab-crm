"""Protocol checks before model loading: python test-native-speech.py /path/to/runner."""
import json
import struct
import subprocess
import sys
import unittest

RUNNER = sys.argv.pop(1)


class NativeProtocolTest(unittest.TestCase):
    def check_error(self, payload, code):
        result = subprocess.run([RUNNER, "/intentionally-absent-model"], input=payload,
                                capture_output=True, timeout=3)
        self.assertEqual(json.loads(result.stdout), {"error": code})

    def test_empty_or_excessive_chunk_count(self):
        for payload in [b"", struct.pack("<I", 0), struct.pack("<I", 601)]:
            self.check_error(payload, "voice_unsupported")

    def test_frame_bound_and_truncation(self):
        self.check_error(struct.pack("<II", 1, 480001), "voice_too_long")
        self.check_error(struct.pack("<II", 1, 100), "voice_unsupported")
        self.check_error(struct.pack("<IIf", 1, 1, float("nan")), "voice_unsupported")
        self.check_error(struct.pack("<IIf", 1, 1, 0) + b"trailing", "voice_unsupported")

    def test_total_duration_bound(self):
        chunk = struct.pack("<I", 480000) + bytes(480000 * 4)
        self.check_error(struct.pack("<I", 5) + chunk * 5, "voice_too_long")

    def test_silence_does_not_load_model(self):
        self.check_error(struct.pack("<IIf", 1, 1, 0), "voice_empty")


if __name__ == "__main__":
    unittest.main()
