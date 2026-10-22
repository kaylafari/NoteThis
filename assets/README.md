# Synthetic demonstration meeting

`sample-meeting.wav` was generated with macOS speech synthesis from a fictional launch-planning script. No real meeting or personal audio is included.

`sample-meeting.json` contains the actual offline faster-whisper base transcript and measured word timestamps. The sample summary/actions were prepared from the known script to provide a usable first-run walkthrough before an LLM has been downloaded. Clicking Ask this meeting or Regenerate notes calls the user's selected real LLM.

## NoteThis identity

`notethis-artwork.png` is the approved white fountain-pen nib on a purple gradient. `notethis-icon.svg` wraps that artwork in a macOS rounded-square mask; `notethis-icon.png` and `notethis.icns` are generated application icons.

`notethis-mark.png` is the transparent nib used beside the app name. The interface uses its alpha channel as a CSS mask with a uniform gray fill, so the mark stays flat and has no background. Vite bundles the mark with the interface.

Rebuild the app icons and `public/favicon.png` on macOS with `node scripts/build-icons.mjs`. Keep the approved artwork and transparent mark as source assets. The interface accent is `#6F2DA8`, used sparingly for primary buttons, selected tabs, and playback progress.
