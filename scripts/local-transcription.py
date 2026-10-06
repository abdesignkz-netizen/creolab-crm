"""Offline, bounded audio -> text worker. stdout is a single safe JSON response."""
import fcntl
import io
import json
import os
import sys
from pathlib import PurePosixPath

MAX_BYTES = 16 * 1024 * 1024
MAX_SECONDS = 120
# Small/int8 requires roughly 1.5 GiB for inference; leave additional headroom.
REQUIRED_AVAILABLE = 2 * 1024**3


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
            limits.append(max(0, ceiling - used))
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


def transcribe(data, model_path):
    # No model is downloaded during a customer request.
    from faster_whisper import WhisperModel
    audio = decode_audio(data)
    model = WhisperModel(model_path, device="cpu", compute_type="int8", cpu_threads=2,
                         num_workers=1, local_files_only=True)
    segments, _ = model.transcribe(audio, beam_size=5, task="transcribe", vad_filter=True,
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
        if remaining is None or remaining < REQUIRED_AVAILABLE:
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
        result = {"error": code if code in {"voice_too_long", "voice_unsupported", "voice_empty"} else "voice_unsupported"}
    except Exception:
        result = {"error": "voice_local_failed"}
    print(json.dumps(result, ensure_ascii=True))
