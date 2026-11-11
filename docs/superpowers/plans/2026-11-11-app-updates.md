# NoteThis in-app updates implementation plan

> Execute inline using the executing-plans skill, with test-first changes and sequential commits.

**Goal:** Ship the simplest verified in-app update flow supported by the existing macOS signing identity.
**Architecture:** A main-process update controller owns trusted GitHub discovery, native download/install and state. A narrow preload bridge connects the React update UI. The server and renderer both veto unsafe restarts. Native macOS handles signature validation and replacement.
**Tech Stack:** Electron 44, TypeScript, React, Vitest, GitHub Releases.
**Spec:** docs/superpowers/specs/2026-11-11-app-updates-design.md

## Constraints and review focus
- Preserve bundle/signing/Keychain identity and application data.
- No background download or forced restart; fail closed for missing renderer state.
- Fixed public repository, validated stable versions and assets, no arbitrary IPC URLs.
- Reject incompatible/tampered updates; expose recoverable failure and installer fallback.
- Cover repeated clicks, stale state, network failure and active processing.

## Steps
- [x] Prove native update between disposable signed apps, including actual replacement/relaunch; choose native or fallback from evidence.
- [x] Add failing controller tests for release validation, duplicate operations, retry, download and restart guards. Implement shared update types and desktop controller.
- [x] Add bridge/main wiring and server busy status, with tests for untrusted IPC and active work.
- [x] Add tested Updates settings section and compact notification; conservatively report renderer busy state.
- [x] Commit/push tested feature; update build to publish ZIP if native mode is verified. Document the user and release workflows.
- [ ] Validate packaged update flow, full suite/build, signatures, runtime and GitHub CI.
- [ ] Bump release version, commit/push/tag, build installer, upload draft assets, verify hashes, publish latest and read back public URLs.

## Execution evidence and rulings

- Native acceptance: same-certificate signed test app replaced/relaunched at 1.0.1; tampered payload rejected and 1.0.0 retained. Native option selected as authorized.
- Fresh review identified restart input race/canceled-close recovery and disconnected-request work accounting. Both fixed with reproducing regressions. Follow-up review found no remaining important issues.
- Renderer input is frozen before readiness reads and rechecked after server readiness. Canceled native closes restore ready status, input and server writes. Server tracks async mutation handlers independently of HTTP socket lifetime.
- Implementation stays in the user's clean current checkout and authorized main branch; no parallel implementers or unrelated modifications.

- Final pre-package verification: 443 tests in 32 files, TypeScript and production build passed. Feature commit f46f559 pushed.
