# Verification record

Observed on September 14, 2026, on this Apple Silicon Mac running macOS 14.5. Synthetic speech and generated tones were used; no personal meeting was recorded or sent to a cloud provider.

## Completed checks

- All 54 tests pass across six files. TypeScript validation, production builds, and automated storage, API, provider, OAuth, recording, workspace-lock, and long-transcript tests pass. GitHub Actions runs typecheck, tests, and build for every pushed milestone.
- Real faster-whisper `base` CPU/int8 inference produced five segments and 60 timed words from a 20.921-second synthetic meeting. Local Python dependencies are installed in the project virtual environment.
- The real Ollama Qwen3 `0.6b` pipeline generated structured notes and answered a budget question. An initial invalid JSON shape led to adding schema-constrained generation. Owners and deadlines are retained only when found in the cited source segment. The real pipeline test checks the expected proposal task and a budget citation supported by the actual transcript.
- Browser walkthrough verified sample loading, transcript display, actual audio playback, moving word highlight, click-to-seek at 9.04 seconds, playback speed controls, action completion, and persistence after reload. Provider settings and browser sign-in controls render. The repository screenshot shows the working sample.
- A real Electron Web Audio/MediaRecorder test mixed independent 220 Hz and 440 Hz sources into Opus audio. FFmpeg decoded both tones, both source meters registered activity, pause/resume worked, and input tracks were released. The test requests no microphone or system permissions.
- A headerless WebM recording was decoded and its duration recovered. A 305-second synthetic upload was split into two provider-sized audio chunks with correctly offset mock transcription results.
- An Apple Silicon `Cadence.app` bundle was created. Its ad-hoc signature passes `codesign --verify --deep --strict`; microphone and audio-capture usage descriptions are present. Python helper and sample assets are included outside the application archive.
- The packaged native process started with an isolated temporary profile and served its local API successfully. Native screenshot inspection stalled in the Computer Use tool; the renderer walkthrough was completed in the browser instead. No OS recording permission was requested during this check.
- Production dependency audit reported zero known vulnerabilities at verification time.
- Private GitHub repository created. Implementation milestones were committed and pushed sequentially; generated models, recordings, credentials, and runtime binaries are excluded from Git.

## Deliberate verification boundaries

Actual microphone and computer-wide loopback capture still require granting macOS permissions and checking both live meters on the user's device. Synthetic encoder tests do not establish real hardware permission behavior. External API providers are contract-tested with mocked responses; no paid API calls or third-party subscription sign-ins were completed.

The compact default model can omit details or produce imperfect notes; the synthetic test still placed a postponement decision among action items. Source IDs and exact owner/deadline text are checked, but that does not prove every generated claim is correct. A larger local or cloud model can improve quality. Very long transcript processing is covered by input-budget and reduction tests; an hours-long real recording was not processed in this run. The local app is ad-hoc signed and is not notarized for redistribution.
