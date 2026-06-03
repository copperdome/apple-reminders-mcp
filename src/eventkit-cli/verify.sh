#!/bin/bash
# Live end-to-end verification of the EventKit Calendar CLI.
#
# RUN FROM YOUR OWN Terminal.app (TCC: the Full Calendar Access grant attributes to
# the responsible GUI app; from Claude's embedded shell it's denied silently).
#
#   bash src/eventkit-cli/verify.sh [CalendarName]   # default calendar: Personal
#
# Exercises the full surface against a throwaway "[EK-TEST]" event set:
#   list-calendars, create/search/update/delete (non-recurring),
#   and create/get/delete of a WEEKLY x4 recurring series (the row AppleScript
#   could never pass). Pre-cleans and self-cleans so it's safe to re-run.
#
# Using a script file (not pasted commands) avoids the interactive-zsh gotchas:
# `#` isn't a comment in interactive zsh, `<UID>`/`[]`/`()` get glob/redirect-parsed,
# and long lines get mangled on paste.

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CAL="${1:-Personal}"
D="$DIR/build/eventkit-cli"
WIN=(--start 2026-06-01T00:00:00Z --end 2026-08-01T00:00:00Z)

bash "$DIR/build-eventkit.sh" >/dev/null   # ensure built + signed

ektest() { "$D" get-events --calendar "$CAL" "${WIN[@]}" | jq '[.[] | select(.summary | contains("EK-TEST"))]'; }
ektest_uids() { "$D" search-events --term EK-TEST --calendar "$CAL" | jq -r '.[].uid' | sort -u; }

echo "== pre-clean any leftover [EK-TEST] events in '$CAL' =="
for u in $(ektest_uids); do
  echo "  removing leftover $u"
  "$D" delete-event --uid "$u" >/dev/null || echo "  (warn) could not remove $u"
done

echo
echo "== list-calendars (writable / id / name) =="
"$D" list-calendars | jq -r '.[] | "\(.writable)\t\(.id)\t\(.name)"'

echo
echo "== create non-recurring =="
U1=$("$D" create-event --calendar "$CAL" --summary "[EK-TEST] roundtrip" \
      --start 2026-06-10T15:00:00Z --end 2026-06-10T16:00:00Z | jq -r .uid)
echo "  uid=$U1"

echo "== search-events (expect the event) =="
"$D" search-events --term EK-TEST --calendar "$CAL" | jq

echo "== update-event (summary + location) =="
"$D" update-event --uid "$U1" --summary "[EK-TEST] updated" --location "Desk" | jq

echo "== delete-event (non-recurring) =="
"$D" delete-event --uid "$U1" | jq

echo
echo "== create recurring (FREQ=WEEKLY;COUNT=4) =="
U2=$("$D" create-event --calendar "$CAL" --summary "[EK-TEST] weekly" \
      --start 2026-06-10T15:00:00Z --end 2026-06-10T16:00:00Z \
      --recurrence "FREQ=WEEKLY;COUNT=4" | jq -r .uid)
echo "  uid=$U2"

echo "== get-events (EXPECT 4 occurrences, each with a recurrence RRULE) =="
ektest

echo "== delete-event recurring (default future span) =="
"$D" delete-event --uid "$U2" | jq

echo "== re-query (EXPECT empty []) =="
ektest

echo
echo "DONE. If the recurring block showed 4 occurrences then [] after delete, step 2 is verified."
