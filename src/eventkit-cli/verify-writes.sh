#!/bin/bash
# Live verification of the ReminderKit WRITE path (Phase 2): set-flagged, add-tags,
# add-subtask, assign-section.
#
# RUN FROM YOUR OWN Terminal.app. Needs:
#   * Reminders Full Access (EventKit) — to create/read/delete the test reminder.
#   * Full Disk Access (FDA)           — so the read-back shows the enrichment fields and
#                                        so assign-section can resolve an existing section.
# Writes go through Apple's PRIVATE ReminderKit framework; if it's unavailable the calls
# return {"error":"ReminderKit ..."} cleanly (and this script will show that).
#
#   bash src/eventkit-cli/verify-writes.sh [ListName]   # default list: Reminders
#
# Creates throwaway "[EK-WTEST]" reminders, mutates them, reads back, then deletes them.
# NOTE: assign-section creates a section "[EK-WTEST] Section" in the list; an empty section
# may linger afterward — delete it by hand in Reminders.app if you don't want it.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIST="${1:-Reminders}"
D="$DIR/build/eventkit-cli"
bash "$DIR/build-eventkit.sh" >/dev/null

cleanup() {
  for id in $("$D" search-reminders --term "EK-WTEST" --list "$LIST" 2>/dev/null | jq -r '.[].id'); do
    "$D" delete-reminder --id "$id" >/dev/null 2>&1 || true
  done
}

echo "== pre-clean leftover [EK-WTEST] reminders =="
cleanup

echo "== create parent reminder =="
PID=$("$D" create-reminder --list "$LIST" --name "[EK-WTEST] parent" | jq -r .id)
echo "  parent id=$PID"

echo "== set-flagged true =="
"$D" set-flagged --id "$PID" --flagged true
echo "== add-tags (ekwtest) =="
"$D" add-tags --id "$PID" --tags "ekwtest"
echo "== add-subtask =="
"$D" add-subtask --parent "$PID" --name "[EK-WTEST] child"
echo "== assign-section ([EK-WTEST] Section) =="
"$D" assign-section --id "$PID" --section "[EK-WTEST] Section"

echo
echo "== read back the parent (EXPECT flagged:true, tags:[ekwtest], section set) =="
"$D" get-reminders --list "$LIST" | jq '[.[] | select(.id=="'"$PID"'") | {name, flagged, tags, section}]'
echo "== read back any EK-WTEST rows (EXPECT the child, isSubtask:true, parentId=parent) =="
"$D" search-reminders --term "EK-WTEST" --list "$LIST" | jq '[.[] | {name, isSubtask, parentId, flagged, tags, section}]'

echo
echo "== cleanup (delete EK-WTEST reminders) =="
cleanup
echo "== final re-query (EXPECT []) =="
"$D" search-reminders --term "EK-WTEST" --list "$LIST" | jq

echo
echo "DONE. Pass: parent showed flagged:true + tags:[ekwtest] + section; the child showed"
echo "isSubtask:true with parentId=the parent. (An empty [EK-WTEST] Section may remain.)"
