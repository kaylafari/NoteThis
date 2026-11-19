# NoteThis interface

NoteThis puts the recording and its notes first. Keep the interface quiet enough
to read a long transcript comfortably, with clear controls for the next action.

## Shared rules

- Use the system sans-serif font. Reserve monospace for code and source text;
  use tabular numbers for timestamps, durations, counts, and data tables.
- Use 14px for reading, 13px for controls, and 12px for supporting copy. Narrow
  layouts should rearrange controls rather than shrink useful text.
- Use white and light gray surfaces, dark text, and `#6F2DA8` purple for the
  primary recording action, selected navigation, playback position, and focus.
- Reuse the CSS color, type, spacing, and radius tokens in `src/styles.css`.
  Space related controls by 8–16px and separate sections by 24–32px.
- Use 6px control, 10px row, and 16px container radii. For controls nested close
  to an outer edge, derive the inner radius from outer radius minus inset;
  the chat composer uses a 14px outer radius, 8px inset, and 6px send button.
- Use Lucide outline icons, with text or an accessible name on every control.
  Preserve the gray NoteThis nib beside the name.

## Content and feedback

The meeting title, Summary, and Transcript need no decorative eyebrow or status
badge. Show Key decisions only when there are decisions. Keep Notes as its own
tab. Keep settings copy specific to what the panel controls.

The home screen explains recording and importing directly, and opens a real,
clearly labeled sample meeting. Avoid decorative waveform or file mockups.

Keep progress indicators tied to real work: opening a workspace, importing,
recording permission requests, transcription, note generation, model discovery,
chat answers, and updates. Use brief feedback transitions; respect the existing
reduced-motion rules. Never delay completion to display an animation.

## Checking changes

Run `npm run build`, `npm test`, and `node scripts/test-notes-ui.mjs`.
The last command uses an isolated profile and synthetic audio, checks summary
ordering, Markdown/math rendering, transcript seeking, and layout at 1280, 900,
600, and 375 pixels, and saves screen captures to the system temporary folder.
Inspect those captures, including settings and recording, before shipping.
The packaged desktop app supports widths from 900px; narrower captures cover
the browser layout. Do not use private meetings or connected model requests for
visual regression checks.
