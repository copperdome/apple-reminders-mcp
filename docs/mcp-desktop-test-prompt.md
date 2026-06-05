# Claude Desktop — full Reminders MCP test prompt

Paste the prompt below into **Claude Desktop** (where this MCP server runs) to exercise every
Reminders tool end-to-end and get a PASS/FAIL report. It is safe and idempotent: it only touches
items it creates (all prefixed `[MCP-TEST]`) and deletes them at the end.

## Prerequisites (one-time)
- The MCP server is registered in Claude Desktop and Desktop has been **restarted** after the latest
  `npm run build` (the server doesn't hot-reload).
- **Reminders Full Access** granted to **Claude Desktop** (not just Terminal).
- **Full Disk Access** granted to **Claude Desktop** — required for the read-back enrichment fields
  (flagged / tags / parentId / isSubtask / section) and for `assign_reminder_section`'s existing-section
  lookup. If section D's fields come back blank, this grant is missing — see `CLAUDE.md` (Reminders).

## What "pass" looks like
- A–C (EventKit CRUD + recurrence) and E–F (honesty + cleanup) pass with only the Reminders grant.
- D (private ReminderKit writes + enrichment read-back) passes only with Full Disk Access for Desktop.
- A freshly created reminder may show `section: "Miscellaneous Items"` — that's Reminders auto-sectioning
  new items, faithfully reported; it's not a failure.

## The prompt

```
You have access to the Apple Reminders MCP tools. Run a full, self-verifying test pass
and report results as a PASS/FAIL table. Rules:

- Operate ONLY on items you create, all named with the prefix "[MCP-TEST]". Never modify
  or delete any of my real reminders.
- Use the list named "Reminders" (if it doesn't exist, use the first list from
  list_reminder_lists and say which).
- For each step show the tool call, the key result, and PASS/FAIL with a one-line reason.
- Delete every [MCP-TEST] item at the end and confirm none remain.

Steps:

A. READ
  1. list_reminder_lists — expect ≥1 list.
  2. get_reminders (no args) — expect an array; note the total count.

B. CREATE / UPDATE / DELETE (core EventKit fields)
  3. create_reminder name "[MCP-TEST] core" in the list, body "hello", priority 5,
     dueDate "2026-06-20T15:00:00Z". Capture the returned id.
  4. get_reminders for that list; find the item by id — expect body/priority/dueDate set,
     and remindMeDate populated (auto-alarm at due time).
  5. update_reminder that id: name "[MCP-TEST] core UPDATED", completed true.
  6. get_reminders with completed=true — expect the item present, completed, renamed,
     with a completionDate.
  7. delete_reminder that id; re-query — expect it gone.

C. RECURRENCE
  8. create_reminder "[MCP-TEST] norule" with recurrence "FREQ=DAILY" and NO dueDate —
     EXPECT AN ERROR (recurrence requires a due date). PASS = it errored cleanly.
  9. create_reminder "[MCP-TEST] weekly" with dueDate "2026-06-20T15:00:00Z" and
     recurrence "FREQ=WEEKLY;INTERVAL=2". Capture id. get_reminders — expect a
     recurrence RRULE on the item. Then update_reminder with recurrence "" (clear) and
     confirm recurrence is gone. delete it.

D. WRITES via private ReminderKit + enrichment read-back
  (These need Full Disk Access for Claude Desktop. If the enrichment fields come back
   absent on a freshly-written item, STOP and report "FDA likely not granted to Claude
   Desktop" instead of marking the rest failed.)
  10. create_reminder "[MCP-TEST] rich" in the list. Capture id.
  11. set_reminder_flagged id, flagged true. get_reminders — expect flagged:true.
  12. add_reminder_tags id, tags ["mcptest"]. get_reminders — expect tags is exactly
      ["mcptest"] (NOT ["[mcptest]"] or any bracketed/escaped form).
  13. add_subtask parentId=id, name "[MCP-TEST] child". search_reminders "MCP-TEST" —
      expect the child with isSubtask:true and parentId == the parent id.
  14. assign_reminder_section id, section "[MCP-TEST] Section". get_reminders — expect
      section "[MCP-TEST] Section".
  15. set_reminder_flagged id, flagged false. get_reminders — expect flagged:false.

E. HONESTY CHECK
  16. Confirm a plain reminder with no tags returns tags ABSENT/empty (not a fake value),
      and that any reminder you didn't flag does not report flagged:true.

F. CLEANUP
  17. search_reminders "MCP-TEST" and delete_reminder every returned id. Re-query —
      expect none. (Deleting the sectioned item normally lets Reminders drop the empty
      "[MCP-TEST] Section"; if one lingers, mention it so I can delete it by hand.)

End with: a results table (step, PASS/FAIL, note), the list you used, and any setup
issues (e.g. FDA). Do not touch anything not prefixed "[MCP-TEST]".
```

## Notes
- Run it in Claude Desktop, not in a terminal/headless shell — the write and enrichment steps need
  Desktop to hold the Reminders + Full Disk Access grants (responsible-app TCC attribution).
- The local CLI harnesses (`src/eventkit-cli/verify-*.sh`) cover the same surface from your own
  Terminal if you want to validate outside the MCP path.
