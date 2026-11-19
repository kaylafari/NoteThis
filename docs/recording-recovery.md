# Resuming after sleep or an audio interruption

If the microphone, system audio, or audio engine becomes unavailable, NoteThis
pauses and keeps the audio already captured in memory. Leave the window open.

- **Resume** tries to reopen disconnected or muted inputs and resume the audio
  engine. It keeps the existing recorder, so the earlier and later audio remain
  in one recording.
- **Automatically resume after an audio interruption** is on by default for each
  recording. Uncheck it to require Resume. Automatic recovery responds to wake,
  device changes, returning tracks, and the audio engine recovering. A deliberate
  Pause remains paused.
- If system-audio sharing ended, click **Resume** and approve sharing again if
  prompted. NoteThis does not open sharing pickers automatically.
- A denied permission leaves earlier audio intact. Retry Resume after restoring
  access, or choose **Finish recording** and save what was captured.
- If the encoder has failed or the audio engine has permanently closed, choose
  Finish recording and start a new recording. That terminal failure cannot be
  resumed safely in the same encoded file.

Nothing can capture audio while the computer is asleep. The resumed recording
does not recover that missing interval. These changes also do not recover an
unsaved recording after quitting the app or losing power.

## Verification

Unit and Chromium UI tests cover source replacement, permission denial and retry,
sleep/wake events, initially muted inputs, optional automatic recovery, explicit
Pause, duplicate Resume, and late responses after Finish/discard.

`node scripts/test-recorder-electron.mjs` uses generated tones with a real
Chromium audio graph and encoder. It disconnects a source, reconnects a different
tone, decodes the saved recording with FFmpeg, and checks for the original and
replacement signals. No microphone or screen is captured by this test.

Physical lid-close and wake behavior still requires a manual check on the target
Mac: record known audio, sleep/wake, approve renewed sharing if requested, resume,
save, and verify audible content before and after the interruption. Do not use a
critical meeting as the first hardware check.
