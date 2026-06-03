// EventKit recurring-delete smoke test (TRACK 2 go/no-go).
//
// Purpose: empirically confirm the one claim the research doc could NOT find in an
// Apple doc — that EventKit's remove(event, span: .futureEvents) actually deletes a
// recurring series on a CalDAV/Google-backed calendar, where AppleScript only no-ops.
// See docs/RESEARCH-caldav-recurring-delete.md §5.
//
// Build:  swiftc -O -o /tmp/ek-smoke src/eventkit-cli/smoke-test.swift
// Run:    /tmp/ek-smoke list
//         /tmp/ek-smoke find   <uid>
//         /tmp/ek-smoke delete <uid>
//
// The FIRST run triggers the macOS Full Calendar Access (TCC) permission dialog —
// a human must approve it at the machine. A CLI binary has no Info.plist, so the
// grant is attributed to the binary path; rebuilding to the same path keeps it.
//
// Smoke-test sequence (human-in-the-loop):
//   1. Create a throwaway WEEKLY recurring event via the MCP in a Google calendar
//      (e.g. "Personal"); note its uid from the create_event result.
//   2. /tmp/ek-smoke find <uid>   → should list one or more occurrences (access works).
//   3. /tmp/ek-smoke delete <uid> → removes the master with span .futureEvents.
//   4. /tmp/ek-smoke find <uid>   → should now find ZERO occurrences, AND it should
//      stay gone after the next Google sync (AppleScript could never achieve this).

import EventKit
import Foundation

let store = EKEventStore()

// MARK: - Access (synchronous wait via semaphore; CLI has no run loop otherwise)

func requestAccess() -> Bool {
    let sem = DispatchSemaphore(value: 0)
    var granted = false
    var reqError: Error?
    store.requestFullAccessToEvents { ok, err in
        granted = ok
        reqError = err
        sem.signal()
    }
    sem.wait()
    if let reqError = reqError {
        FileHandle.standardError.write("access error: \(reqError)\n".data(using: .utf8)!)
    }
    return granted
}

// Search window: 1 year back, 2 years forward. The predicate expands recurring
// events into individual occurrences, so a series shows up as multiple matches.
func searchWindow() -> (Date, Date) {
    let now = Date()
    let cal = Calendar.current
    let start = cal.date(byAdding: .year, value: -1, to: now)!
    let end = cal.date(byAdding: .year, value: 2, to: now)!
    return (start, end)
}

// Match an AppleScript "uid" against EventKit. Empirically (dump of an event
// created via the AppleScript MCP) the AppleScript `uid` equals EventKit's
// `calendarItemIdentifier` — NOT calendarItemExternalIdentifier (the iCal UID)
// and NOT eventIdentifier. Check that first; keep the others as fallbacks.
func matches(_ ev: EKEvent, _ uid: String) -> Bool {
    if ev.calendarItemIdentifier == uid { return true }
    if ev.calendarItemExternalIdentifier == uid { return true }
    if ev.eventIdentifier == uid { return true }
    return false
}

func occurrences(forUid uid: String) -> [EKEvent] {
    let (start, end) = searchWindow()
    let predicate = store.predicateForEvents(withStart: start, end: end, calendars: nil)
    return store.events(matching: predicate).filter { matches($0, uid) }
}

// MARK: - Commands

func cmdList() {
    let cals = store.calendars(for: .event)
    print("Found \(cals.count) event calendar(s):")
    for c in cals {
        let src = c.source
        print("  - \(c.title)")
        print("      source: \(src?.title ?? "?")  type: \(sourceTypeName(src?.sourceType))")
        print("      allowsModify: \(c.allowsContentModifications)  id: \(c.calendarIdentifier)")
    }
}

func sourceTypeName(_ t: EKSourceType?) -> String {
    switch t {
    case .some(.local): return "local"
    case .some(.exchange): return "exchange"
    case .some(.calDAV): return "calDAV"
    case .some(.mobileMe): return "mobileMe/iCloud"
    case .some(.subscribed): return "subscribed"
    case .some(.birthdays): return "birthdays"
    default: return "unknown"
    }
}

// Diagnostic: find events whose title contains `text` and dump every identifier
// field, so we can see how the AppleScript "uid" maps onto EventKit's ids.
func cmdDump(_ text: String) {
    let (start, end) = searchWindow()
    let predicate = store.predicateForEvents(withStart: start, end: end, calendars: nil)
    let evs = store.events(matching: predicate).filter {
        ($0.title ?? "").localizedCaseInsensitiveContains(text)
    }
    print("Matched \(evs.count) event(s) whose title contains \"\(text)\":")
    for ev in evs.prefix(20) {
        print("  - title: \(ev.title ?? "(none)")")
        print("      start: \(ev.startDate?.description ?? "?")  recurring: \(ev.hasRecurrenceRules)  calendar: \(ev.calendar.title)")
        print("      eventIdentifier:                \(ev.eventIdentifier ?? "nil")")
        print("      calendarItemIdentifier:         \(ev.calendarItemIdentifier)")
        print("      calendarItemExternalIdentifier: \(ev.calendarItemExternalIdentifier ?? "nil")")
    }
    if evs.count > 20 { print("  … and \(evs.count - 20) more") }
}

func cmdFind(_ uid: String) {
    let evs = occurrences(forUid: uid)
    print("Matched \(evs.count) occurrence(s) for uid \(uid):")
    for ev in evs.prefix(10) {
        let isRecurring = ev.hasRecurrenceRules
        print("  - \(ev.title ?? "(no title)")  start: \(ev.startDate?.description ?? "?")  recurring: \(isRecurring)  calendar: \(ev.calendar.title)")
    }
    if evs.count > 10 { print("  … and \(evs.count - 10) more") }
}

func cmdDelete(_ uid: String) {
    let evs = occurrences(forUid: uid)
    guard let first = evs.first else {
        print("DELETE: no event found for uid \(uid) — nothing to remove.")
        return
    }
    let span: EKSpan = first.hasRecurrenceRules ? .futureEvents : .thisEvent
    print("DELETE: removing \"\(first.title ?? "?")\" in \(first.calendar.title) with span \(first.hasRecurrenceRules ? "futureEvents" : "thisEvent")…")
    do {
        try store.remove(first, span: span, commit: true)
        print("DELETE: remove() returned success.")
    } catch {
        FileHandle.standardError.write("DELETE ERROR: \(error)\n".data(using: .utf8)!)
        exit(2)
    }
    // Re-query to confirm (AppleScript's lie was that this re-query still found it).
    let after = occurrences(forUid: uid)
    print("DELETE: re-query found \(after.count) occurrence(s) after removal (0 = gone locally).")
}

// MARK: - Main

let args = CommandLine.arguments
guard args.count >= 2 else {
    print("usage: ek-smoke <list|dump|find|delete> [uid-or-title]")
    exit(1)
}

guard requestAccess() else {
    FileHandle.standardError.write("Full Calendar Access NOT granted. Approve the dialog (or System Settings → Privacy → Calendars) and re-run.\n".data(using: .utf8)!)
    exit(3)
}

switch args[1] {
case "list":
    cmdList()
case "dump":
    guard args.count >= 3 else { print("dump needs a title substring"); exit(1) }
    cmdDump(args[2])
case "find":
    guard args.count >= 3 else { print("find needs a uid"); exit(1) }
    cmdFind(args[2])
case "delete":
    guard args.count >= 3 else { print("delete needs a uid"); exit(1) }
    cmdDelete(args[2])
default:
    print("unknown command: \(args[1])")
    exit(1)
}
