#!/bin/bash
# Live verification of the SQLite enrichment: flagged / tags / parentId / isSubtask / section.
#
# RUN FROM YOUR OWN Terminal.app with BOTH grants:
#   * Reminders Full Access (EventKit) — lets get-reminders read the reminder set.
#   * Full Disk Access (FDA)           — lets the CLI read the Reminders SQLite store for
#                                        the four enrichment fields. FDA is a MANUAL grant
#                                        (System Settings → Privacy & Security → Full Disk
#                                        Access); attribute it to Terminal.app for this run.
#
#   bash src/eventkit-cli/verify-enrichment.sh
#
# Pass criteria:
#   * augmented counts are non-zero for the features you actually use (you have Groceries
#     sections, so `sectioned` should be > 0);
#   * --no-augment yields ALL FOUR counts = 0 (the opt-out works);
#   * if EVERY augmented count is 0, FDA is almost certainly not granted to Terminal —
#     reads still return all reminders (graceful degradation), just without the extra fields.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
D="$DIR/build/eventkit-cli"
bash "$DIR/build-eventkit.sh" >/dev/null   # ensure built + signed

echo "== augmented counts (incomplete reminders) =="
"$D" get-reminders | jq '{total: length,
  flagged:   [.[]|select(.flagged)]|length,
  tagged:    [.[]|select(.tags)]|length,
  subtasks:  [.[]|select(.isSubtask)]|length,
  sectioned: [.[]|select(.section)]|length}'

echo
echo "== examples: flagged (first 5) =="
"$D" get-reminders | jq -r '[.[]|select(.flagged)][:5][] | "  \(.name)"'
echo "== examples: tagged (name -> tags) =="
"$D" get-reminders | jq -r '[.[]|select(.tags)][:5][] | "  \(.name) -> \(.tags|join(", "))"'
echo "== examples: in a section (name -> section) =="
"$D" get-reminders | jq -r '[.[]|select(.section)][:8][] | "  \(.name) -> \(.section)"'
echo "== examples: subtasks (name -> parentId) =="
"$D" get-reminders | jq -r '[.[]|select(.isSubtask)][:5][] | "  \(.name) -> parent \(.parentId)"'

echo
echo "== --no-augment must omit ALL four (expect every count 0) =="
"$D" get-reminders --no-augment | jq '{
  flagged:   [.[]|select(.flagged)]|length,
  tagged:    [.[]|select(.tags)]|length,
  subtasks:  [.[]|select(.isSubtask)]|length,
  sectioned: [.[]|select(.section)]|length}'

echo
echo "DONE. (If augmented counts are all 0, grant Full Disk Access to Terminal and rerun.)"
