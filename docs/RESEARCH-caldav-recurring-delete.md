# Research: CalDAV / Google recurring-event deletion via macOS Calendar

**Date:** 2026-06-03
**Question:** Why does deleting a recurring event via AppleScript fail on CalDAV/Google-backed
calendars, and what's the most reliable way to manage recurring Google events from a local
macOS tool (this Node/TS MCP)?
**TL;DR:** It's not a bug we can patch in AppleScript — it's a structural limitation. The real
fix is to move the **Calendar** half of this MCP off AppleScript and onto **EventKit** (a small
Swift helper the Node server shells out to). EventKit is the API Calendar.app itself uses, it
unifies iCloud + Google-via-CalDAV + local behind one interface, and it exposes the
`span` (this-occurrence vs all-future) semantics that AppleScript simply lacks.

---

## 1. Root cause — why AppleScript can't delete a recurring CalDAV/Google series

A recurring event is stored as **one master event** carrying an RFC 5545 `recurrence` (RRULE)
and an `excluded dates` (EXDATE) list. Occurrences are not separate objects — Calendar
"date-tests" the master against the RRULE and skips anything in EXDATE.

- AppleScript `delete` on a recurring event maps to EventKit's **single-occurrence
  (`thisEvent`)** removal: it just appends that occurrence's start date to the master's
  `excluded dates`. Demonstrated by a before/after `properties of event` dump — the `id` and
  `recurrence` survive, only `excluded dates` grows.
  ([Keyboard Maestro forum](https://forum.keyboardmaestro.com/t/is-it-possible-to-use-km-to-delete-specific-occurrence-of-a-recurring-apple-calendar-event/31504))
- Calendar's AppleScript model **only exposes the first instance's start date**, so
  `delete (events whose start date is X)` for any later occurrence silently matches nothing.
  ([MacScripter](https://www.macscripter.net/t/delete-calendar-events/73819))
- On a **non-editable / "hosted elsewhere" calendar** (which is exactly what a CalDAV/Google
  calendar looks like to the local store), the delete either silently no-ops or throws
  EventKit **error -10025** ("Failed to delete event … An unexpected error occurred"). This
  also confirms Calendar.app scripting sits on top of **EventKit (EKEventStore)**.
  ([MacScripter #34/#35](https://www.macscripter.net/t/delete-calendar-events/73819))
- Even when a local delete lands, **Google regenerates the occurrence from the server-side
  master on the next sync** (users report events reappearing ~2s later), because the
  authoritative copy lives on Google, not on the Mac.
  ([Apple Community 254583951](https://discussions.apple.com/thread/254583951))
- Calendar's UI doesn't refresh after a scripted delete until quit/reopen, which makes people
  misdiagnose successes and failures.
  ([MacScripter #13/#15](https://www.macscripter.net/t/delete-calendar-events/73819))

This is why **local/iCloud calendars work** (EventKit owns the master, the series can be
removed) and **CalDAV/Google calendars don't** (master is non-local + server-authoritative).

## 2. AppleScript workarounds — none reliably delete a Google series

| Workaround | Verdict on CalDAV/Google |
|---|---|
| `delete (every event whose uid = X)` (what this MCP does) | **Fails** — silent no-op or -10025 |
| `delete theEvent` reference vs collection delete | **Fails** — same outcome, distinction irrelevant |
| Delete by index `delete event N of cal` | **Unverified**, no advantage reported |
| `set recurrence of theEvent to ""` then delete | **Unverified** — no source shows it clearing a Google series |
| Append to `excluded dates` / EXDATE | **Works — but only hides ONE occurrence**, never the series; list grows unbounded |
| `quit`/relaunch / `save` / `reload calendars` | **Cosmetic** — fixes stale display only, not the failed delete |
| System Events UI scripting | **Works but brittle**; the well-known robertfern script *explicitly skips recurring events* |

Bottom line from the practitioner threads (Nigel Garvey / MacScripter, Keyboard Maestro,
Dr. Drang / leancrew): **no pure-AppleScript approach reliably deletes a recurring series on a
Google/CalDAV calendar.** The reliable routes are all non-AppleScript: EventKit, an `.ics`
workaround, or the UI / Google web portal.
([leancrew "Repeated failure"](https://leancrew.com/all-this/2022/04/repeated-failure/),
[MacScripter](https://www.macscripter.net/t/delete-calendar-events/73819))

→ The honest-error behavior already added to `deleteEvent` (throw instead of false success)
is the correct interim behavior given this.

## 3. The three real backends, compared

### A. Apple EventKit (Swift/Obj-C) — **recommended**
- `EKEventStore.remove(_:span:commit:)` with `EKSpan.thisEvent` (one occurrence) or
  `EKSpan.futureEvents` (this + all following) is the **documented, supported** way to delete
  recurring events — the same mechanism behind Calendar.app's "This Event / All Future Events"
  sheet. ([Apple: remove(_:span:)](https://developer.apple.com/documentation/eventkit/ekeventstore/1615882-remove))
- Routes through the **same local calendar agent** as Calendar.app, so it should avoid the
  "succeeds-but-regenerates" CalDAV failure. *(Strong inference + corroborated by multiple
  EventKit-based MCPs shipping occurrence-level delete — but not stated verbatim in an Apple
  doc. Worth one empirical test before fully committing; see §5.)*
- **One API for all backends** — iCloud, Google-via-CalDAV, Exchange, local — and free
  account-type routing via `EKCalendar.source → EKSource.title`/`sourceType` ("iCloud",
  "Gmail", …). This collapses the "route by account" problem to reading a property.
  ([EKSource](https://developer.apple.com/documentation/eventkit/eksourcetype))
- **Cost:** modern macOS (Sonoma 14+) requires **Full Calendar Access** (TCC), and the helper
  binary must ship the `NSCalendarsFullAccessUsageDescription` Info.plist key or the request
  *silently fails*. For an always-on Mac mini this is a one-time grant (pre-authorize via a
  `launchd --setup` step). ([Accessing Calendar w/ EventKit](https://developer.apple.com/documentation/EventKit/accessing-calendar-using-eventkit-and-eventkitui))
- **Node integration:** no first-party npm. Two proven patterns: a native N-API addon
  (`eventkit-node`) or — more common for MCPs — a small **compiled Swift CLI that returns JSON**
  which the Node server spawns.

### B. Google Calendar REST API v3 — cleanest for Google specifically
- `events.delete(calendarId, eventId=masterId)` removes the **whole series in one call** and
  works reliably (no CalDAV problem). Cancel one instance via `events.instances` →
  `status:"cancelled"` → `events.update`. "This and following" = trim master RRULE `UNTIL` +
  `events.insert` a new series. ([Recurring events](https://developers.google.com/workspace/calendar/api/guides/recurringevents),
  [Events: delete](https://developers.google.com/workspace/calendar/api/v3/reference/events/delete))
- **Auth (one-time):** Cloud project → enable Calendar API → OAuth consent screen (add self as
  test user) → **Desktop-app** OAuth client → loopback (`127.0.0.1:port`) browser flow →
  store refresh token. Scope `calendar.events` is enough. Use **user OAuth, not a service
  account** (service accounts can't reach a personal gmail.com calendar). `googleapis` npm,
  `access_type:"offline"` to get the refresh token.
  ([OAuth for desktop apps](https://developers.google.com/identity/protocols/oauth2/native-app),
  [scopes](https://developers.google.com/workspace/calendar/api/auth))
- **Frictions:** while the consent screen is in **Testing**, refresh tokens **expire every 7
  days** — click "Publish app" (production) to get long-lived tokens (verification not required
  for personal single-user use). Only covers **Google** calendars, not iCloud/local.
- **Prior art to borrow:** [`nspady/google-calendar-mcp`](https://github.com/nspady/google-calendar-mcp)
  (~1.1k stars) is the de-facto standard and already does multi-account + this exact auth flow.
  Google also now ships an official remote MCP for Calendar (managed OAuth, no local token).

### C. Direct CalDAV against Google — **not worth it**
- Delete series = HTTP `DELETE` on the resource; delete one occurrence = `PUT` an updated
  iCalendar body with an added `EXDATE`. Same OAuth2 cost as REST, but you hand-assemble
  iCalendar/EXDATE and inherit Google's recurrence-exception quirks. Lower-level, **not more
  reliable**. Best Node lib is [`tsdav`](https://github.com/natelindev/tsdav) (has a Google
  CalDAV quickstart). Only compelling if you want one protocol spanning iCloud + Google with no
  per-provider code — which EventKit already gives you, better.

## 4. Recommendation for this MCP (mostly-Google, some iCloud)

**Move the Calendar half from AppleScript → EventKit (Swift CLI). Keep Reminders on
AppleScript.** Rationale:

- EventKit is **one backend that covers all your calendars** (Google-via-CalDAV + iCloud +
  local), fixes the recurring-delete failure via `span`, fixes recurring-event *expansion*
  (AppleScript returns the master instead of occurrences), and gives account-type routing for
  same-named calendars for free via `EKSource`. A hybrid "AppleScript + bolt-on Google REST API"
  is **more** moving parts for **less** coverage.
- **Reminders gains little from EventKit** — keep the (now heredoc-fixed) AppleScript executor.
- **Don't hand-roll it.** Borrow from / adopt one of:
  - [`PsychQuant/che-ical-mcp`](https://github.com/PsychQuant/che-ical-mcp) — mature native
    Swift+EventKit MCP; already has source disambiguation (`calendar_source`), occurrence-level
    recurring delete/update (`span`/`occurrence_date`), batch ops, undo/redo, and a
    `launchd --setup` TCC pre-auth flow for an always-on Mac. Closest drop-in reference.
  - [`EgorKurito/apple-calendar-mcp`](https://github.com/EgorKurito/apple-calendar-mcp) —
    simpler TS-shell → Swift-CLI → EventKit; its README is literally a thesis on the
    AppleScript recurring-expansion failure. Best to port the *pattern* into our own server.
- **Only add Google REST (nspady) as a second, independent MCP** if you later need
  Google-specific richness that CalDAV-through-macOS can't do: attendee RSVP, cross-calendar
  free/busy, server-side notifications.

Architecture sketch:
```
index.ts (MCP)
 ├─ Reminders  → applescript-executor.ts (osascript, heredoc)   [keep]
 └─ Calendar   → eventkit-bridge (spawn Swift CLI → EventKit JSON) [new]
                   • list_calendars     → EKSource gives account type
                   • get/search_events  → predicateForEvents (correct recurrence expansion)
                   • create/update_event
                   • delete_event {span: thisEvent | futureEvents}  ← fixes the bug
```

## 5. Honest caveats / what to verify before committing
- The specific claim "EventKit deletes a recurring **Google** series where AppleScript fails"
  is strong inference (corroborated by EventKit-based MCPs shipping the feature) but not stated
  in an Apple doc. **Cheap test:** before porting, build a ~30-line Swift snippet calling
  `remove(event, span:.futureEvents)` on the lingering `7ADB72E8…` test event in *Personal*
  and confirm it actually disappears and stays gone after sync.
- TCC Full Calendar Access must be granted to the helper binary (bundle + Info.plist key);
  plan the `launchd` pre-auth for the Mac mini.
- Google REST testing-mode refresh tokens expire after 7 days unless the app is "published."

---

### Sources
- MacScripter — Delete calendar events: https://www.macscripter.net/t/delete-calendar-events/73819
- MacScripter — Delete old Calendar events: https://www.macscripter.net/t/delete-old-calendar-events/76325
- Keyboard Maestro forum — delete occurrence of recurring event: https://forum.keyboardmaestro.com/t/is-it-possible-to-use-km-to-delete-specific-occurrence-of-a-recurring-apple-calendar-event/31504
- leancrew — Repeated failure: https://leancrew.com/all-this/2022/04/repeated-failure/
- Apple — EKEventStore.remove(_:span:commit:): https://developer.apple.com/documentation/eventkit/ekeventstore/1615882-remove
- Apple — Accessing Calendar using EventKit: https://developer.apple.com/documentation/EventKit/accessing-calendar-using-eventkit-and-eventkitui
- Apple — EKSourceType / EKCalendar.source: https://developer.apple.com/documentation/eventkit/eksourcetype
- Apple Community — recurring event won't delete: https://discussions.apple.com/thread/254583951
- Google — Recurring events guide: https://developers.google.com/workspace/calendar/api/guides/recurringevents
- Google — Events: delete: https://developers.google.com/workspace/calendar/api/v3/reference/events/delete
- Google — OAuth 2.0 for iOS & Desktop Apps: https://developers.google.com/identity/protocols/oauth2/native-app
- Google — Choose Calendar API scopes: https://developers.google.com/workspace/calendar/api/auth
- Google — CalDAV v2 guide: https://developers.google.com/workspace/calendar/caldav/v2/guide
- tsdav (Node CalDAV): https://github.com/natelindev/tsdav
- nspady/google-calendar-mcp: https://github.com/nspady/google-calendar-mcp
- PsychQuant/che-ical-mcp: https://github.com/PsychQuant/che-ical-mcp
- EgorKurito/apple-calendar-mcp: https://github.com/EgorKurito/apple-calendar-mcp
- Omar-V2/mcp-ical: https://github.com/Omar-V2/mcp-ical
- eventkit-node: https://github.com/dacay/eventkit-node
