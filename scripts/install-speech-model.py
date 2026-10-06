"""Build-time pinned model installation. No remote code or pickle weights loaded."""
import gc
import json
import os
import sys
import tempfile
from pathlib import Path
from huggingface_hub import snapshot_download

BASE_REVISION = "92847d02bbdb4311e4c85d9d3b4c7f82e31e59bf"
ADAPTER_REVISION = "904d5d22339952909001d1abcbc1ecf29d26d706"


def install(output, profile="kaz-rus-turbo"):
    output = Path(output)
    if output.exists() and any(output.iterdir()):
        raise ValueError("Use an empty model directory; never overwrite the active model")
    output.parent.mkdir(parents=True, exist_ok=True)
    if profile == "tiny":
        snapshot_download(repo_id="Systran/faster-whisper-tiny",
                          revision="d90ca5fe260221311c53c58e660288d3deb8d356", local_dir=str(output),
                          allow_patterns=["model.bin", "config.json", "tokenizer.json", "vocabulary.txt"])
    elif profile == "kaz-rus-turbo":
        import torch
        from transformers import WhisperForConditionalGeneration, WhisperProcessor, WhisperTokenizerFast
        from peft import PeftModel
        from ctranslate2.converters import TransformersConverter
        torch.set_num_threads(2)
        with tempfile.TemporaryDirectory(prefix="basqar-speech-build-") as temporary:
            root = Path(temporary)
            # Optional durable download cache for interrupted, multi-GB builds.
            source_root = Path(os.environ["BASQAR_SPEECH_BUILD_CACHE"]) if os.environ.get("BASQAR_SPEECH_BUILD_CACHE") else root
            base = snapshot_download(repo_id="abilmansplus/whisper-turbo-ksc2", revision=BASE_REVISION,
                                     local_dir=str(source_root / "base"), allow_patterns=["*.json", "*.txt", "*.safetensors"])
            adapter = snapshot_download(repo_id="abilmansplus/whisper-turbo-kaz-rus-v1", revision=ADAPTER_REVISION,
                                        local_dir=str(source_root / "adapter"), allow_patterns=["adapter_config.json", "adapter_model.safetensors", "tokenizer*.json", "*.txt", "vocab.json", "merges.txt", "special_tokens_map.json", "added_tokens.json", "normalizer.json"])
            model = WhisperForConditionalGeneration.from_pretrained(base, local_files_only=True,
                        use_safetensors=True, torch_dtype=torch.float32, low_cpu_mem_usage=True)
            model = PeftModel.from_pretrained(model, adapter, local_files_only=True).merge_and_unload()
            merged = root / "merged"
            model.save_pretrained(merged, safe_serialization=True)
            WhisperProcessor.from_pretrained(base, local_files_only=True).save_pretrained(merged)
            WhisperTokenizerFast.from_pretrained(adapter, local_files_only=True).save_pretrained(merged)
            del model
            gc.collect()
            TransformersConverter(str(merged), copy_files=["tokenizer.json", "preprocessor_config.json"],
                                  load_as_float16=False).convert(str(output), quantization="int8")
    else:
        raise ValueError("Unsupported speech model profile")
    # Marker only after successful installation; failed builds cannot look ready.
    (output / "basqar-profile.json").write_text(json.dumps({"profile": profile}))


if __name__ == "__main__":
    install(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "kaz-rus-turbo")
