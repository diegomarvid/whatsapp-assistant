#!/usr/bin/env python3
import shutil
import subprocess
import sys

backend, model_path, language, audio_path = sys.argv[1:]
# "auto" delegates language detection to Whisper itself.
language = None if language == "auto" else language


def decode_with_ffmpeg(path):
    """16 kHz mono float32 samples, the input faster-whisper expects.

    faster-whisper's own decoder calls av.open(..., metadata_errors=...),
    which recent PyAV releases (verified with av 19.0.1 and faster-whisper
    1.2.1) reject. Decoding with ffmpeg keeps transcription independent of
    the PyAV version pip resolves."""
    import numpy as np

    raw = subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-i", path, "-f", "s16le", "-ac", "1", "-ar", "16000", "-"],
        check=True,
        stdout=subprocess.PIPE,
    ).stdout
    return np.frombuffer(raw, np.int16).astype(np.float32) / 32768.0


if backend == "mlx":
    import mlx_whisper
    result = mlx_whisper.transcribe(audio_path, path_or_hf_repo=model_path, language=language)
    print(result["text"].strip())
elif backend == "faster-whisper":
    from faster_whisper import WhisperModel
    model = WhisperModel(model_path, device="auto", compute_type="int8")
    audio = decode_with_ffmpeg(audio_path) if shutil.which("ffmpeg") else audio_path
    segments, _ = model.transcribe(audio, language=language)
    print("".join(segment.text for segment in segments).strip())
else:
    raise SystemExit(f"Unknown transcription backend: {backend}")
