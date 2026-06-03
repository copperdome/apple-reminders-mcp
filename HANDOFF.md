# apple-reminders-mcp — Session Handoff

Use this to resume development after a restart. Read this + CLAUDE.md before touching any code.

---

## ▶ Resuming in Claude Code (start here)

You're picking this up in a Claude Code session opened on `~/apple-reminders-mcp`.

1. **Read context:** this file + `CLAUDE.md` (auto-loads) + `docs/RESEARCH-caldav-recurring-delete.md`
   (the EventKit/CalDAV research from 2026-06-03).
2. **Commit the in-flight work first.** The working tree has **uncommitted** changes from the
   last two sessions (Cowork couldn't write to `.git`). It's all built and consistent — just
   not committed:
   - Modified: `src/applescript-executor.ts`, `src/index.ts`
   - Untracked: `src/calendar-executor.ts`, `docs/`, `HANDOFF.md`
   - Suggested: `git add -A && git commit -m "Fix Reminders apostrophe/escaping (heredoc), honest recurring-delete error, dict cleanup; add CalDAV research"`
3. **Build/test loop:** `npm run build` (currently green, `dist/` is fresh). There are **no unit
   tests yet** — see "Set up a test harness" under Remaining/next; that's the recommended first
   dev task.
4. **To test the MCP live** you must **restart Claude Desktop** (the MCP runs there, not in
   Claude Code, and doesn't hot-reload). Then run the post-restart verification below.

**Two prioritized tracks from here:** (a) the test harness + the small schema cleanup, and
(b) the bigger move — porting the Calendar half to EventKit (see Remaining/next + the research
doc). Reminders stays on AppleScript.

---

## ⚠️ State right now

A deep verification + bug-test pass was run against the **live** MCP, and several real bugs
were found and fixed in `src/`. **The fixes are compiled into `dist/` but NOT live yet —
they require a Claude Desktop restart.** Until then the running server still has the old
behavior (notably: apostrophes in reminders break).

After restart, re-run the **post-restart verification** section below to confirm the fixes.

### Update — test-harness session (after the 2026-06-03 audit)
Committed. This session set up the test harness and did the schema cleanup that the prior
handoff deferred. No live-MCP behavior changed beyond the recurrence-field removal (still
needs a restart to go live). What changed:
- **vitest harness** added: `npm test` (→ `vitest run`) and `npm test:watch`. Tests live in
  `test/` (excluded from `tsc`, so `dist/` stays clean). **31 tests, all green.**
- **Pure logic extracted** to `src/applescript-util.ts`: `escAS`, `isoToAppleScriptDate`,
  `parseReminders`, `parseEvents`, plus a new `interpretDeleteResult` (the OK/NOTFOUND/PERSISTED
  branch mapping from `deleteEvent`, now unit-testable). Both executors import from it; the
  duplicated private copies are gone. Calendar's 10 inline `.replace(…)` escapes were
  centralized onto `escAS` (behavior-identical, now under test).
- **Regression tests** cover the 2026-06-03 bugs: apostrophe pass-through in `escAS` (the
  critical shell bug), backslash-before-quote ordering, `isoToAppleScriptDate` no-UTC-drift +
  AM/PM/midnight/noon + unparseable pass-through, `§§§`/`§REC§` parsing + `missing value` +
  newline restoration, and the PERSISTED/NOTFOUND delete branches.
- **Phantom reminder recurrence removed** (the deferred schema cleanup): dropped from the
  `create_reminder`/`update_reminder` schemas + `get_reminders` description, the `createReminder`/
  `updateReminder` signatures, the `Reminder` interface, `parseReminders`, and the AppleScript
  (reminder lines now emit 10 §§§ fields, name…flagged). Calendar recurrence is untouched (it's real).
- CLAUDE.md workflow note updated: `npm test` + `npm run build` before restart.

Still pending the same Claude Desktop restart + the post-restart verification below.

---

## What this session did

Verified the previous session's fixes against the live MCP, found that two of them did NOT
actually work, found a new critical bug, fixed everything fixable, and documented the rest.

### Confirmed working from last session
- `list_reminder_lists` — ✅ FIXED & VERIFIED LIVE. The default "Reminders" list now returns a
  real id (`39905EBE-…`), all four lists correct.
- `delete_event` non-recurring (with calendarName) — ✅ verified (test event in "John's Work"
  created + deleted cleanly, confirmed gone).
- Reminders/Calendar scoped reads, create, update — ✅ working.

### Bugs found this session

1. **CRITICAL — apostrophes broke Reminders entirely.** `executeScript` used
   `osascript -e '…'` and escaped inner apostrophes as `\'`, which is invalid inside a
   single-quoted /bin/sh string. Creating a reminder named `quote "x" and apostrophe's`
   failed at the shell layer (`unexpected EOF`). Any apostrophe ("Mom's birthday") was
   unusable. **FIXED:** switched Reminders `executeScript` to the same single-quoted heredoc
   Calendar uses, and added an `escAS()` helper applied to every user input
   (name, body, list, searchTerm, dueDate, remindMeDate, reminderId). The Calendar path
   already handled the identical input correctly in a live test — confirming the pattern.

2. **`list_calendars` returns empty ids.** The `properties of cal` crash is fixed (tool no
   longer fails), but `calendarIdentifier of cal` comes back empty for every (CalDAV/Google)
   calendar. **PARTIAL FIX:** added an `id of cal` fallback — **unverified**, needs restart.
   Cosmetic: all targeting is by name.

3. **Recurring-event delete silently lied.** Last session's "fix"
   (`delete every event … whose uid = X`) reports success but the recurring test event in the
   **Personal** (Google) calendar still exists — verified twice, 8s+ apart, not sync lag.
   No reliable pure-AppleScript fix exists for CalDAV recurring series. **FIXED the lie:**
   `deleteEvent` now re-queries after deleting and throws an honest error if the event
   persists, instead of falsely reporting success. Actual deletion of such series still
   requires the Calendar UI.

4. **Dictionary mismatch — reminders have no `recurrence` property.** `getReminders` /
   `searchReminders` queried `recurrence of rem` (try-wrapped, always failed → wasted one
   Apple Event per reminder, and the schema advertised a field that's always empty).
   **FIXED:** removed the phantom read; updated notes. (Tool descriptions still mention it —
   see "remaining" below.)

5. **Minor:** `create_event`/`update_event` didn't escape `url`/`recurrence`. **FIXED.**

### Known limitation reproduced (not a regression)
- **iCloud sync lockout.** During an active sync, even ID-based `update_reminder` /
  `delete_reminder` and scoped `search_events` time out at 28s. Retrying ~30s later
  succeeds. Global (no calendarName/listName) enumeration reliably times out during sync.
  Workaround unchanged: always pass `listName` / `calendarName`.

---

## Post-restart verification — ✅ DONE (test-harness session, against fixed dist)

Claude Desktop was restarted and all reachable checks were run live against the new code.
Confirmed the server is on the new build: `create_reminder` schema loaded with no
`recurrenceRule`, and reminder output has no `recurrence` field.

### 1. Apostrophe fix (the important one) — ✅ PASS
- `create_reminder { name: "Mom's birthday test", listName: "Reminders" }` → created with id
  `…465A9CD0FD29` (this FAILED at the shell layer on the old code).
- `search_reminders { searchTerm: "Mom's", listName: "Reminders" }` → found it (apostrophe in
  the search term also worked).
- `delete_reminder { reminderId: … }` → deleted. Clean round-trip.

### 2. list_calendars ids — ⚠️ still empty (now VERIFIED no-op, was "unverified")
`list_calendars` runs cleanly but **every id is `""`** even with the `id of cal` fallback —
so neither `calendarIdentifier of cal` nor `id of cal` yields a value on this account's
calendars. Cosmetic (all targeting is by name). **Follow-up option:** the `id of cal`
fallback block in `getCalendars` is now confirmed dead code — consider removing it.

### 3. Honest recurring-delete error — ✅ PASS
`delete_event { uid: "7ADB72E8-…", calendarName: "Personal" }` returned the honest error
("Delete reported success but event … still exists … Delete the series in the Calendar app
UI instead") — no more silent-success lie. (Verified the uid first via `search_events` =
"[MCP-TEST] Full options event (updated)", a throwaway test event.)

### 4. Clean up the lingering recurring test event — ⬜ MANUAL (still pending)
`7ADB72E8-D4BE-4538-99F4-09A0127D4FC8` ("[MCP-TEST] Full options event (updated)") is a
weekly recurring event still in **Personal**. It cannot be removed via the MCP (CalDAV
limitation — confirmed again above). **John is deleting it in the Calendar app UI manually.**

---

## Live test matrix (this session, against pre-fix dist)

| Tool | Result |
|------|--------|
| `list_reminder_lists` | ✅ PASS — real ids incl. default list |
| `list_calendars` | ⚠️ runs, but all ids empty |
| `create_reminder` (basic + flagged + priority) | ✅ PASS |
| `create_reminder` (apostrophe/quote in name) | ❌ FAIL — shell escaping (now fixed) |
| `search_reminders` (scoped) | ✅ PASS |
| `update_reminder` (by id) | ✅ PASS after sync settled; timed out during sync |
| `delete_reminder` | ✅ PASS |
| `create_event` (apostrophe + quotes, round-trip) | ✅ PASS — heredoc robust |
| `update_event` (calendarName hint) | ✅ PASS |
| `delete_event` (non-recurring) | ✅ PASS — confirmed gone |
| `delete_event` (recurring, Google cal) | ❌ FAIL — silent persist (now an honest error) |
| `get_events` (scoped) | ✅ PASS |
| `search_events` (scoped) | ✅ PASS |
| global reads/writes during sync | ❌ TIMEOUT (known lockout) |

---

## Remaining / next

- **Test harness — ✅ DONE (vitest, 31 green).** `escAS`, `isoToAppleScriptDate`,
  `parseReminders`, `parseEvents`, and `interpretDeleteResult` are extracted to
  `src/applescript-util.ts` and unit-tested in `test/applescript-util.test.ts`. Covers all the
  2026-06-03 bugs (apostrophe pass-through, escape ordering, date no-UTC-drift, delimiter
  parsing, delete branches). `npm test` wired into CLAUDE.md.
  - **Still not done — pure-script-string assertions.** The tests cover escaping/date/parse
    helpers but NOT the generated AppleScript text itself (the script-builder strings are still
    inlined in the executor methods, not extracted). If you want to assert "the create_reminder
    script is shell-safe / contains no `\'`", split each "build script" string out of its
    `async` method into a pure exported builder first, then test the string. Lower value now
    that escaping is centralized + tested, but it's the remaining gap.
  - **Still not done — optional live/integration tier** (env-gated `TEST_LIVE=1`, throwaway
    list/calendar, self-cleaning) mirroring the manual matrix. Keep it out of default `npm test`.
- **After restart:** run the 4 verification steps above; update this file with results.
- **Tool descriptions (`index.ts`) — ✅ DONE.** `get_reminders` no longer advertises
  recurrence; `recurrenceRule` removed from the `create_reminder`/`update_reminder` schemas and
  handlers. (Reminders have no recurrence.) Calendar's `recurrence` is untouched.
- **Recurring delete on CalDAV — researched 2026-06-03, see `docs/RESEARCH-caldav-recurring-delete.md`.**
  Conclusion: it is NOT fixable in AppleScript (structural — AppleScript `delete` only writes an
  EXDATE for one occurrence, and CalDAV/Google masters are non-local + server-authoritative).
  **Recommended fix: move the Calendar half of this MCP off AppleScript onto EventKit** (small
  Swift CLI the Node server spawns). EventKit unifies iCloud + Google-via-CalDAV + local, exposes
  the `span` (thisEvent / futureEvents) delete semantics AppleScript lacks, fixes recurring-event
  expansion, and gives account-type routing via `EKSource`. Keep Reminders on AppleScript.
  Borrow from `PsychQuant/che-ical-mcp` (mature) or `EgorKurito/apple-calendar-mcp` (simple
  reference). Before porting, do the ~30-line Swift `remove(span:.futureEvents)` smoke test on
  the lingering `7ADB72E8…` event to confirm EventKit actually deletes a Google series.
- **Mail suite** — still not started. Dictionary is at `docs/mail-dictionary.md` (read first).
  Planned tools: list_mailboxes, get_emails, get_email, search_emails, send_email,
  reply_to_email, move_email, mark_read/unread, trash_email. Implementation file
  `src/mail-executor.ts` does not exist yet; wire into `index.ts` like CalendarExecutor.
