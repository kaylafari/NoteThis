# Recording calls with Cadence

Use the desktop app to capture audio playing through your computer and your microphone together. Choose **System + microphone**, start recording, and grant the operating system permissions. Use headphones when possible to avoid the microphone picking up the same call audio a second time. Cadence mixes the two inputs into one audio file; the screen image is never saved.

The two input meters show microphone and system levels separately. Speak to check the microphone, then play audio from the call to check the system meter before continuing. A silent call naturally produces a zero system level. Cadence rejects missing or already-ended system tracks and pauses if an audio source disconnects. Save the captured portion before starting again.

Pause excludes the paused interval from the saved audio and duration. Stop/save creates an audio file and uploads it to the local application server for transcription. Recordings are retained in memory until saved; save long meetings regularly and keep the app open until the upload completes. Closing with unsaved audio prompts before discarding it. Upload existing audio when recording a live call is unnecessary. Obtain the participants' consent as appropriate before starting a recording.

## macOS permissions

On macOS 14.2 and later, current Electron uses Apple's Core Audio Tap API. A packaged Cadence app includes `NSAudioCaptureUsageDescription` and `NSMicrophoneUsageDescription` in its Info.plist. Grant Cadence access under **System Settings → Privacy & Security → Microphone** and **Screen & System Audio Recording** (wording depends on macOS version). Restart the app if you changed access while it was running.

Launching with `npm run desktop` runs Electron from your terminal. macOS can attribute the system-audio permission to that terminal or IDE, which then needs the permission and usage-description key itself. For the most reliable permission experience, run `npm run package` and open **Cadence.app** in the `release` directory. Electron can return an ended or silent audio track when macOS permission is missing, so confirm actual activity on the system meter while another app is playing audio.

The old `MacCatapLoopbackAudioForScreenShare` override is deliberately unused: modern Electron uses Core Audio Tap and future Chromium versions remove the override. macOS 12 and older lack the required native capture path. macOS 13 support depends on the Chromium capture implementation; macOS 14.2 or newer is recommended for this app. This repository builds an unsigned local application; distribution to other Macs requires Developer ID signing and notarization.

## Browser recording

A browser can capture the microphone. System capture depends on the browser's screen-sharing support. In Chrome, sharing a tab with **Share audio** enabled can work; it does not imply all computer audio is captured. If the selected source supplies no audio track, Cadence stops with an explicit error instead of silently producing a microphone-only recording. Use the desktop app for computer-wide call audio. Linux support depends on the audio session and Chromium; verify both meters before relying on a capture.

## Local models in the packaged app

The packaged app includes the transcription helper script, but it does not embed a Python interpreter, Whisper model weights, or an Ollama server. Follow the project README's local-model setup, then set the **Python executable** setting to the absolute path of that environment's interpreter (for example `/Users/you/Projects/AIMeetingNotes/.venv/bin/python`). A virtual environment created on one machine is not portable to another. Keep Ollama running when using an Ollama language model. Initial Whisper transcription may download the selected model; subsequent runs reuse its local cache.

## Capture implementation and validation boundary

The isolated Electron renderer calls `getDisplayMedia`; the main-process handler grants a screen source with Electron's `audio: 'loopback'`. The renderer obtains the microphone separately, routes only audio into a Web Audio mix, and records Opus/WebM where supported. It retains the mandatory screen-sharing track until capture stops, which avoids ending the underlying audio session early. No renderer access to filesystem or secrets is exposed. API credentials in the desktop app use Electron `safeStorage`; the app refuses to save them when the operating system credential store is unavailable.

Automated recorder tests verify source mixing, missing/ended system-track rejection, partial-failure cleanup, permission-prompt cancellation, source-disconnection handling, pause duration, and stop/save bytes. They use mocked media devices and do not prove real hardware or OS permission behavior. A complete manual acceptance check is: play sound in another app, confirm the system meter moves; speak, confirm the microphone meter moves; pause/resume; save; play the result and hear both sources; click transcript words to seek; close and reopen to check persistence.

References: [Electron desktop capture](https://www.electronjs.org/docs/latest/api/desktop-capturer), [current Electron capture source documentation](https://github.com/electron/electron/blob/main/docs/api/desktop-capturer.md), [Apple system audio usage description](https://developer.apple.com/documentation/bundleresources/information-property-list/nsaudiocaptureusagedescription).
