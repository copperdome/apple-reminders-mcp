#!/bin/bash
# Build + sign + run the EventKit recurring-delete smoke test (TRACK 2 go/no-go).
#
# RUN THIS FROM YOUR OWN Terminal.app — not from inside Claude. EventKit's Full
# Calendar Access (TCC) prompt is attributed to the *responsible* GUI app; from
# Terminal that's Terminal.app, which can show the dialog and let you approve.
# (From Claude's embedded shell the request is attributed to Claude.app and is
# denied synchronously with no prompt.)
#
# Usage (run in order):
#   bash src/eventkit-cli/smoke.sh list
#   bash src/eventkit-cli/smoke.sh find   0AC2E645-A307-400D-B3A5-D0E593E0EA9F
#   bash src/eventkit-cli/smoke.sh delete 0AC2E645-A307-400D-B3A5-D0E593E0EA9F
#   bash src/eventkit-cli/smoke.sh find   0AC2E645-A307-400D-B3A5-D0E593E0EA9F   # expect 0
#
# First run pops the Calendar permission dialog — click Allow / Full Access.

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$DIR/build/ek-smoke"
mkdir -p "$DIR/build"

# Rebuild only if source is newer than the binary.
if [ ! -x "$BIN" ] || [ "$DIR/smoke-test.swift" -nt "$BIN" ] || [ "$DIR/Info.plist" -nt "$BIN" ]; then
  echo "building $BIN …"
  swiftc -O -o "$BIN" \
    -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$DIR/Info.plist" \
    "$DIR/smoke-test.swift"
  # Re-sign so the embedded Info.plist (usage description) is bound for TCC.
  codesign --force --sign - \
    --identifier com.copperdome.apple-reminders-mcp.eventkit-cli "$BIN"
fi

exec "$BIN" "$@"
