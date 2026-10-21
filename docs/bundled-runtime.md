# Apple Silicon bundled runtime

`node scripts/prepare-runtime.mjs` prepares `build/runtime` for the macOS app's `Contents/Resources/runtime` directory. Build it on Apple Silicon with Node and Apple's Xcode command-line tools. The installed app requires macOS 14.2 or newer; its runtime does not require Homebrew, a system Python, or a separately installed Ollama.

The build pins CPython 3.12.14 from Astral's `20260901` standalone release, faster-whisper 1.2.1 and all 23 wheel dependencies, Ollama 0.22.0, and FFmpeg 8.0.1. `scripts/runtime/sources.json` and `python-wheels.json` record exact URLs and SHA256 digests. Every download, including a cached file, is hash checked before use. Python installation is offline using `pip --require-hashes --no-index`; dependency resolution is not part of an ordinary build.

Executable paths inside the runtime are:

- `python/bin/python3.12` (invoke scripts or `-m` modules, not build-time console-script shebangs)
- `bin/ffmpeg`
- `bin/ffprobe`
- `ollama/ollama`, with its adjacent native libraries preserved

FFmpeg is compiled from the official source with Apple clang, static internal libraries, only audio codecs/containers needed by the app, file/pipe protocols, and no external library autodetection. GPL, nonfree, network, and shared-library builds are disabled. The archive, license, complete configure flags, and `rebuild-ffmpeg.sh` ship with the runtime. The originally considered ffmpeg-static arm64 asset was rejected because its actual configuration enabled nonfree components. No such binary is shipped.

The preparer moves the completed runtime to a different directory containing a space, then imports faster_whisper, PyAV, CTranslate2, and ONNXRuntime with `python -I -B`, and runs the executable version checks under `PATH=/usr/bin:/bin`. It writes `verification.json` before promoting the tree to `build/runtime`. Python bytecode caches and absolute-path console wrappers are removed; original package licenses and metadata remain. Signing must cover Mach-O files, not binary data such as ONNX assets.

Whisper transcription and Ollama language-model weights are downloaded separately. The faster-whisper package retains its built-in voice-activity detection asset. First-run model installation belongs to the app's writable user-data directory; it must not modify this signed runtime. User credentials and existing `.venv`, Homebrew, or `.local` executables are never copied. The wheel versions were selected to match the already-tested environment, but their bytes are independently downloaded from their pinned public distributions.

To update a component, review its release provenance and licensing, update the source/wheel manifests, rebuild, repeat relocation and decoding tests, then build/sign the app. The FFmpeg release signature used for the initial pin was verified with the publisher key fingerprint recorded in the source manifest. Changing dependency pins is a reviewed source change; downloading current unpinned dependencies is not a supported installer step.
