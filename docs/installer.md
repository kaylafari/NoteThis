# Downloadable Mac installer

NoteThis's Apple Silicon DMG installs by dragging NoteThis to Applications. It includes the Python interpreter and faster-whisper dependencies, FFmpeg and FFprobe, and a private Ollama runtime. It does not copy the developer's account, API keys, recordings, model cache, or preferences.

The first launch opens a guide. **Prepare local AI** downloads Whisper base and Qwen3:0.6b into the current user's application-data directory. The guide also explains connecting the user's own ChatGPT account. Recommendations cover only the customized choices: ChatGPT subscription, GPT-6.1 Sol if the account currently lists it, and optional web search where supported. Users explicitly authorize web search; no account or sharing consent is copied from the developer.

Help remains available in Settings after AI models and Local setup. The default local runtime is managed by NoteThis; an already-running Ollama service is reused and is never shut down by NoteThis. Explicit custom Python and server settings remain supported.

## Updating

From 0.5.5, Settings → Updates checks the latest stable public GitHub release. Checks also run 15 seconds after startup and every six hours; downloads require a click. The native Electron/Squirrel updater validates the signed ZIP against the running app, replaces the app and relaunches it on Restart to update (or applies a downloaded update on the next app launch). Recording, unsaved settings, active uploads, processing and local model setup block an update restart. Main-process IPC accepts requests only from the app's main frame.

Users on 0.5.4 or older install 0.5.5 manually once. Manual fallback: quit NoteThis after saving any recording, download the latest DMG, drag NoteThis to Applications, and choose Replace. Launch the replacement from Applications, then eject the DMG. The bundle identifier, signing identity, legacy Keychain name, and application-data location remain stable across releases. Replacing the app does not delete recordings, preferences, provider credentials, or downloaded models. Do not remove the application-data folder or use an app-cleaner tool.

See the [plain-language update steps](../README.md#updating-an-existing-installation).

## Build

On an Apple Silicon Mac:

```sh
npm ci
npm run setup:signing # once; preserve this local identity for later updates
npm run installer
```

The build downloads pinned dependency archives and Python wheels, verifies SHA-256 hashes, assembles a relocatable runtime, builds the app, signs native code with the saved local certificate, creates a DMG, signs the DMG, and writes its SHA-256 checksum. Runtime sources and locks are in `scripts/runtime`; generated bundles and caches are excluded from Git. The DMG and signed-app ZIP, each with a SHA-256 file, are written to `release/installer/`.

Publish the DMG, ZIP, and both checksum files to the same stable `vX.Y.Z` GitHub release. Upload every file to a draft first, compare GitHub asset digests with local hashes, then publish it as latest. Assets must retain the exact `NoteThis-X.Y.Z-mac-arm64` names. The ZIP contains the same signed app as the DMG; do not alter it after signing. Never rotate the saved signing identity during an update. Drafts, prereleases, older versions, unverified ZIP metadata, and unexpected asset URLs are excluded. A DMG-only release exposes the manual fallback.

The updater uses GitHub's public API without a token and sends no meeting data. Network/rate-limit errors are visible and retryable. There is no custom privileged replacement helper and no disabling of code-signature validation.

The installer and app are **locally signed, not Apple-notarized**. This is not App Store distribution. macOS may require the user to choose Open Anyway in Privacy & Security. No script disables Gatekeeper, clears quarantine, grants recording access, or changes global privacy settings. A Developer ID certificate and notarization would be needed to remove the unidentified-developer barrier for public downloads.

Microphone and system-audio permissions always require the user's system approval. Preparing local models does not start recording or send a transcript to a cloud service.

## Updater validation

On this Mac, an isolated app signed with the saved certificate updated from 1.0.0 to 1.0.1, replaced the original bundle on disk and relaunched. A second test changed a sealed resource after signing: native signature verification rejected it and kept 1.0.0. Reproduce these macOS-only acceptance checks with `node scripts/test-native-updater.mjs` and `node scripts/test-native-updater.mjs --tamper`; they use disposable app identifiers and profiles and retain their scratch directories for inspection.

Automated regressions cover release/asset validation, network/native errors, duplicate operations, busy-state blocking, private feed responses, canceled native window close, and asynchronous mutations that continue after client disconnection. These are distinct from actual user recording/model-quality checks and Gatekeeper behavior on a different Mac.

## Validation for 0.5.0

On an Apple Silicon Mac running macOS 14.5:

- 408 automated tests passed, including onboarding persistence, setup retry/cancellation, permission handling, and provider behavior; TypeScript and the production build passed.
- The runtime was relocated to a path containing spaces. Python imports, 122 native-library linkage checks, and WAV/AIFF/M4A/MP3/WebM/OGG/FLAC decoding passed with a minimal system PATH.
- An isolated launch of the signed app showed the welcome guide and reported healthy bundled Python, Whisper, and audio tools.
- Public Whisper and Qwen model downloads were tested in temporary profiles. After an interrupted test, the complete downloaded model caches were reused for the resumed integration check. The bundled runtime transcribed the synthetic 20.92-second sample into 5 segments/60 timed words, generated actions, answered the $5,000 budget question with its supporting transcript citation, and served ranged audio playback.
- Isolated Ollama service startup and shutdown passed. Initial GPU discovery fell back to CPU on this machine; setup allows 120 seconds for first startup. The small Qwen model answered the transcript fact correctly but failed a separate arithmetic check. This validates runtime operation, not general model accuracy.

These checks do not replace first-launch Gatekeeper and recording-permission approval on another user's Mac. No live call or private recording was used for installer validation.
