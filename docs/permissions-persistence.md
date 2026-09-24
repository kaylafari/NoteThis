# Remembering macOS permissions

For Keychain prompts, choose **Always Allow** to remember access for NoteThis. **Allow** approves only the current access, so it can prompt again next time. The saved encryption item may still be named **Cadence Safe Storage**, because NoteThis keeps its original encryption identity to preserve existing connections.

The first time you run the newly signed app, macOS may ask once more for Keychain and recording access. Approve the requested microphone and system-audio permissions. If needed, find NoteThis in **System Settings → Privacy & Security → Microphone** and **Screen & System Audio Recording** (wording varies by macOS version), then reopen the app. The app cannot make these system choices for you.

Use **Launch NoteThis.command** for normal use. It opens the packaged application. Development runs use a different executable and do not share all macOS grants with the packaged app.

## What changed

Earlier packages were ad-hoc signed: their macOS designated requirement contained a build-specific hash. Updates could therefore look like a different app to macOS. Packaging now requires a persistent local signing identity and uses the same certificate for future builds on this Mac. The bundle identifier and the existing Cadence data and encryption identities are retained.

Saved provider credentials on macOS now use Electron's asynchronous encryption provider, shared with its browser storage, instead of initializing an additional synchronous keychain cache. Existing encrypted credentials remain compatible; there is no key reset or credential migration. Other operating systems keep their existing secure-storage behavior.

## Building on this Mac

Run `npm run setup:signing` once, then `npm run package`. The one-time setup creates a local code-signing identity in a dedicated build-only keychain under `~/Library/Application Support/NoteThis Build Signing`. Keep this directory: replacing its key creates a different identity. The signing certificate and build-keychain password are private local build state, never repository files. Setup does not install a trusted root or modify saved NoteThis credentials.

Subsequent builds reuse that identity. Packaging fails with setup guidance if it is missing rather than silently creating a new one or shipping an ad-hoc replacement. The launcher also refuses to substitute a development executable when the packaged app is missing.

This is a local personal-use signing identity, not an Apple Developer ID certificate or notarized release. Public distribution requires an appropriate Apple signing and notarization workflow. macOS retains control of permission decisions; signature and mock-keychain checks cannot prove that a particular user has granted persistent access. macOS Keychain also uses signing partitions: non-Apple local certificates can still be associated with a build hash there. Consequently a local update may require a fresh Keychain confirmation even when the designated requirement stays stable. Choose Always Allow for that updated app; do not grant access to all applications. Apple-issued signing is the distribution path for stronger continuity across updates.

References: [Electron secure storage](https://www.electronjs.org/docs/latest/api/safe-storage), [Apple code-signing identity and Keychain access](https://developer.apple.com/library/archive/technotes/tn2206/_index.html), [Apple explanation of recording permissions and ad-hoc builds](https://developer.apple.com/forums/thread/819406).
