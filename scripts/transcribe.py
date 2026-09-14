#!/usr/bin/env python3
"""Local faster-whisper bridge. JSON on stdout; bounded progress only on stderr."""
import argparse
import json
import os
import sys


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
    print("Loading Whisper model (first run downloads model weights)…", file=sys.stderr, flush=True)
    # CPU/int8 is portable on macOS; CTranslate2 does not use Apple's Metal backend.
    model = WhisperModel(args.model, device="cpu", compute_type="int8", cpu_threads=min(os.cpu_count() or 4, 8))
    segments, info = model.transcribe(args.audio, language=args.language or None, beam_size=5,
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
