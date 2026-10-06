import importlib.util
import io
from pathlib import Path
import unittest
from unittest.mock import patch
import wave
import tempfile
import json
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location("speech", Path(__file__).with_name("local-transcription.py"))
speech = importlib.util.module_from_spec(spec)
spec.loader.exec_module(speech)


class SpeechSafetyTest(unittest.TestCase):
    def test_language_selection_is_limited_to_russian_and_kazakh(self):
        self.assertEqual(speech.select_language([("pl", .8), ("ru", .15), ("kk", .05)]), "ru")
        self.assertEqual(speech.select_language([("tr", .7), ("ru", .1), ("kk", .2)]), "kk")
        with self.assertRaisesRegex(ValueError, "voice_unsupported"):
            speech.select_language([("en", 1)])

    def test_decoding_explicitly_uses_selected_language_without_translation(self):
        for language, text in [("ru", "Здравствуйте, мне нужен сайт."), ("kk", "Сәлеметсіз бе, маған сайт керек.")]:
            with patch.object(speech, "decode_audio", return_value="audio"), patch("faster_whisper.WhisperModel") as factory:
                model = factory.return_value
                model.detect_language.return_value = ("pl", .8, [("pl", .8), (language, .2)])
                model.transcribe.return_value = ([SimpleNamespace(text=text)], None)
                self.assertEqual(speech.transcribe(b"recording", "local-model"), text)
                self.assertEqual(model.transcribe.call_args.kwargs["language"], language)
                self.assertEqual(model.transcribe.call_args.kwargs["task"], "transcribe")

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
        with patch.object(speech.sys, "argv", ["worker", "/missing-model"]), patch.object(speech, "available_memory", return_value=1024), patch.object(speech, "transcribe") as transcribe:
            self.assertEqual(speech.main(), {"error": "voice_resources"})
            transcribe.assert_not_called()

    def test_tiny_profile_lowers_memory_but_legacy_models_keep_their_guard(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.assertEqual(speech.required_available(root), 2048 * 1024**2)
            (root / "model.bin").write_bytes(b"fixture")
            (root / "basqar-profile.json").write_text(json.dumps({"profile": "tiny"}))
            self.assertEqual(speech.required_available(root), 768 * 1024**2)
            with patch.object(speech.sys, "argv", ["worker", directory]), patch.object(speech, "available_memory", return_value=512 * 1024**2), patch.object(speech, "transcribe") as transcribe:
                self.assertEqual(speech.main(), {"error": "voice_resources"})
                transcribe.assert_not_called()
            # A larger custom model must not use the lightweight safety threshold.
            with (root / "model.bin").open("wb") as file:
                file.truncate(101 * 1024**2)
            with self.assertRaisesRegex(ValueError, "voice_service_config"):
                speech.required_available(root)

    def test_kaz_rus_turbo_profile_reserves_memory_and_rejects_bad_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "model.bin").write_bytes(b"fixture")
            (root / "basqar-profile.json").write_text(json.dumps({"profile": "kaz-rus-turbo"}))
            self.assertEqual(speech.required_available(root), 4096 * 1024**2)
            for value in [{"profile": "unknown"}, {"profile": "kaz-rus-turbo", "memory": 1}, []]:
                (root / "basqar-profile.json").write_text(json.dumps(value))
                with self.assertRaisesRegex(ValueError, "voice_service_config"):
                    speech.required_available(root)

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
