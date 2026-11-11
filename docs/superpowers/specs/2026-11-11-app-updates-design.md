# NoteThis in-app updates

The user authorized testing the smoother restart-to-update flow and shipping it if compatible with the current local signing identity; otherwise ship release notifications and installer download. Existing users install this version manually once. Keep recordings, models, preferences, Keychain identity, and bundle identifier unchanged.

## Approaches

1. Prefer Electron's native macOS/Squirrel updater, which validates the replacement against the installed application's signing requirement. Use a disposable signed-app replacement test to establish compatibility. This avoids a bespoke replacement helper and extra dependency.
2. If native installation cannot be validated, retain discovery and open the trusted DMG download so the user replaces the app manually.

Checks query only the public kaylafari/NoteThis GitHub latest release. Send no meeting content or credentials. Ignore prereleases, drafts, malformed versions, downgrades and unexpected asset URLs. Use fixed repository/asset names. Automatically check at startup and periodically, with a manual Check for updates button. Do not automatically download. Show available/downloaded/error states and a fallback installer link. Explain that a downloaded native update installs on restart/next app launch.

For native mode publish a signed ZIP in addition to the DMG. Supply a localhost-only, random-path feed to Squirrel using vetted release metadata. Keep native code-signature validation enabled. Allow Restart to update only after checking renderer readiness and server processing/setup state. UI state should conservatively block recording dialogs, active saves, unsaved settings and loading. Existing before-unload recording protection remains in force.

Settings gets an Updates tab after Help & tips. A compact main-window notification exposes available updates without interrupting a recording. No changes to model providers or recording functionality.

Validation: unit tests for discovery and state transitions; trusted IPC; busy/restart protection; renderer behavior; real same-certificate update and tampered-signature rejection; full test/build suite; signed packaged app and GitHub release readback. Do not claim a successful update from metadata or a download event alone: verify replacement on disk and relaunch.
