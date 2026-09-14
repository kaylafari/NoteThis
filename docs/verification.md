# Verification record

Observed on September 14, 2026, on this Apple Silicon Mac running macOS 14.5. Synthetic speech and generated tones were used; no personal meeting was recorded or sent to a cloud provider.

## Completed checks

- At initial app delivery, all 54 tests passed across six files. TypeScript validation, production builds, and automated storage, API, provider, OAuth, recording, workspace-lock, and long-transcript tests pass. GitHub Actions runs typecheck, tests, and build for every pushed milestone.
- Real faster-whisper `base` CPU/int8 inference produced five segments and 60 timed words from a 20.921-second synthetic meeting. Local Python dependencies are installed in the project virtual environment.
- The real Ollama Qwen3 `0.6b` pipeline generated structured notes and answered a budget question. An initial invalid JSON shape led to adding schema-constrained generation. Owners and deadlines are retained only when found in the cited source segment. The real pipeline test checks the expected proposal task and a budget citation supported by the actual transcript.
- Browser walkthrough verified sample loading, transcript display, actual audio playback, moving word highlight, click-to-seek at 9.04 seconds, playback speed controls, action completion, and persistence after reload. Provider settings and browser sign-in controls render. The repository screenshot shows the working sample.
- A real Electron Web Audio/MediaRecorder test mixed independent 220 Hz and 440 Hz sources into Opus audio. FFmpeg decoded both tones, both source meters registered activity, pause/resume worked, and input tracks were released. The test requests no microphone or system permissions.
- A headerless WebM recording was decoded and its duration recovered. A 305-second synthetic upload was split into two provider-sized audio chunks with correctly offset mock transcription results.
- An Apple Silicon `Cadence.app` bundle was created. Its ad-hoc signature passes `codesign --verify --deep --strict`; microphone and audio-capture usage descriptions are present. Python helper and sample assets are included outside the application archive.
- The packaged native process started with an isolated temporary profile and served its local API successfully. Native screenshot inspection stalled in the Computer Use tool; the renderer walkthrough was completed in the browser instead. No OS recording permission was requested during this check.
- Final packaged bundle/resource hashes match the final source build. The packaged launcher opened the actual Cadence workspace with the ready synthetic sample. Native health reported FFmpeg, Python, Whisper, and Ollama available, and the configured Qwen3 model present. The built renderer returned HTTP 200.
- Production dependency audit reported zero known vulnerabilities at verification time.
- Private GitHub repository created. Implementation milestones were committed and pushed sequentially; generated models, recordings, credentials, and runtime binaries are excluded from Git.

## Deliberate verification boundaries

Actual microphone and computer-wide loopback capture still require granting macOS permissions and checking both live meters on the user's device. Synthetic encoder tests do not establish real hardware permission behavior. External API providers are contract-tested with mocked responses; no paid API calls or third-party subscription sign-ins were completed.

The compact default model can omit details or produce imperfect notes; the synthetic test still placed a postponement decision among action items. Source IDs and exact owner/deadline text are checked, but that does not prove every generated claim is correct. A larger local or cloud model can improve quality. Very long transcript processing is covered by input-budget and reduction tests; an hours-long real recording was not processed in this run. The local app is ad-hoc signed and is not notarized for redistribution.


## Recording permission repair — September 14, 2026

Reproduced the premature denial in Electron 44: `getDisplayMedia({ video: true, audio: true })` emits a `media` permission request with `mediaTypes: []`. The old audio-only handler rejected it before the display-capture handler could ask macOS for access. The repaired policy allows that preliminary request only for the trusted application main frame; the display handler separately requires its exact frame, origin, active user gesture, and audio request. Camera requests remain denied.

Microphone requests now call the native macOS request API and await its result. Existing OS denials are not reset. The recording dialog identifies the pending source and only displays failure after the selected source request completes; errors include the applicable manual permission path. Browser/device failures and user cancellation are distinguished from an assumed OS denial.

The expanded renderer tests cover pending requests, retries, selected sources, partial cleanup, canceled prompts, missing devices, pause/resume, stop/save, and unsaved-recording guards. The real Chromium encoder test still decodes both generated source tones with active meters and stopped tracks. No live microphone or private call audio was captured by these checks; actual OS prompt acceptance and hardware recording remain a manual check.

Final repair validation: **193 tests passed across 15 files**, including the real Electron permission preflight regression and React recording UI tests. TypeScript validation and production build passed. The native regression uses fake devices and verifies two microphone requests, denied camera access, the empty display preflight reaching its handler, and clean display cancellation without an unhandled rejection.
