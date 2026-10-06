"""Offline, bounded audio -> text worker. stdout is a single safe JSON response."""
import fcntl
import io
import json
import os
import subprocess
import struct
import sys
import threading
from pathlib import Path, PurePosixPath

MAX_BYTES = 16 * 1024 * 1024
MAX_SECONDS = 120
NATIVE_TIMEOUT_SECONDS = 300
# Profiles keep engine-specific headroom. An old installation cannot silently
# inherit the smaller native-Q5 budget just by updating the worker.
def model_profile(model_path):
    root = Path(model_path)
    try:
        profile = json.loads((root / "basqar-profile.json").read_text())
    except FileNotFoundError:
        return None
    except (ValueError, OSError):
        raise ValueError("voice_service_config")
    profiles = {"tiny", "kaz-rus-turbo", "kaz-rus-turbo-q5"}
    name = profile.get("profile") if isinstance(profile, dict) else None
    if not isinstance(name, str) or name not in profiles or profile != {"profile": name}:
        raise ValueError("voice_service_config")
    return name


def required_available(model_path):
    root = Path(model_path)
    name = model_profile(root)
    if name is None:
        return 2 * 1024**3
    profiles = {"tiny": (100, 768), "kaz-rus-turbo": (1600, 4096), "kaz-rus-turbo-q5": (700, 1408)}
    max_model_mib, available_mib = profiles[name]
    if not 0 < (root / "model.bin").stat().st_size <= max_model_mib * 1024**2:
        raise ValueError("voice_service_config")
    return available_mib * 1024**2


def available_memory():
    limits = []
    try:
        with open("/proc/meminfo") as source:
            for line in source:
                if line.startswith("MemAvailable:"):
                    limits.append(int(line.split()[1]) * 1024)
    except OSError:
        pass
    groups = [
        ("/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory.current"),
        ("/sys/fs/cgroup/memory/memory.limit_in_bytes", "/sys/fs/cgroup/memory/memory.usage_in_bytes"),
    ]
    # Also honour a systemd service's nested limit and any parent limits on PS.kz.
    try:
        with open("/proc/self/cgroup") as source:
            for line in source:
                _, controllers, relative = line.strip().split(":", 2)
                path = PurePosixPath(relative)
                if ".." in path.parts:
                    continue
                for parent in [path, *path.parents]:
                    suffix = str(parent).lstrip("/")
                    if not controllers:
                        root = "/sys/fs/cgroup/" + suffix
                        groups.append((root + "/memory.max", root + "/memory.current"))
                    elif "memory" in controllers.split(","):
                        root = "/sys/fs/cgroup/memory/" + suffix
                        groups.append((root + "/memory.limit_in_bytes", root + "/memory.usage_in_bytes"))
    except (OSError, ValueError):
        pass
    for maximum, current in groups:
        try:
            with open(maximum) as source:
                ceiling = int(source.read().strip())
            with open(current) as source:
                used = int(source.read().strip())
            # memory.current includes the model's file cache after a previous
            # request. Count only clean inactive file pages as reclaimable, never
            # anonymous process memory, tmpfs, dirty pages or active file pages.
            # Missing/malformed stats retain the conservative raw-usage check.
            reclaimable = 0
            try:
                with open(str(PurePosixPath(current).parent / "memory.stat")) as source:
                    stats = dict(line.split() for line in source if line.strip())
                keys = ("inactive_file", "file_dirty", "file_writeback", "shmem") if maximum.endswith("memory.max") else (
                    "total_inactive_file", "total_dirty", "total_writeback", "total_shmem")
                inactive, dirty, writeback, shared = [int(stats[key]) for key in keys]
                if min(inactive, dirty, writeback, shared) >= 0:
                    reclaimable = min(used, max(0, inactive - dirty - writeback - shared))
            except (OSError, ValueError, KeyError):
                pass
            limits.append(max(0, ceiling - used + reclaimable))
        except (OSError, ValueError):
            pass
    # Production runs on Linux. Unknown capacity must not silently bypass the guard.
    return min(limits) if limits else None


def decode_audio(data):
    import av
    import numpy as np
    pieces, count = [], 0
    resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
    # Only audio containers we accept; playlists must not fetch URLs or local files.
    with av.open(io.BytesIO(data), mode="r", options={
        "protocol_whitelist": "pipe", "format_whitelist": "ogg,mp3,mov,wav,flac,matroska,webm",
    }) as container:
        if not container.streams.audio:
            raise ValueError("voice_unsupported")
        for frame in container.decode(audio=0):
            for sample in resampler.resample(frame):
                count += sample.samples
                if count > MAX_SECONDS * 16000:
                    raise ValueError("voice_too_long")
                pieces.append(sample.to_ndarray().reshape(-1))
        for sample in resampler.resample(None):
            count += sample.samples
            if count > MAX_SECONDS * 16000:
                raise ValueError("voice_too_long")
            pieces.append(sample.to_ndarray().reshape(-1))
    if not pieces:
        raise ValueError("voice_empty")
    return np.concatenate(pieces).astype(np.float32) / 32768.0


def select_language(probabilities):
    # Restrict language selection before decoding; never decode as Polish/etc.
    supported = [(language, probability) for language, probability in probabilities
                 if language in ("ru", "kk")]
    if not supported:
        raise ValueError("voice_unsupported")
    return max(supported, key=lambda item: item[1])[0]


def transcribe_native(audio, model_path):
    root = Path(model_path)
    executable = root / "speech-runner"
    if not executable.is_file() or not os.access(executable, os.X_OK):
        raise ValueError("voice_local_missing")
    from faster_whisper.vad import get_speech_timestamps, VadOptions
    # Bound each decoding window and split at pauses, not at Whisper-generated
    # timestamps (fine-tuned voice-note models can omit/repeat long segments).
    spans = get_speech_timestamps(audio, VadOptions(min_silence_duration_ms=500,
        speech_pad_ms=500, max_speech_duration_s=25))
    if not spans:
        raise ValueError("voice_empty")
    # Keep a short lead-in/tail: quiet opening consonants can precede VAD speech.
    if spans[0]["start"] < 16000:
        spans[0]["start"] = 0
    if len(audio) - spans[-1]["end"] < 16000:
        spans[-1]["end"] = len(audio)
    payload = bytearray(struct.pack("<I", len(spans)))
    for span in spans:
        chunk = audio[span["start"]:span["end"]]
        payload.extend(struct.pack("<I", len(chunk)))
        payload.extend(chunk.astype("<f4", copy=False).tobytes())
    # Native output is bounded at 48 KB. Audio remains in memory, never on disk.
    child = subprocess.Popen([str(executable.resolve()), str((root / "model.bin").resolve())],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    stopped, low_memory = threading.Event(), threading.Event()

    def watch_memory():
        while not stopped.wait(.1):
            remaining = available_memory()
            if remaining is not None and remaining < 128 * 1024**2:
                low_memory.set()
                try:
                    child.kill()
                except ProcessLookupError:
                    pass
                return

    monitor = threading.Thread(target=watch_memory, daemon=True)
    monitor.start()
    try:
        output, _ = child.communicate(payload, timeout=NATIVE_TIMEOUT_SECONDS)
        if low_memory.is_set():
            raise ValueError("voice_resources")
        try:
            result = json.loads(output)
        except (ValueError, UnicodeDecodeError):
            raise ValueError("voice_local_failed")
        if not isinstance(result, dict):
            raise ValueError("voice_local_failed")
        if result.get("error") in {"voice_empty", "voice_too_long", "voice_unsupported", "voice_resources", "voice_local_failed", "voice_service_config"}:
            raise ValueError(result["error"])
        if child.returncode != 0 or not isinstance(result.get("text"), str):
            raise ValueError("voice_local_failed")
        return result["text"].strip()
    except subprocess.TimeoutExpired:
        raise ValueError("voice_timeout")
    finally:
        stopped.set()
        monitor.join()
        if child.poll() is None:
            child.kill()
        child.communicate()


def transcribe(data, model_path):
    # No model is downloaded during a customer request.
    audio = decode_audio(data)
    if model_profile(model_path) == "kaz-rus-turbo-q5":
        text = transcribe_native(audio, model_path)
    else:
        from faster_whisper import WhisperModel
        model = WhisperModel(model_path, device="cpu", compute_type="int8", cpu_threads=2,
                         num_workers=1, local_files_only=True)
        _, _, probabilities = model.detect_language(audio=audio)
        language = select_language(probabilities)
        segments, _ = model.transcribe(audio, language=language, beam_size=5, task="transcribe", vad_filter=True,
                                    condition_on_previous_text=False)
        text = " ".join(segment.text.strip() for segment in segments).strip()
    if not text:
        raise ValueError("voice_empty")
    if len(text) > 12000:
        raise ValueError("voice_too_long")
    return text


def main():
    # Cross-process lock also covers API + worker sharing this host. Never queue models in RAM.
    lock = os.open("/tmp/basqar-speech.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {"error": "voice_pending"}
        remaining = available_memory()
        required = required_available(sys.argv[1])
        if remaining is None or remaining < required:
            return {"error": "voice_resources"}
        data = sys.stdin.buffer.read(MAX_BYTES + 1)
        if not data or len(data) > MAX_BYTES:
            return {"error": "voice_unsupported"}
        os.nice(10)
        return {"text": transcribe(data, sys.argv[1])}
    finally:
        os.close(lock)


if __name__ == "__main__":
    try:
        result = main()
    except ImportError:
        result = {"error": "voice_local_missing"}
    except MemoryError:
        result = {"error": "voice_resources"}
    except ValueError as error:
        code = str(error)
        result = {"error": code if code in {"voice_service_config", "voice_too_long", "voice_unsupported", "voice_empty", "voice_resources", "voice_local_missing", "voice_local_failed", "voice_timeout"} else "voice_unsupported"}
    except Exception:
        result = {"error": "voice_local_failed"}
    print(json.dumps(result, ensure_ascii=True))
