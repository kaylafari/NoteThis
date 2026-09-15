# Synthetic demonstration meeting

`sample-meeting.wav` was generated with macOS speech synthesis from a fictional launch-planning script. No real meeting or personal audio is included.

`sample-meeting.json` contains the actual offline faster-whisper base transcript and measured word timestamps. The sample summary/actions were prepared from the known script to provide a usable first-run walkthrough before an LLM has been downloaded. Clicking Ask this meeting or Regenerate notes calls the user's selected real LLM.

## NoteThis identity

The original SVG artwork depicts a closed calligraphy pen cap with a clip and narrow band. `notethis-mark.svg` is the transparent interface mark; `notethis-icon.svg`, its PNG, and `.icns` are the macOS app icon. Rebuild generated icons on macOS with `node scripts/build-icons.mjs`. The public SVG copies serve the app header and favicon.
