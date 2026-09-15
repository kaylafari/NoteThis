# Verification record

Observed on September 14, 2026, on this Apple Silicon Mac running macOS 14.5. Synthetic speech and generated tones were used; no personal meeting was recorded or sent to a cloud provider.

## Completed checks

- At initial app delivery, all 54 tests passed across six files. TypeScript validation, production builds, and automated storage, API, provider, OAuth, recording, workspace-lock, and long-transcript tests pass. GitHub Actions runs typecheck, tests, and build for every pushed milestone.
- Real faster-whisper `base` CPU/int8 inference produced five segments and 60 timed words from a 20.921-second synthetic meeting. Local Python dependencies are installed in the project virtual environment.
- The real Ollama Qwen3 `0.6b` pipeline generated structured notes and answered a budget question. An initial invalid JSON shape led to adding schema-constrained generation. Owners and deadlines are retained only when found in the cited source segment. The real pipeline test checks the expected proposal task and a budget citation supported by the actual transcript.
- Browser walkthrough verified sample loading, transcript display, actual audio playback, moving word highlight, click-to-seek at 9.04 seconds, playback speed controls, action completion, and persistence after reload. Provider settings and browser sign-in controls render. The repository screenshot shows the working sample.
- A real Electron Web Audio/MediaRecorder test mixed independent 220 Hz and 440 Hz sources into Opus audio. FFmpeg decoded both tones, both source meters registered activity, pause/resume worked, and input tracks were released. The test requests no microphone or system permissions.
- A headerless WebM recording was decoded and its duration recovered. A 305-second synthetic upload was split into two provider-sized audio chunks with correctly offset mock transcription results.
- An Apple Silicon `NoteThis.app` bundle was created. Its ad-hoc signature passes `codesign --verify --deep --strict`; microphone and audio-capture usage descriptions are present. Python helper and sample assets are included outside the application archive.
- The packaged native process started with an isolated temporary profile and served its local API successfully. Native screenshot inspection stalled in the Computer Use tool; the renderer walkthrough was completed in the browser instead. No OS recording permission was requested during this check.
- Final packaged bundle/resource hashes match the final source build. The packaged launcher opened the actual NoteThis workspace with the ready synthetic sample. Native health reported FFmpeg, Python, Whisper, and Ollama available, and the configured Qwen3 model present. The built renderer returned HTTP 200.
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

## NoteThis rename and design — September 15, 2026

The app is now NoteThis, with an original closed calligraphy pen-cap icon and a white/gray interface with restrained brown-beige accents. The home screen, synthetic meeting transcript, recording dialog, and provider settings were visually checked in the browser. Existing layout and recording/model behavior were retained. The palette audit found no green-dominant colors; representative body, sidebar, warning, and primary-button text contrasts exceed 4.5:1.

All **243 tests across 17 files** and the production build pass. The native identity regression verifies the legacy startup name before Electron is ready, the NoteThis display name after readiness, unchanged data/session directories, and explicit temporary-profile support. The bundle identifier, data folder, and startup encryption identity remain stable; no credentials were read, migrated, or deleted. Live credential decryption was not exercised. Native fake-device tests retain finite timeouts sized for concurrent Electron startup.

Use `Launch NoteThis.command`; existing `Launch Cadence.command` shortcuts forward to it. Quit an older running instance before opening the new app. The project/repository path remains AIMeetingNotes; existing storage and logs retain their Cadence directory names.


## Optional web research and summary diagrams — September 15, 2026

NoteThis 0.3.0 adds separate default-off settings for web search in meeting questions and useful summary diagrams. Each setting identifies the provider, model, and outgoing data; consent is bound to the provider and resets when changing providers. The API, persisted settings, and transport paths enforce these bindings. Account/local model metadata must explicitly report the relevant capability, and NoteThis must implement its provider transport.

All **318 tests across 19 files** pass, including 52 mocked rich-provider transport tests and real Chromium settings/display checks. Coverage includes feature availability, missing/revoked capabilities, off-state and missing-consent prevention of network calls, Responses streaming, OpenRouter citations, bounded raster validation, exact transcript evidence for diagram plans, long-transcript input limits, image persistence/removal, portable Markdown export, and preserving notes after image errors. Web citations remain separate from timestamp references; generated diagrams have captions, labels, downloads, and nonfatal error notices.

The production build and Apple Silicon packaging pass. The ad-hoc app signature verifies with `codesign --verify --deep --strict`, and all five packaged frontend/backend build files exactly match the current build. The new provider tests use synthetic responses only: no private transcript was sent to a cloud provider, no live web/image generation was billed, and account-specific quota or execution remains unverified.
