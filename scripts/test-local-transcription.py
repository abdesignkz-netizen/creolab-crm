import importlib.util
import io
from pathlib import Path
import unittest
from unittest.mock import patch
import wave

spec = importlib.util.spec_from_file_location("speech", Path(__file__).with_name("local-transcription.py"))
speech = importlib.util.module_from_spec(spec)
spec.loader.exec_module(speech)


class SpeechSafetyTest(unittest.TestCase):
    def test_memory_uses_container_headroom_not_host_ram(self):
        values = {"/proc/meminfo": "MemAvailable: 32000000 kB\n",
                  "/sys/fs/cgroup/memory.max": str(512 * 1024**2),
                  "/sys/fs/cgroup/memory.current": str(400 * 1024**2)}

        def reader(name):
            if name not in values:
                raise FileNotFoundError(name)
            return io.StringIO(values[name])
        with patch("builtins.open", side_effect=reader):
            self.assertEqual(speech.available_memory(), 112 * 1024**2)

    def test_missing_capacity_fails_closed(self):
        with patch("builtins.open", side_effect=FileNotFoundError):
            self.assertIsNone(speech.available_memory())

    def test_nested_service_limit(self):
        values = {"/proc/meminfo": "MemAvailable: 32000000 kB\n",
                  "/proc/self/cgroup": "0::/system.slice/basqar.service\n",
                  "/sys/fs/cgroup/system.slice/memory.max": str(1024 * 1024**2),
                  "/sys/fs/cgroup/system.slice/memory.current": str(400 * 1024**2)}

        def reader(name):
            if name not in values:
                raise FileNotFoundError(name)
            return io.StringIO(values[name])
        with patch("builtins.open", side_effect=reader):
            self.assertEqual(speech.available_memory(), 624 * 1024**2)

    def test_insufficient_memory_does_not_load_engine_or_read_audio(self):
        with patch.object(speech, "available_memory", return_value=1024), patch.object(speech, "transcribe") as transcribe:
            self.assertEqual(speech.main(), {"error": "voice_resources"})
            transcribe.assert_not_called()

    def test_busy_worker_retries_without_reading_audio(self):
        with patch.object(speech.fcntl, "flock", side_effect=BlockingIOError):
            self.assertEqual(speech.main(), {"error": "voice_pending"})

    def audio(self, seconds):
        result = io.BytesIO()
        with wave.open(result, "wb") as source:
            source.setnchannels(1)
            source.setsampwidth(2)
            source.setframerate(16000)
            source.writeframes(b"\0\0" * (16000 * seconds))
        return result.getvalue()

    def test_duration_limit_is_enforced_on_decoded_samples(self):
        self.assertEqual(speech.decode_audio(self.audio(1)).shape, (16000,))
        with self.assertRaisesRegex(ValueError, "voice_too_long"):
            speech.decode_audio(self.audio(121))

    def test_playlist_cannot_open_a_file(self):
        with self.assertRaises(Exception):
            speech.decode_audio(b"#EXTM3U\n#EXTINF:1,\nfile:///etc/passwd\n")


if __name__ == "__main__":
    unittest.main()
