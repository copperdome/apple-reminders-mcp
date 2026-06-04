# apple-reminders-mcp — Session Handoff

Use this to resume development after a restart. Read this + CLAUDE.md before touching any code.

---

## ▶ Resuming in a new session (start here)

You're picking this up in a Cowork/Claude Code session on `~/apple-reminders-mcp`.
**Read context first:** this file + `CLAUDE.md` (auto-loads) + `docs/RESEARCH-caldav-recurring-delete.md`
(the EventKit/CalDAV research) + `docs/mail-dictionary.md` (before any Mail work).

### Current state — clean, committed, pushed. TRACK 1 + TRACK 2 DONE (prod-verified). TRACK 3 (Mail) is next.
- **Working tree is clean. Everything is committed and pushed** to `origin` =
  **`copperdome/apple-reminders-mcp`** (`upstream` = `dbmcco/apple-reminders-mcp`, no write access).
  Latest commit on `main`: **`dad136f`**. (Direct push to `main` is allowed — no PR flow here.)
- `npm test` → **31 green** (vitest; tests in `test/`, pure helpers in `src/applescript-util.ts`).
  `npm run build` → green. `dist/` is fresh. (Swift files in `src/eventkit-cli/` are outside `tsc`.)
- **2026-06-03 session #2 progress:**
  - TRACK 1 ✅ done (`1630c65`) — removed dead `id of cal` fallback in `getCalendars()`.
  - TRACK 2 step 1 (smoke test) ✅ **GO** (`c6611fe`/`7a589aa`) — EventKit deletes a Google
    recurring series where AppleScript can't; confirmed not-regenerated after sync. See TRACK 2 below.
- **2026-06-03 session #3 progress:**
  - TRACK 2 step 2 (full Swift CLI) ✅ **code-complete + builds/signs.** Wrote
    `src/eventkit-cli/main.swift` (6 subcommands → JSON) + `build-eventkit.sh`. Binary compiles,
    embeds the Info.plist, and codesigns cleanly. The no-TCC paths are verified from Claude's shell
    (usage guard emits `{"error":…}` exit 1; a data command hits the documented TCC denial → clean
    `{"error":…}` exit 3).
  - `list-calendars` ✅ **VERIFIED LIVE** (John's Terminal) — returns 13 calendars, **every one with a
    real `calendarIdentifier` UUID** (fixes the blank-id issue AppleScript had on this account) and
    correct `writable` flags. **Finding: duplicate calendar names** — "Negative Cutters" appears
    twice with different ids (`52409036…`, `91BA2B49…`). Name-based targeting (the current
    `calendarName` interface, and `calendar(named:)` = `.first{title==name}`) is therefore ambiguous
    for it. **Step-3 consideration:** with real ids now available, optionally allow targeting by id.
  - **FULL CLI ✅ VERIFIED LIVE** (John's Terminal, `bash src/eventkit-cli/verify.sh`):
    non-recurring create→search→update→delete clean; **recurring create → `get-events` expanded all
    4 occurrences each carrying `"recurrence":"RRULE:FREQ=WEEKLY;COUNT=4"` (RRULE round-trips) →
    delete (future span) → re-query returned `[]`.** That last line is the row AppleScript could
    never pass — EventKit deletes the Google recurring series and the honest re-query confirms gone.
    Dates round-trip as ISO-8601 UTC. **Step 2 complete.**
  - TRACK 2 step 3 (Node swap) ✅ **code-complete + integration-path verified** (`856137a`).
    `calendar-executor.ts` now `execFile`s the binary instead of osascript; class/types/`index.ts`
    handlers unchanged. New pure layer `eventkit-util.ts` (CLI arg-builders + `parseCliJson`) with 23
    tests (54 total green); `npm run build` now also builds/signs the Swift CLI (`build:ts` = tsc only).
    Verified end-to-end from Claude's shell as far as TCC allows: `import.meta.url` path resolution
    finds the binary, `execFile` spawns it, and the TCC-denied `{"error":…}` (exit 3) propagates
    cleanly through `runCli`→`parseCliJson`→thrown Error. Also CLAUDE.md's Calendar section was
    rewritten for EventKit (CLAUDE.md is gitignored → local-only).
  - **TRACK 2 ✅ DONE — PRODUCTION-VERIFIED in Claude Desktop** (post-restart, live MCP tools).
    Every Calendar tool green: list_calendars, get/search/create/update/delete_event, **and the
    recurring-series delete on Google-backed calendars**. Resolved the big open question: **Claude
    Desktop HOLDS Full Calendar Access, so the MCP-spawned eventkit-cli works in prod** (the TCC grant
    attributes to Claude Desktop and was granted there — separate from the Terminal grant). Confirmed
    fixes: iCloud sync lockout on global queries gone, update/delete work without calendarName, ISO-8601
    UTC dates + proper RRULE strings replace locale-dependent human-readable dates. **TRACK 2 closed.**
- **Loose ends:** (1) the old `[MCP-TEST]` recurring event `7ADB72E8-…` in *Personal* — John may
  still need to delete it in the Calendar UI (or just delete it with the new EventKit smoke CLI:
  `bash src/eventkit-cli/smoke.sh delete 7ADB72E8-D4BE-4538-99F4-09A0127D4FC8` from Terminal — it
  should now work via EventKit). The throwaway `[EK-SMOKE]` event from the go/no-go is already gone.

### Next work — 3 tracks, IN ORDER. Each track: code → `npm test && npm run build` → commit → push.

**TRACK 1 — Remove confirmed-dead fallback code (small warmup, do first). ✅ DONE 2026-06-03**
(commit `1630c65`) Removed the `id of cal` fallback from `getCalendars()`, kept the
`calendarIdentifier` try/catch, documented why ids come back blank. 31 tests green, build green.

**TRACK 2 — EventKit Calendar port (the big one).** Read `docs/RESEARCH-caldav-recurring-delete.md`
fully first. Conclusion there: recurring-series delete on CalDAV/Google is NOT fixable in
AppleScript (structural); the fix is a small Swift **EventKit** CLI the Node server spawns.
Sequence:
  1. **Smoke test FIRST (go/no-go): ✅ DONE — GO (2026-06-03, commit `c6611fe`).** Built
     `src/eventkit-cli/` (smoke-test.swift + Info.plist + smoke.sh). Ran from Terminal against a
     fresh 8-occurrence weekly series in the Google-backed *Personal* calendar:
     `remove(span:.futureEvents)` removed the whole series and it did NOT regenerate after sync
     (EventKit re-query → 0, AppleScript MCP search → []). **EventKit port greenlit.** Two findings
     baked into the smoke test: (a) AppleScript `uid` == EventKit `calendarItemIdentifier` (match on
     that first, not external/eventIdentifier); (b) the binary needs `NSCalendarsFullAccessUsage-
     Description` embedded via linker `-sectcreate` AND a `codesign --force --sign -` re-sign to
     *bind* it, and must be run from the user's own Terminal (TCC attributes to the responsible GUI
     app; from Claude's shell it's denied silently). `smoke.sh` handles build+sign.
  2. **Build the full Swift CLI. ✅ DONE + VERIFIED LIVE 2026-06-03 session #3 (`verify.sh`).**
     `src/eventkit-cli/main.swift` implements all 6 subcommands below; `build-eventkit.sh` compiles +
     signs it to `build/eventkit-cli`; `verify.sh` runs the full live matrix and passed.
     Original concrete plan (now implemented — kept for reference):
     - **New file `src/eventkit-cli/main.swift`** (keep `smoke-test.swift` as-is for reference, or
       delete once the CLI subsumes it). Reuse the proven scaffolding from `smoke-test.swift`:
       `requestFullAccessToEvents` via semaphore, the `matches()` helper (uid ==
       `calendarItemIdentifier` first), `searchWindow()`, and `sourceTypeName()`.
     - **Subcommands → emit JSON to stdout** (one JSON value per call; errors as
       `{"error":"…"}` to stdout + nonzero exit). Match the existing TS types exactly:
       - `list-calendars` → `[{name,id,description,writable}]` (CalendarInfo). Use
         `calendar.calendarIdentifier` for `id` (EventKit DOES populate it, unlike AppleScript —
         the smoke `list` confirmed real ids), `allowsContentModifications` for `writable`. Bonus:
         also expose `source`/`sourceType` (EKSource) later if we extend CalendarInfo.
       - `get-events --calendar <name> --start <iso> --end <iso>` → `[CalendarEvent]`. Use
         `predicateForEvents` (this fixes recurrence expansion — smoke test showed all 8 occurrences).
       - `search-events --term <text> [--calendar <name>] [--start/--end]` → `[CalendarEvent]`
         (filter predicate results by title/notes containing term, case-insensitive).
       - `create-event --calendar <name> --summary … --start … --end … [--all-day] [--location]
         [--notes] [--url] [--recurrence <RRULE>]` → `{"uid": calendarItemIdentifier}`. Parse RRULE
         into `EKRecurrenceRule` (or set via `event.recurrenceRules`).
       - `update-event --uid <id> [same optional fields]` → `{"uid": …}`. Resolve event by uid
         (calendarItemIdentifier), apply changes, `save(span:.futureEvents)` if recurring.
       - `delete-event --uid <id> [--span this|future]` → `{"deleted":true}` or honest error if the
         re-query still finds it. Default span: `.futureEvents` when recurring, else `.thisEvent`.
     - **Map `CalendarEvent` fields** (src/calendar-executor.ts:16): `uid`=calendarItemIdentifier,
       `summary`=title, `description`=notes, `startDate`/`endDate` as ISO 8601, `allDay`=isAllDay,
       `location`, `status` (map EKEventStatus → "confirmed"/"tentative"/"cancelled"/"none"),
       `recurrence` (serialize first EKRecurrenceRule back to an RRULE string — or omit v1 and
       leave recurrence read as best-effort), `calendar`=calendar.title.
     - **Argument parsing:** keep it dumb — `--flag value` pairs into a `[String:String]` dict; no
       arg-parsing lib. ISO date parsing via `ISO8601DateFormatter` (the existing TS sends ISO; see
       `isoToAppleScriptDate` for the current format — but the CLI takes raw ISO, no AppleScript date).
     - **Build/sign:** generalize `smoke.sh` into a build step that compiles `main.swift` to
       `src/eventkit-cli/build/eventkit-cli`, embeds `Info.plist` via linker `-sectcreate`, and
       `codesign --force --sign -` re-signs it. The Node side spawns this binary by absolute path.
       Decide where the binary lives at runtime (ship-built in repo? build on `npm run build`? a
       `postbuild` step?) — simplest: commit a `build-eventkit.sh`, run it in `npm run build`, and
       have CalendarExecutor resolve the binary path relative to `__dirname`.
     - **Verify (needs John at Terminal) — DO THIS NEXT, before the Node swap.** From your own
       Terminal.app (TCC denies from Claude's shell). First run pops the Full Calendar Access dialog —
       click Allow. Each command prints one JSON value to stdout (`{"error":…}` + nonzero exit on
       failure). Run the build script with a subcommand to build-then-run in one step:
       ```
       cd ~/apple-reminders-mcp
       bash src/eventkit-cli/build-eventkit.sh list-calendars | jq        # real ids + writable
       D=src/eventkit-cli/build/eventkit-cli
       $D get-events --calendar Personal --start 2026-06-01T00:00:00Z --end 2026-07-01T00:00:00Z | jq
       $D create-event --calendar Personal --summary "[EK-TEST] roundtrip" \
          --start 2026-06-10T15:00:00Z --end 2026-06-10T16:00:00Z | jq      # note the uid
       $D search-events --term EK-TEST --calendar Personal | jq
       $D update-event --uid <UID> --summary "[EK-TEST] updated" --location "Desk" | jq
       $D delete-event --uid <UID> | jq                                     # {"deleted":true}
       # Recurring: create with --recurrence "FREQ=WEEKLY;COUNT=4", get-events to see 4 occurrences,
       # then delete-event --uid <UID> (default span futureEvents) and re-get → 0. This is the row
       # AppleScript could never pass.
       ```
       Report back: do real `id`s come through, does the recurring create/delete round-trip cleanly,
       and does `recurrence` serialize back to a sane RRULE on get-events?
     - **⚠️ Open question to settle during step 2/3 (don't skip):** when the Node server *inside
       Claude Desktop* spawns this binary, the TCC grant is attributed to **Claude Desktop**, not
       Terminal. Confirm Claude Desktop has (or can be granted) Full Calendar Access so the spawned
       binary works in production — test BEFORE finishing the step-3 Node swap, or the live MCP path
       will be denied silently the same way Claude's shell is.
  3. **Swap CalendarExecutor → EventKit CLI. ✅ DONE 2026-06-03 (`856137a`) + PROD-VERIFIED.**
     `calendar-executor.ts` `execFile`s the binary; pure helpers in `eventkit-util.ts` (arg-builders +
     `parseCliJson`) with 23 tests; `npm run build` builds+signs the CLI. Class/types/`index.ts`
     handlers unchanged. Live-verified in Claude Desktop after restart — all Calendar tools green,
     including recurring delete. Claude Desktop holds Full Calendar Access (grant is separate from the
     Terminal grant approved during `verify.sh`). **TRACK 2 fully closed — nothing left here.**
  4. Reference impls: `PsychQuant/che-ical-mcp` (mature), `EgorKurito/apple-calendar-mcp` (simple).
  5. **Keep Reminders on AppleScript — do NOT touch `applescript-executor.ts` for this.**

  **TCC gotchas already solved (don't rediscover):** (a) AppleScript `uid` ==
  `EKEvent.calendarItemIdentifier` — match on that, not external/eventIdentifier; (b) the binary
  MUST embed `NSCalendarsFullAccessUsageDescription` (linker `-sectcreate __TEXT __info_plist`) AND
  be re-signed with `codesign --force --sign -` to *bind* the plist, or TCC denies silently; (c) the
  grant is attributed to the *responsible GUI app*, so it must be granted once from John's own
  Terminal — from Claude's embedded shell EventKit access is denied synchronously with no dialog,
  which means **every live EventKit verification step needs John at the machine.** When the Node
  server (inside Claude Desktop) spawns the binary, the grant will be attributed to Claude Desktop —
  **open question to verify early: does Claude Desktop already have / can it be granted Full Calendar
  Access so the spawned binary works in production?** If not, the binary may need to run such that it
  carries its own grant. Test this BEFORE finishing the Node swap.

**TRACK 3 — Mail suite (net-new). ◀ IN PROGRESS — code-complete, NOT yet live-verified (2026-06-03).**
All 9 tools implemented across two pushed increments:
  - **Step 1 (read), commit `2f71213`:** `list_mailboxes`, `get_emails`, `get_email`, `search_emails`.
  - **Step 2 (mutating/sending):** `mark_email`, `move_email`, `trash_email`, `send_email`,
    `reply_to_email`.
New pure layer `src/mail-util.ts` (escAS reuse, `mailboxASExpr` resolver, §REC§/§§§ parsers,
`normalizeAddresses`/`buildRecipientLines`) with regression tests in `test/mail-util.test.ts` (80 total
green). `src/mail-executor.ts` uses the heredoc form (`osascript <<'APPLESCRIPT'`) + `escAS()`, exactly
like Reminders; wired into `index.ts` (import, construct, schemas, cases) like `CalendarExecutor`.
Key design (see CLAUDE.md Mail section): messages addressed by **mailbox + integer id** (no app-level
id lookup); `search_emails` matches subject/sender only (no body scan → no IMAP-download timeout);
recipient lists join on U+0001; `send_email`/`reply_to_email` **send immediately** (no draft).
**Live test #1 (2026-06-03) — partial PASS then IMAP lockout. Fixes applied; RE-TEST NEEDED.**
Results: `list_mailboxes` ✅ (4 accounts, 47 mailboxes). `get_emails` (Inbox, limit 5) ✅ correct shape.
Then `get_emails unreadOnly`, `search_emails`, `get_email`, `mark_email` all ❌ TIMEOUT — Mail locked ALL
AppleScript for *minutes* (far worse than Reminders' 30–60s iCloud lockout). send/move/trash/reply not
reached. **Root cause: full-folder enumeration triggering bulk IMAP header prefetch.** Specifically
`count of theMessages` (forces materializing every message) and the `whose read status is false` /
`whose subject contains … or sender contains …` predicates (evaluated across the whole folder).

**Fixes (this commit) — NOT yet live-verified, re-test required:**
  1. **No more `count of` on the folder.** All list scans walk messages BY INDEX with a try/exit-repeat
     terminator (`buildScanScript` in mail-executor.ts) — we never ask Mail how many messages exist.
  2. **`unreadOnly` + `search_emails` no longer use a `whose` predicate.** They fetch a bounded,
     **date-scoped** batch of summaries (default `daysBack`=30, via `dateFloorClause`) capped at a scan
     limit (unread 100 / search 200), then filter in TypeScript (`filterMessages`). Search still matches
     subject OR sender (now cheap TS string ops) and no longer scans bodies. New `daysBack` param on both
     tools widens the window when needed.
  3. **get_email body fetch timeout raised to 55s** (`BODY_TIMEOUT_MS`); list/mutate ops stay at 28s.
  Pure helpers `dateFloorClause` + `filterMessages` added with tests (87 total green).
  **Known limitation (documented in tool descriptions):** unreadOnly/search only see recent messages
  within `daysBack` (and the scan cap) — older matches need a larger `daysBack`.

**◀ NEXT: re-run live test #1.** Restart Claude Desktop (new dist), then, giving Mail ~60s to settle
between calls: `list_mailboxes` → `get_emails` (Inbox, limit 5) → `get_emails {unreadOnly:true}` →
`search_emails {searchTerm}` → `get_email {messageId}` → `mark_email` → `move_email`/`trash_email` on a
throwaway → `send_email` + `reply_to_email` to a throwaway address. Watch for: (a) does the bounded scan
actually avoid the lockout, (b) get_emails ordering (is `item 1` the newest?), (c) `account of mailbox`
on the unified Inbox, (d) whether the **id-based lookup** in get_email/mark/move/trash/reply
(`messages … whose id is N`, still a folder scan but header-only — no body prefetch) is fast enough on a
large folder, or whether it ALSO needs a date floor, (e) headless `reply`+`send` (visible:false).

### Environment reality (don't fight these)
- **The MCP runs inside Claude Desktop; `dist/` changes need a Desktop restart to go live** (no
  hot-reload). The live `apple-apps` MCP tools (`mcp__apple-apps__*`) are only reachable from a
  **local Cowork session**, not a remote/scheduled one.
- **This work cannot run as a remote/scheduled routine.** A remote session has no local filesystem,
  no `osascript`, no `apple-apps` MCP, and can't restart Desktop or dismiss permission dialogs.
  Code-writing + `npm test` + `npm run build` + commit/push CAN run autonomously; every **live**
  verification step needs you (restart + macOS permission dialogs).
- To re-verify live after a build: restart Claude Desktop, then run the relevant tool calls (the
  apple-apps tools are deferred — load via ToolSearch `select:mcp__apple-apps__…`).

---

## Reference — 2026-06-03 audit (bugs found & fixed; all now verified live)

History kept for context. This audit verified the prior session's fixes against the live MCP,
found that two did NOT work, found a new critical bug, and fixed everything fixable. All of the
below are now fixed AND confirmed live (see "Post-restart verification").

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

The primary next work is the **3 tracks in "▶ Resuming… start here"** above (dead-code removal →
EventKit port → Mail suite). This section is the **lower-priority backlog** that doesn't fit those.

- ✅ **DONE this session:** test harness (vitest, 31 green; pure helpers extracted to
  `src/applescript-util.ts`), tool-description/schema cleanup (phantom reminder recurrence removed),
  and the full post-restart live verification. Nothing left to do on these.
- **Backlog — pure-script-string assertions.** The tests cover the escaping/date/parse helpers but
  NOT the generated AppleScript text itself (the script-builder strings are still inlined in the
  executor methods). To assert "the create_reminder script is shell-safe / contains no `\'`", first
  split each "build script" string out of its `async` method into a pure exported builder, then test
  the string. Low value now that escaping is centralized + tested — but it's the remaining gap.
- **Backlog — optional live/integration test tier** (env-gated `TEST_LIVE=1`, throwaway
  list/calendar, self-cleaning) mirroring the manual matrix. Keep it out of default `npm test` so
  non-Mac/CI runs stay green.
- **Note for the EventKit track:** EventKit also gives account-type routing via `EKSource` and fixes
  recurring-event expansion, not just deletion — worth exposing once the port lands.
