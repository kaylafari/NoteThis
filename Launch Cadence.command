#!/bin/zsh
# Keep existing shortcuts working after the NoteThis rename.
exec "$(dirname "$0")/Launch NoteThis.command" "$@"
