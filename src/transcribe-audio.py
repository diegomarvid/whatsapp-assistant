#!/usr/bin/env python3
import sys

backend, model_path, language, audio_path = sys.argv[1:]
# "auto" delegates language detection to Whisper itself.
language = None if language == "auto" else language

if backend == "mlx":
    import mlx_whisper
    result = mlx_whisper.transcribe(audio_path, path_or_hf_repo=model_path, language=language)
    print(result["text"].strip())
elif backend == "faster-whisper":
    from faster_whisper import WhisperModel
    model = WhisperModel(model_path, device="auto", compute_type="int8")
    segments, _ = model.transcribe(audio_path, language=language)
    print("".join(segment.text for segment in segments).strip())
else:
    raise SystemExit(f"Unknown transcription backend: {backend}")
