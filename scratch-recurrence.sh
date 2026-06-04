#!/usr/bin/env bash
# Throwaway recurrence test for the EventKit Reminders port. Creates + deletes its own
# reminder. Delete this file when done.
set -uo pipefail   # NOT -e: we WANT to see the expected-failure case
BIN="src/eventkit-cli/build/eventkit-cli"
show() { python3 -c 'import sys,json;i=sys.argv[1];[print("  recurrence =",repr(r.get("recurrence")),"| due =",r.get("dueDate")) for r in json.load(sys.stdin) if r["id"]==i]' "$1"; }

LIST=$("$BIN" list-reminder-lists | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["name"])')
echo "== using list: $LIST =="

echo "== 1. GUARD: create recurrence WITHOUT a due date — expect a clear error, no creation =="
"$BIN" create-reminder --list "$LIST" --name "MCP recur — should fail" --recurrence "FREQ=DAILY"
echo

echo "== 2. create a biweekly recurring reminder WITH a due date =="
ID=$("$BIN" create-reminder --list "$LIST" --name "MCP recur — delete me" \
       --due 2026-06-10T09:00:00Z --recurrence "FREQ=WEEKLY;INTERVAL=2" \
     | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
echo "   created id: $ID"
echo "   read back (expect recurrence = RRULE:FREQ=WEEKLY;INTERVAL=2):"
"$BIN" get-reminders --list "$LIST" | show "$ID"
echo

echo "== 3. update the rule to daily =="
"$BIN" update-reminder --id "$ID" --recurrence "FREQ=DAILY" >/dev/null
"$BIN" get-reminders --list "$LIST" | show "$ID"
echo

echo "== 4. clear recurrence (empty --recurrence) — expect recurrence = None =="
"$BIN" update-reminder --id "$ID" --recurrence "" >/dev/null
"$BIN" get-reminders --list "$LIST" | show "$ID"
echo

echo "== 5. delete + verify gone (prints nothing if deleted) =="
"$BIN" delete-reminder --id "$ID"
"$BIN" get-reminders --list "$LIST" | show "$ID"
echo "== done =="
