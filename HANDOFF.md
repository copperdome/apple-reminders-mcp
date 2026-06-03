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

## ⚠️ State right now (2026-06-03 session)

A deep verification + bug-test pass was run against the **live** MCP, and several real bugs
were found and fixed in `src/`. **The fixes are compiled into `dist/` but NOT live yet —
they require a Claude Desktop restart.** Until then the running server still has the old
behavior (notably: apostrophes in reminders break).

After restart, re-run the **post-restart verification** section below to confirm the fixes.

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

## First things to do after restart

### 1. Verify the apostrophe fix (the important one)
```
create_reminder { name: "Mom's birthday test", listName: "Reminders" }
Expect: success with an id (previously failed at shell layer)
Then: search_reminders { searchTerm: "Mom's", listName: "Reminders" } → finds it
Then: delete_reminder { reminderId: <id> }
```

### 2. Verify list_calendars ids
```
list_calendars
Expect: id fields populated (id-of-cal fallback). If still empty, leave as-is — cosmetic.
```

### 3. Verify honest recurring-delete error
```
delete_event { uid: "7ADB72E8-D4BE-4538-99F4-09A0127D4FC8", calendarName: "Personal" }
Expect: an ERROR saying the event still exists / delete in UI (NOT a false success)
```

### 4. Clean up the lingering recurring test event
`7ADB72E8-D4BE-4538-99F4-09A0127D4FC8` ("[MCP-TEST] Full options event (updated)") is a
weekly recurring event still in **Personal**. It cannot be removed via the MCP (CalDAV
limitation). Delete it in the Calendar app UI.

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

- **Set up a test harness (HIGH PRIORITY — every bug this session was in testable TS).**
  The AppleScript itself can't run without a Mac + the live apps, but the TypeScript layer
  that *generates* and *parses* it is pure and unit-testable — and that's exactly where the
  bugs were (shell/AS escaping, date formatting, delimiter parsing). Plan:
  - Add a runner: `vitest` (or `node --test`) + `ts` support; `npm test` script.
  - **Refactor for testability:** extract the pure pieces so they don't require `osascript`.
    Make `escAS`, `isoToAppleScriptDate`, `parseReminders`, `parseEvents`, and the
    script-builder strings injectable/exported (e.g. split "build script" from "exec script"
    so tests assert on the generated AppleScript without running it).
  - **Regression tests for the bugs found 2026-06-03:**
    - Reminder name/body/list/searchTerm with apostrophes (`Mom's`), double quotes,
      backslashes → generated script is shell-safe (heredoc) and AS-escaped; no `\'`.
    - `isoToAppleScriptDate` round-trips ISO + `Date` without UTC drift; handles already-AS
      date strings.
    - `parseReminders` / `parseEvents` handle `§§§` / `§REC§` delimiters, `missing value`,
      empty recurrence, newline restoration.
    - `deleteEvent` returns OK / NOTFOUND / PERSISTED branches map to the right outcomes.
  - **Optional live/integration tier:** a separate, opt-in suite (env-gated, `TEST_LIVE=1`)
    that exercises the real MCP against a dedicated throwaway list/calendar and cleans up
    after itself — mirrors the manual matrix in this file. Keep it out of the default
    `npm test` so CI/non-Mac runs stay green.
  - Wire `npm test` into the workflow note in CLAUDE.md (build + test before restart).
- **After restart:** run the 4 verification steps above; update this file with results.
- **Tool descriptions (`index.ts`):** `get_reminders` description still says "Returns flagged,
  recurrence, dueDate, priority" and the create/update schemas still list `recurrenceRule` for
  reminders. Reminders have no recurrence — consider trimming these from the schema to stop
  advertising a no-op field. (Left as-is this session to avoid touching the live schema mid-audit.)
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
