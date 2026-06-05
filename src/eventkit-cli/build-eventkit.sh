#!/bin/bash
# Build + sign the EventKit Calendar CLI (src/eventkit-cli/main.swift).
#
# Produces  src/eventkit-cli/build/eventkit-cli  — the binary the Node
# CalendarExecutor spawns. Compilation needs no Calendar access; only RUNNING the
# binary triggers the Full Calendar Access (TCC) prompt.
#
# TCC notes (don't rediscover — see HANDOFF.md):
#   - The binary MUST embed NSCalendarsFullAccessUsageDescription (linker
#     -sectcreate __TEXT __info_plist) AND be re-signed with `codesign --force
#     --sign -` to *bind* the plist, or TCC denies access silently.
#   - The grant is attributed to the *responsible GUI app*. Run once from your own
#     Terminal.app to grant it there; when Claude Desktop's Node server spawns the
#     binary the grant is attributed to Claude Desktop (verify it has the grant).
#
# Usage:
#   bash src/eventkit-cli/build-eventkit.sh                 # build/sign only
#   bash src/eventkit-cli/build-eventkit.sh list-calendars  # build then run a command
#   bash src/eventkit-cli/build-eventkit.sh get-events --calendar Personal --start 2026-06-01T00:00:00Z --end 2026-07-01T00:00:00Z

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$DIR/main.swift"
DB="$DIR/RemindersDB.swift"   # best-effort SQLite enrichment (flagged/tags/subtask/section)
PRIV="$DIR/RemindersPrivate.m" # ReminderKit WRITE bridge (Phase 2)
HDR="$DIR/RemindersPrivate.h"  # bridging header exposing the C write entry points to Swift
PLIST="$DIR/Info.plist"
BIN="$DIR/build/eventkit-cli"
mkdir -p "$DIR/build"

# Rebuild only if a source input is newer than the binary.
if [ ! -x "$BIN" ] || [ "$SRC" -nt "$BIN" ] || [ "$DB" -nt "$BIN" ] || \
   [ "$PRIV" -nt "$BIN" ] || [ "$HDR" -nt "$BIN" ] || [ "$PLIST" -nt "$BIN" ]; then
  echo "building $BIN …" >&2
  # -lsqlite3 links the system SQLite dylib used by RemindersDB.swift to read the
  # Reminders store. Reading that store at RUNTIME needs Full Disk Access — a MANUAL
  # grant with NO Info.plist usage key (confirmed remctl-permissions.swift:124,193),
  # attributed to the responsible GUI app (Terminal for the CLI, Claude Desktop when
  # the MCP spawns this binary). Compilation needs no special access.
  #
  # RemindersPrivate.m calls Apple's PRIVATE ReminderKit framework for WRITES (flagged/
  # tags/subtask/section). -import-objc-header exposes its C entry points to Swift;
  # -weak_framework ReminderKit links it WEAKLY so the binary still launches (and reads
  # still work) if the framework is ever absent/renamed — rem_available() guards calls.
  swiftc -O -o "$BIN" \
    -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$PLIST" \
    -lsqlite3 \
    -import-objc-header "$HDR" \
    -F /System/Library/PrivateFrameworks \
    -Xlinker -weak_framework -Xlinker ReminderKit \
    "$SRC" "$DB" "$PRIV"
  # Re-sign so the embedded Info.plist (usage description) is bound for TCC.
  codesign --force --sign - \
    --identifier com.copperdome.apple-reminders-mcp.eventkit-cli "$BIN"
  echo "built + signed." >&2
fi

# If invoked with a subcommand, run it. Otherwise just build.
if [ "$#" -gt 0 ]; then
  exec "$BIN" "$@"
fi
