# apple-reminders-mcp — Project Context

## What this is
MCP server exposing Apple Reminders and Apple Calendar (both via a spawned Swift **EventKit** CLI),
plus Apple Mail (via AppleScript/osascript). Compiled TypeScript → `dist/`, runs as a stdio MCP
server.

**Reminders moved AppleScript → EventKit on 2026-06-04.** The AppleScript Reminders path was deleted.
Reason: reading ~339 reminders via AppleScript cost ~37s (each reminder needed per-item Apple Events —
`properties of rem` ~20s + `name of container of rem` ~14s + the `whose completed` predicate), blowing
the 28s timeout. The "timeout == iCloud sync" assumption in the old catch block was wrong and
misdirected diagnosis for a whole morning. EventKit's `fetchReminders(matching:)` is ONE local-store
query with no per-item Apple Event — effectively instant. Mail remains AppleScript (that's the only
osascript path left).

## Critical rule before writing any AppleScript
**Always read the relevant dictionary doc before writing or modifying AppleScript for either app.** The object models differ significantly — Calendar does NOT support `properties of cal` (AppleEvent -10000), Reminders does support `properties of rem`. Assuming one app's structure mirrors the other has already caused bugs.

- Reminders dictionary: `docs/reminders-dictionary.md`
- Calendar dictionary:  `docs/calendar-dictionary.md`
- Mail dictionary:      `docs/mail-dictionary.md`

## Source layout
```
src/
  reminders-executor.ts     — Reminders CRUD + search + writes; thin wrapper that spawns eventkit-cli
  reminders-util.ts         — pure Reminders helpers: CLI arg-builders, normalizeTagsInput, parseCliJson (unit-tested)
  calendar-executor.ts      — Calendar CRUD + search; thin wrapper that spawns eventkit-cli
  eventkit-util.ts          — pure Calendar/EventKit helpers: CLI arg-builders + parseCliJson (unit-tested)
  eventkit-cli/             — Swift EventKit CLI (Calendar + Reminders): main.swift, Info.plist,
                              build-eventkit.sh, verify.sh (build/ is gitignored).
                              RemindersDB.swift  — read-only SQLite enrichment (flagged/tags/subtasks/sections; needs FDA)
                              RemindersPrivate.{m,h} — PRIVATE ReminderKit WRITE bridge (flagged/tags/subtasks/sections)
                              verify-reminders.sh / verify-enrichment.sh / verify-writes.sh — live checks
  mail-executor.ts          — Mail CRUD + search (AppleScript/osascript) — the only osascript path left
  mail-util.ts              — pure Mail helpers (re-uses escAS from applescript-util)
  applescript-util.ts       — now just escAS (shared by Mail). Reminders/Calendar parsers were
                              removed when those apps moved to EventKit.
  index.ts                  — MCP server, tool schemas, request routing
test/                       — vitest unit tests (excluded from tsc build; `npm test`)
dist/                       — compiled output (node dist/index.js)
docs/                       — AppleScript dictionaries (read before touching Mail AppleScript)
```

The pure (no-osascript, no-spawn) logic lives in `reminders-util.ts` + `eventkit-util.ts` (EventKit
CLI arg-builders) and `mail-util.ts` (Mail), so it's unit-testable without a Mac or the live apps. Add
a regression test whenever you touch the CLI arg-builders, parseCliJson, or the Mail escaping/parsers.

## Key constraints discovered through testing

### Reminders — now EventKit, NOT AppleScript (ported 2026-06-04)
`reminders-executor.ts` (was `applescript-executor.ts`, deleted) spawns the SAME Swift EventKit CLI
as Calendar. Reminder commands: `list-reminder-lists`, `get-reminders`, `search-reminders`,
`create-reminder`, `update-reminder`, `delete-reminder`.
- **Why the port:** the AppleScript path timed out reading the store. Measured live on a 339-reminder
  store: names-only enumeration 6.85s, but the MCP's actual query (`properties of rem` + `name of
  container of rem` + `whose completed` predicate, per reminder) ran 37s+ — past the 28s ceiling.
  Not iCloud sync (the old error message's claim); it was per-item Apple Event cost. EventKit's
  `fetchReminders(matching: predicateForIncompleteReminders(...))` is one local-store query, no
  per-item round-trip.
- **Access is a SEPARATE TCC grant from Calendar** — `requestFullAccessToReminders` /
  `NSRemindersFullAccessUsageDescription` (added to Info.plist alongside the Calendar keys; same
  signed binary serves both). The CLI requests only the grant the command needs (reminder commands →
  Reminders access, event commands → Calendar access). Same responsible-app rule as Calendar: granted
  to Terminal from a Terminal run, to Claude Desktop when the MCP spawns it. **From Claude's embedded
  shell EventKit is denied (exit 3) — live checks need a real Terminal or Claude Desktop holding the grant.**
- **`fetchReminders` is async** (unlike `events()` which is sync) — bridged with a DispatchSemaphore
  in the CLI, same pattern as `requestAccess`.
- **Expanded field surface (the upside of leaving AppleScript):** the `Reminder` type now exposes
  startDate, completionDate, remindMeDate (earliest absolute alarm), and url, in addition to the prior
  fields. Nil optionals are omitted from the CLI's JSON (not emitted as null).
- **flagged / tags / subtasks / sections — EventKit CAN'T, so we go around it (ported from RemCTL, MIT).**
  EventKit's public API exposes none of these four. They are reached two ways, both keyed on
  `ZCKIDENTIFIER`, which on this account EQUALS EventKit's `calendarItemIdentifier` (= our reminder
  `id`) — verified live 2026-06-04, so NO id translation is needed.
  - **READS — `src/eventkit-cli/RemindersDB.swift` (SQLite, `-lsqlite3`).** A best-effort read-only
    pass over the Reminders Core Data store enriches `get-reminders`/`search-reminders` with `flagged`,
    `tags`, `parentId`/`isSubtask`, and `section`. **Degrade, never fail:** any problem (no Full Disk
    Access, store/schema drift) ⇒ those fields are OMITTED (never `false`/`[]` — absent ≠ false), and
    the core EventKit read still returns every reminder. `--no-augment` skips the pass. The store is
    opened **plain read-only first** (sees the live `-wal`, so changes written moments ago are visible)
    with an `immutable=1` fallback. Section membership is a per-list JSON blob
    (`ZREMCDBASELIST.ZMEMBERSHIPSOFREMINDERSINSECTIONSASDATA`), NOT a column on the reminder.
  - **WRITES — `src/eventkit-cli/RemindersPrivate.{m,h}` (PRIVATE ReminderKit framework).** Commands
    `set-flagged`, `add-tags`, `add-subtask`, `assign-section` (MCP tools `set_reminder_flagged`,
    `add_reminder_tags`, `add_subtask`, `assign_reminder_section`). Flow: `REMObjectID` from
    `x-apple-reminderkit://REMCDReminder/<id>` → `REMStore fetchReminderWithObjectID` → change-item
    contexts → `REMSaveRequest saveSynchronouslyWithError`. **PRIVATE API risk:** no stable ABI; may
    break across macOS. Mitigated by `-weak_framework ReminderKit` + `rem_available()`/
    `respondsToSelector:` guards — an absent/changed framework yields a clean error and never crashes
    the binary or affects reads. Do NOT call these from a sandbox/notarization-sensitive context.
- **Full Disk Access (FDA) is a NEW operational requirement** for the SQLite reads (and
  `assign-section`'s existing-section lookup). It is a MANUAL grant (System Settings → Privacy &
  Security → Full Disk Access — NO Info.plist key triggers it), attributed to the responsible GUI app:
  Terminal.app for the CLI, **Claude Desktop** when the MCP spawns the binary (grant BOTH). Without it,
  reads still work but drop the four enrichment fields; writes still work (ReminderKit needs only the
  Reminders grant), except `assign-section` falls back to always-creating a section.
- **`#hashtag` tags are single tokens** — the `add_reminder_tags` input is normalized
  (`normalizeTagsInput` in reminders-util.ts) from array / CSV / stringified-array forms; tags are
  passed to the CLI comma-joined. Attribution + ported SQL/selectors: see `THIRD_PARTY_NOTICES`.
- **Verify scripts (run from a real Terminal with the grants):** `verify-reminders.sh` (EventKit
  CRUD + recurrence), `verify-enrichment.sh` (SQLite reads), `verify-writes.sh` (ReminderKit writes).
  A full Claude-Desktop MCP test prompt lives at `docs/mcp-desktop-test-prompt.md`.
- **Reminders DO support recurrence (corrected 2026-06-04).** Earlier notes claimed EventKit couldn't
  do it — wrong. `EKReminder` inherits `recurrenceRules` from `EKCalendarItem` (same as `EKEvent`), so
  the CLI reuses the SAME `parseRRULE`/`rruleString` helpers as Calendar. `get-reminders` emits a
  `recurrence` RRULE field when a rule is present; create/update accept `--recurrence`. **Caveat: a
  recurring reminder MUST have a due date** to anchor the recurrence — the CLI fails fast if
  `--recurrence` is given without a due date (mirrors Reminders.app, which won't repeat without a date).
  Empty `--recurrence` clears the rule on update.
- `id` is the `calendarItemIdentifier` (stable; used by update/delete via direct
  `calendarItem(withIdentifier:)` lookup — fast, no scan). List ids are real `calendarIdentifier`s.

### Calendar — now EventKit, NOT AppleScript (ported 2026-06-03, TRACK 2)
`calendar-executor.ts` no longer uses osascript. It spawns a small Swift **EventKit** CLI
(`src/eventkit-cli/main.swift` → `build/eventkit-cli`, built by `npm run build`). EventKit fixes
the two things AppleScript structurally could not do on this account's CalDAV/Google calendars.
**The AppleScript Calendar notes below are historical — they describe the old osascript path that
was replaced. The dictionary `docs/calendar-dictionary.md` only matters if you ever go back to
AppleScript; for the live path, edit the Swift CLI.**
- **Recurring-series delete now WORKS.** `delete-event` uses `EKEventStore.remove(span:.futureEvents)`
  and re-queries to confirm 0 occurrences remain. Verified live 2026-06-03 against a weekly series in
  the Google-backed `Personal` calendar (`verify.sh`): deleted and did NOT regenerate. (Old AppleScript
  reported success but the master persisted — that limitation is gone.)
- **Recurrence is expanded + serialized.** `get-events` uses `predicateForEvents`, returning each
  occurrence; the CLI serializes the first `EKRecurrenceRule` back to an RFC-2445 RRULE string
  (FREQ/INTERVAL/COUNT/UNTIL/BYDAY/BYMONTHDAY/BYMONTH/BYSETPOS) and parses RRULE on create/update.
- **`list_calendars` ids are now real.** EventKit populates `calendarIdentifier` (AppleScript returned
  `""` here). Note: calendar **names can be duplicated** on an account (the same title can appear more
  than once) — the CLI resolves a calendar by `.first{title==name}` so duplicate names are ambiguous;
  target by id if that ever bites (the TS interface still passes `calendarName`).
- **TCC (Full Calendar Access) is the operational gotcha.** The binary embeds
  `NSCalendarsFullAccessUsageDescription` and is `codesign --force --sign -` re-signed (build-eventkit.sh
  does both) — without that, access is denied silently. The grant is attributed to the **responsible GUI
  app**: from a user Terminal that's Terminal.app; when the MCP (inside Claude Desktop) spawns it, it's
  Claude Desktop. **From Claude's embedded shell EventKit is denied (exit 3, `{"error":…}`) — so every
  live data check needs the user at their own Terminal, or Claude Desktop holding the grant.**
- **CLI contract:** one JSON value to stdout per call; `{"error":"…"}` + nonzero exit on failure.
  `runCli` returns the error stdout and `parseCliJson` (in `eventkit-util.ts`) throws its message.
- Sync lockout / 28s timeout still applies (the Node side keeps the 28s `execFile` timeout).
- **Reminders now also uses this EventKit CLI** (ported 2026-06-04) — see the Reminders section above.
  Mail is the only remaining osascript path.

### Mail — AppleScript (osascript); Mail is now the ONLY osascript executor (TRACK 3, started 2026-06-03)
- **Always read `docs/mail-dictionary.md` before changing any Mail AppleScript.** Mail's object
  model differs from BOTH Reminders and Calendar: messages live in mailboxes which live in accounts;
  a message `id` is an INTEGER libraryID (unique in the local store); `message id` is the RFC
  Message-ID header. There is **no app-level "message id X" lookup**, so a single message is addressed
  by **mailbox + integer id** (`messages of theMailbox whose id is N`) — always pass the source
  mailbox (default Inbox). Source files: `src/mail-executor.ts` (heredoc osascript, like Reminders)
  and the pure/tested `src/mail-util.ts` (escAS reuse, `mailboxASExpr` resolver, §REC§/§§§ parsers,
  recipient builders).
- Output delimiters: records split on `§REC§`, fields on `§§§`, recipient lists join on U+0001
  (`ASCII character 1`) — commas are unsafe (display names contain them). Message body/content is the
  LAST field, so raw newlines survive with no encoding. Add a regression test to `test/mail-util.test.ts`
  whenever you touch escaping, the mailbox resolver, the parsers, or the recipient builders.
- `mailboxASExpr`: well-known names (Inbox/Sent/Drafts/Junk/Trash/Outbox) → the app-level unified
  mailbox property; `account`+`mailbox` → `mailbox "X" of account "Y"` (most specific). `list_mailboxes`
  enumerates top-level mailboxes per account (nested sub-mailboxes not recursed in v1).
- **IMAP lockout is the operational gotcha (worse than Reminders' iCloud sync).** Full-folder
  enumeration — `count of every message`, or a `whose` predicate evaluated across the mailbox — triggers
  bulk IMAP header prefetch and locks ALL Mail AppleScript for *minutes* (confirmed live 2026-06-03).
  **Rules baked into the executor (do not regress):** (1) NEVER `count of` a mailbox's messages — walk
  by index with `try … on error exit repeat` (`buildScanScript`). (2) `get_emails unreadOnly` and
  `search_emails` do NOT use a `whose` filter; they fetch a **date-scoped** batch (`dateFloorClause`,
  default `daysBack`=30) capped at a scan limit, then filter in TS (`filterMessages`). (3) `get_email`
  (and only it) fetches the body — runs at the 55s `BODY_TIMEOUT_MS`, list/mutate ops at 28s.
- `search_emails` matches **subject OR sender** but only over the recent/date-scoped batch (TS string
  ops, no body scan) — older matches need a larger `daysBack`. `get_email`/mark/move/trash/reply locate
  by `messages … whose id is N` (header-only folder scan — cheap, no body prefetch; add a date floor if
  it ever proves slow on a huge folder).
- **DONE — ALL 9 TOOLS PROD-VERIFIED LIVE (2026-06-03 session #4):** list_mailboxes, get_emails,
  get_email, search_emails (read); mark_email, move_email, trash_email, send_email, reply_to_email
  (mutating/sending). `send_email`/`reply_to_email` **send immediately** (visible:false, no draft).
  Full pass via a Cowork session, send-to-self: reads no longer lock up (bounded-scan fixes hold),
  body multi-line parsing + recipient/message-id parsing confirmed, apostrophes survive the send path
  (escAS), reply produces a real `Re:`, move/trash verified by re-query. See HANDOFF TRACK 3 live test #2.
- **Live-test #2 gotchas (don't regress / don't get tripped up):**
  - **`move_email` REASSIGNS the integer id** — a message moved between mailboxes comes back with a NEW
    id (the id is a per-mailbox libraryID). After a move, re-fetch from the destination to get the new
    id; the pre-move id is stale. Never reuse an id across a move.
  - **`"Sent"` (well-known unified) ≠ the account's `"Sent Messages"` mailbox.** Outbound mail (sent +
    reply copies) lands in **`Sent Messages`**; querying `mailbox:"Sent"` returns a different, older set
    and MISSES a just-sent message. To find a just-sent message, use `mailbox:"Sent Messages"` (+ account).
  - **A `send_email` triggers an immediate IMAP sync that briefly locks AppleScript** (~1–2 min of 28s
    timeouts observed right after a send). Give Mail ~60s after any send before the next Mail call.
  - **Send-to-self may not loop back to INBOX** (provider dedup / delivery lag) — verify a send via its
    `Sent Messages` copy, not by polling the Inbox.

### General
- Timeout is 28s for list/mutate ops (Mail's `get_email` body fetch uses 55s, `BODY_TIMEOUT_MS`);
  may need raising for enumeration on large datasets.
- **Reminders + Calendar both spawn the EventKit CLI** via `execFileAsync(eventkit-cli, args)` with
  `{ timeout: 28000, maxBuffer: 10MB }`. Args are an argv array (no shell) — no shell-escaping concern.
  Neither uses osascript anymore. **Mail is the only osascript path left** (`execAsync` heredoc).

## Workflow
After any source edit: `npm test` (vitest, runs without a Mac) + `npm run build` (now runs `tsc`
AND builds/signs the Swift CLI — needs `swiftc`; use `npm run build:ts` for a tsc-only check), then
restart Claude Desktop (MCP process doesn't hot-reload). The tests cover the pure layers
(`reminders-util.ts`, `eventkit-util.ts`, `mail-util.ts`); they don't exercise live EventKit,
AppleScript, or TCC, so a green suite + green build is the pre-restart bar. Live MCP behavior still
needs manual verification — and for the EventKit CLI specifically, run it from a real Terminal (TCC)
plus a Claude-Desktop-spawned check.

**First run of the Reminders port (2026-06-04) — grant the new TCC permission:** `npm run build`
rebuilds + re-signs the binary with the added `NSRemindersFullAccessUsageDescription`. The first
`get-reminders` from a Terminal will prompt for Reminders access — approve it. Then verify:
```
bash src/eventkit-cli/build-eventkit.sh list-reminder-lists
bash src/eventkit-cli/build-eventkit.sh get-reminders
```
`get-reminders` should return in well under a second (vs the 37s+ AppleScript hang). If it's denied
(exit 3), grant Reminders to the responsible app in System Settings → Privacy & Security → Reminders,
or `tccutil reset Reminders` to re-fire the prompt. Then restart Claude Desktop so the MCP picks up
the new binary, and confirm the grant is attributed to Claude Desktop too (spawn from the MCP).
