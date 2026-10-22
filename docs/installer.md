# Downloadable Mac installer

NoteThis's Apple Silicon DMG installs by dragging NoteThis to Applications. It includes the Python interpreter and faster-whisper dependencies, FFmpeg and FFprobe, and a private Ollama runtime. It does not copy the developer's account, API keys, recordings, model cache, or preferences.

The first launch opens a guide. **Prepare local AI** downloads Whisper base and Qwen3:0.6b into the current user's application-data directory. The guide also explains connecting the user's own ChatGPT account. Recommendations cover only the customized choices: ChatGPT subscription, GPT-6.1 Sol if the account currently lists it, and optional web search where supported. Users explicitly authorize web search; no account or sharing consent is copied from the developer.

Help remains available in Settings after AI models and Local setup. The default local runtime is managed by NoteThis; an already-running Ollama service is reused and is never shut down by NoteThis. Explicit custom Python and server settings remain supported.

## Build

On an Apple Silicon Mac:

```sh
npm ci
npm run setup:signing # once; preserve this local identity for later updates
npm run installer
```

The build downloads pinned dependency archives and Python wheels, verifies SHA-256 hashes, assembles a relocatable runtime, builds the app, signs native code with the saved local certificate, creates a DMG, signs the DMG, and writes its SHA-256 checksum. Runtime sources and locks are in `scripts/runtime`; generated bundles and caches are excluded from Git. The artifact is written to `release/installer/`.

The installer and app are **locally signed, not Apple-notarized**. This is not App Store distribution. macOS may require the user to choose Open Anyway in Privacy & Security. No script disables Gatekeeper, clears quarantine, grants recording access, or changes global privacy settings. A Developer ID certificate and notarization would be needed to remove the unidentified-developer barrier for public downloads.

Microphone and system-audio permissions always require the user's system approval. Preparing local models does not start recording or send a transcript to a cloud service.

## Validation for 0.5.0

On an Apple Silicon Mac running macOS 14.5:

- 408 automated tests passed, including onboarding persistence, setup retry/cancellation, permission handling, and provider behavior; TypeScript and the production build passed.
- The runtime was relocated to a path containing spaces. Python imports, 122 native-library linkage checks, and WAV/AIFF/M4A/MP3/WebM/OGG/FLAC decoding passed with a minimal system PATH.
- An isolated launch of the signed app showed the welcome guide and reported healthy bundled Python, Whisper, and audio tools.
- Public Whisper and Qwen model downloads were tested in temporary profiles. After an interrupted test, the complete downloaded model caches were reused for the resumed integration check. The bundled runtime transcribed the synthetic 20.92-second sample into 5 segments/60 timed words, generated actions, answered the $5,000 budget question with its supporting transcript citation, and served ranged audio playback.
- Isolated Ollama service startup and shutdown passed. Initial GPU discovery fell back to CPU on this machine; setup allows 120 seconds for first startup. The small Qwen model answered the transcript fact correctly but failed a separate arithmetic check. This validates runtime operation, not general model accuracy.

These checks do not replace first-launch Gatekeeper and recording-permission approval on another user's Mac. No live call or private recording was used for installer validation.
