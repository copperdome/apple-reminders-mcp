#!/bin/bash
# Live end-to-end verification of the EventKit Reminders CLI (the 2026-06-04 port).
#
# RUN FROM YOUR OWN Terminal.app. TCC: the Full *Reminders* Access grant attributes to
# the responsible GUI app; from Claude's embedded shell it's denied (exit 3). The first
# run will prompt for Reminders access — approve it.
#
#   bash src/eventkit-cli/verify-reminders.sh [ListName]   # default list: Reminders
#
# Exercises the full reminder surface against throwaway "[EK-TEST]" reminders:
#   list-reminder-lists, create/get/search/update/delete (non-recurring),
#   the recurrence paths (create + update with RRULE), and the due-date guard
#   (--recurrence without --due must FAIL cleanly). Pre-cleans and self-cleans, so it's
#   safe to re-run. Uses a script file (not pasted commands) to avoid interactive-zsh
#   gotchas (`#`, `[]`, `()`, long-line mangling).
#
# Perf note: get-reminders should return in well under a second (the whole reason for
# the port — AppleScript was 37s+ on a 339-reminder store).

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIST="${1:-Reminders}"
D="$DIR/build/eventkit-cli"

bash "$DIR/build-eventkit.sh" >/dev/null   # ensure built + signed

ektest_ids() { "$D" search-reminders --term "EK-TEST" --list "$LIST" | jq -r '.[].id'; }

echo "== pre-clean any leftover [EK-TEST] reminders in '$LIST' =="
for id in $(ektest_ids); do
  echo "  removing leftover $id"
  "$D" delete-reminder --id "$id" >/dev/null || echo "  (warn) could not remove $id"
done

echo
echo "== list-reminder-lists (name / id) =="
"$D" list-reminder-lists | jq -r '.[] | "\(.name)\t\(.id)"'

echo
echo "== TIMING: get-reminders (should be well under 1s) =="
time "$D" get-reminders >/dev/null

echo
echo "== create non-recurring (with body, priority, due) =="
ID1=$("$D" create-reminder --list "$LIST" --name "[EK-TEST] roundtrip" \
        --body "verify body" --priority 5 --due 2026-06-10T15:00:00Z | jq -r .id)
echo "  id=$ID1"

echo "== search-reminders (expect the reminder, body/priority/dueDate populated) =="
"$D" search-reminders --term "EK-TEST" --list "$LIST" | jq

echo "== update-reminder (rename + complete) =="
"$D" update-reminder --id "$ID1" --name "[EK-TEST] updated" --completed true | jq

echo "== get-reminders --completed true (EXPECT the just-completed one to appear) =="
"$D" get-reminders --list "$LIST" --completed true | jq '[.[] | select(.name | contains("EK-TEST"))]'

echo "== delete-reminder =="
"$D" delete-reminder --id "$ID1" | jq

echo
echo "== GUARD: --recurrence WITHOUT --due must FAIL cleanly (expect {\"error\":...}) =="
# Don't let set -e abort on the expected nonzero exit.
set +e
OUT=$("$D" create-reminder --list "$LIST" --name "[EK-TEST] norule" --recurrence "FREQ=DAILY" 2>&1)
RC=$?
set -e
echo "  exit=$RC output=$OUT"
if [ "$RC" -eq 0 ]; then echo "  !! FAIL: expected nonzero exit (recurrence without due should be rejected)"; fi

echo
echo "== create recurring (FREQ=WEEKLY;COUNT=4 WITH a due date) =="
ID2=$("$D" create-reminder --list "$LIST" --name "[EK-TEST] weekly" \
        --due 2026-06-10T15:00:00Z --recurrence "FREQ=WEEKLY;COUNT=4" | jq -r .id)
echo "  id=$ID2"

echo "== get-reminders (EXPECT the reminder to carry a recurrence RRULE) =="
"$D" get-reminders --list "$LIST" | jq '[.[] | select(.name | contains("EK-TEST")) | {name, dueDate, recurrence}]'

echo "== update-reminder clear recurrence (--recurrence \"\") =="
"$D" update-reminder --id "$ID2" --recurrence "" | jq

echo "== get-reminders (EXPECT recurrence now absent/null) =="
"$D" get-reminders --list "$LIST" | jq '[.[] | select(.name | contains("EK-TEST")) | {name, recurrence}]'

echo "== delete-reminder (cleanup) =="
"$D" delete-reminder --id "$ID2" | jq

echo
echo "== final re-query (EXPECT empty []) =="
"$D" search-reminders --term "EK-TEST" --list "$LIST" | jq

echo
echo "DONE. Pass criteria: get-reminders timed <1s; create/update/delete round-tripped;"
echo "the guard FAILED cleanly; the recurring reminder carried an RRULE then cleared it."
