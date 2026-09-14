# Browser sign-in repair (0.1.1)

The original desktop link used a popup handler that discarded operating-system browser-launch errors. No application browser-error log existed, so the reported click did not leave a useful error record. The old generic link worked during an isolated reproduction; the exact trigger of the user's failed click was not established.

The sign-in control now awaits a narrow, validated Electron operation. The app displays a launch failure next to the sign-in controls, with a selectable URL and copy-link fallback. It reports successful handoff to the browser separately from completed provider authentication. Ordinary browser previews also detect blocked popups. Desktop diagnostics record time, outcome, and hostname only under `~/Library/Logs/Cadence/browser.log`; authorization URLs, codes, tokens, and raw provider errors are excluded.

The native browser smoke test uses the actual sandboxed preload and IPC route and opens a harmless loopback page in the system's default browser. A request to that page confirms that the browser received the link. It does not sign into an account. Run `npm run test:browser-launch` to repeat it; it opens browser test tabs.

Provider requests and account lifecycle regressions use isolated fixtures and mocked external responses. They validate request construction and UI state, not provider subscriptions, billing access, or every provider's live service. Completing sign-in still requires the account owner's browser interaction.

Additional repairs cover OAuth completion badges, canceled-session polling, duplicate sign-in clicks, pending login cancellation on settings close, and saved-preferences feedback. Browser-only Codex/Copilot dispatch no longer accepts API-key slots. Anthropic's API-key precedence is explained in Settings. Provider responses now reject malformed/error JSON and incomplete Gemini results, and silent speech chunks no longer degrade valid word timing. Cancellation during a credential write restores the prior connection.

Verification: all 145 tests pass across 11 test files, including real React/Chromium settings interactions, the actual pi-ai OAuth implementations with isolated network fixtures, and every advertised provider adapter. The native handoff separately reached the default browser. The packaging script was also corrected to use the supported `--dir` flag.
