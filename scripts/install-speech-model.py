"""Build-time download only. Runtime recognition is offline."""
import sys
import json
from pathlib import Path
from huggingface_hub import snapshot_download

snapshot_download(
    repo_id="Systran/faster-whisper-tiny",
    revision="d90ca5fe260221311c53c58e660288d3deb8d356",
    local_dir=sys.argv[1],
    allow_patterns=["model.bin", "config.json", "tokenizer.json", "vocabulary.txt"],
)
# Written only after the pinned download completes. Older unmarked models keep
# their original memory requirement instead of silently adopting the tiny limit.
Path(sys.argv[1], "basqar-profile.json").write_text(json.dumps({"profile": "tiny"}))
