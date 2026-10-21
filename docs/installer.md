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
