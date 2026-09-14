#!/usr/bin/env python3
"""Local faster-whisper bridge. JSON on stdout; bounded progress only on stderr."""
import argparse
import json
import os
import sys

# Public model downloads do not require another application's Hugging Face token.
os.environ.setdefault("HF_HUB_DISABLE_IMPLICIT_TOKEN", "1")
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("audio")
    parser.add_argument("--model", default="base")
    parser.add_argument("--language", default="")
    args = parser.parse_args()
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("Install local transcription: .venv/bin/python -m pip install -r requirements.txt", file=sys.stderr)
        return 2
    import av
    import numpy as np
    # Decode with a protocol allowlist so uploaded playlists cannot fetch URLs.
    samples = []
    resampler = av.audio.resampler.AudioResampler(format="s16", layout="mono", rate=16000)
    with av.open(args.audio, options={"protocol_whitelist": "file,pipe", "format_whitelist": "wav,mp3,mov,matroska,webm,ogg,flac,aac,mpeg,aiff"}) as container:
        for frame in container.decode(audio=0):
            frame.pts = None
            for converted in resampler.resample(frame):
                samples.append(converted.to_ndarray().flatten())
        for converted in resampler.resample(None):
            samples.append(converted.to_ndarray().flatten())
    audio = np.concatenate(samples).astype(np.float32) / 32768.0 if samples else np.empty(0, dtype=np.float32)
    if audio.size == 0:
        raise ValueError("Empty audio")
    del samples
    print("Loading Whisper model (first run downloads model weights)…", file=sys.stderr, flush=True)
    # CPU/int8 is portable on macOS; CTranslate2 does not use Apple's Metal backend.
    model = WhisperModel(args.model, device="cpu", compute_type="int8", cpu_threads=min(os.cpu_count() or 4, 8))
    segments, info = model.transcribe(audio, language=args.language or None, beam_size=5,
                                      word_timestamps=True, vad_filter=True, condition_on_previous_text=False)
    result = []
    for segment in segments:
        words = [{"text": w.word.strip(), "start": w.start, "end": w.end} for w in segment.words or [] if w.word.strip()]
        if segment.text.strip():
            result.append({"id": f"seg-{len(result)}", "start": segment.start, "end": segment.end,
                           "text": segment.text.strip(), "words": words})
        print(f"Transcribed {segment.end:.0f} of {info.duration:.0f} seconds", file=sys.stderr, flush=True)
    json.dump({"segments": result, "duration": info.duration, "timing": "word"}, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        # Don't print input paths, model URLs, or credentials from third-party exceptions.
        print(f"Local transcription failed ({type(exc).__name__}). Check the audio file, available disk space, and model download connectivity.", file=sys.stderr)
        raise SystemExit(1)
