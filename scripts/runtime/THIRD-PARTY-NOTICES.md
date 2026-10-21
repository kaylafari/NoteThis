# Bundled runtime notices

NoteThis invokes these programs as separate processes. It does not bundle model weights, user accounts, API keys, Homebrew, or a system Python installation.

- **CPython 3.12.14**, Python Software Foundation License and included third-party notices. Built by Astral's python-build-standalone release `20260901`. Upstream licenses remain in the Python distribution. Source and build scripts: https://github.com/astral-sh/python-build-standalone/tree/20260901 and https://www.python.org/downloads/release/python-31214/.
- **faster-whisper 1.2.1**, MIT License, with exact transitive wheel versions/hashes in `manifest.json`. Each wheel's original `.dist-info` license files remain installed. Sources: https://github.com/SYSTRAN/faster-whisper/tree/v1.2.1 and the project URLs in each installed package's metadata. PyAV contains its own FFmpeg libraries and notices; these are retained in the wheel installation.
- **Ollama 0.22.0**, MIT License. The unmodified official Darwin distribution includes its native libraries; `licenses/ollama-license.txt` contains the top-level license. Source and third-party components: https://github.com/ollama/ollama/tree/v0.22.0.
- **FFmpeg and FFprobe 8.0.1**, LGPL 2.1 or later. Built from the unmodified official source with GPL, nonfree components, external library autodetection, and network protocols disabled. The full corresponding source archive, exact configure options, and a standalone rebuild script are shipped in `sources/`; original licenses are in `licenses/`. No additional third-party codec libraries are linked into these executables. This software includes work of the Independent JPEG Group; NoteThis has not modified the IJG-derived FFmpeg files. Source: https://ffmpeg.org/releases/ffmpeg-8.0.1.tar.xz. Its release signature was verified against the FFmpeg release signing key fingerprint `FCF986EA15E6E293A5644F10B4322F04D67658D8`, published at https://ffmpeg.org/ffmpeg-devel.asc.

The evaluated ffmpeg-static b6.1.1 Apple Silicon binaries were rejected: their actual build reports FFmpeg 6.0 with `--enable-nonfree`. They are not included in this runtime.

All archive and wheel download URLs and SHA256 digests are recorded in `manifest.json`. This file records upstream licensing; it does not replace the original license texts or assert that notarization completes license compliance.
