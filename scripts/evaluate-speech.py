"""Local smoke check, not a production entry point. Never sends audio off-host.
Usage: python scripts/evaluate-speech.py MODEL_DIR AUDIO [--reference TEXT_FILE]
Runs without the Linux memory guard; choose a suitably sized development host.
"""
import argparse
import importlib.util
import json
import re
import resource
import sys
import time
from pathlib import Path


def word_error_rate(expected, actual):
    def words(value):
        return re.sub(r"[^\w\s]", " ", value.lower()).split()
    reference, hypothesis = words(expected), words(actual)
    if not reference:
        raise ValueError("Reference must contain words")
    previous = list(range(len(hypothesis) + 1))
    for i, word in enumerate(reference, 1):
        current = [i]
        for j, other in enumerate(hypothesis, 1):
            current.append(min(current[-1] + 1, previous[j] + 1, previous[j - 1] + (word != other)))
        previous = current
    return round(previous[-1] / len(reference), 4)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("model")
    parser.add_argument("audio")
    parser.add_argument("--reference")
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location("speech", Path(__file__).with_name("local-transcription.py"))
    speech = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(speech)
    with Path(args.audio).open("rb") as source:
        data = source.read(speech.MAX_BYTES + 1)
    if not data or len(data) > speech.MAX_BYTES:
        raise ValueError("Audio must be between 1 byte and 16 MiB")
    started = time.monotonic()
    text = speech.transcribe(data, args.model)
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    child_rss = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
    unit = 1024**2 if sys.platform == "darwin" else 1024
    result = {"text": text, "seconds": round(time.monotonic() - started, 2),
              "peakRssMiB": round(rss / unit, 1),
              "childPeakRssMiB": round(child_rss / unit, 1),
              "combinedPeakUpperBoundMiB": round((rss + child_rss) / unit, 1)}
    if args.reference:
        result["wordErrorRate"] = word_error_rate(Path(args.reference).read_text(), text)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
