// EventKit Calendar CLI for apple-reminders-mcp (TRACK 2).
//
// Replaces the AppleScript Calendar path with EventKit, which (unlike AppleScript)
// reliably deletes recurring series on CalDAV/Google-backed calendars and properly
// expands recurring events. See docs/RESEARCH-caldav-recurring-delete.md and the
// go/no-go smoke test (smoke-test.swift) that greenlit this port.
//
// Build/sign:  bash src/eventkit-cli/build-eventkit.sh
// (compilation needs no Calendar access; RUNNING needs Full Calendar Access (TCC),
//  which is attributed to the responsible GUI app — see build-eventkit.sh / HANDOFF.)
//
// Contract: one JSON value to stdout per invocation. On error, prints
// {"error":"…"} to stdout and exits nonzero. The Node CalendarExecutor spawns this
// binary and parses stdout. Output shapes match the existing TS types exactly:
//   CalendarInfo  = {name, id, description, writable}
//   CalendarEvent = {uid, summary, description?, startDate, endDate, allDay,
//                    location?, status, recurrence?, url?, calendar}
//
// Subcommands:
//   list-calendars
//   get-events    --calendar <name> --start <iso> --end <iso>
//   search-events --term <text> [--calendar <name>] [--start <iso>] [--end <iso>]
//   create-event  --calendar <name> --summary <t> --start <iso> --end <iso>
//                 [--all-day] [--location <l>] [--notes <n>] [--url <u>] [--recurrence <RRULE>]
//   update-event  --uid <id> [--summary] [--start] [--end] [--all-day <bool>]
//                 [--location] [--notes] [--url] [--recurrence <RRULE>] [--span this|future]
//   delete-event  --uid <id> [--span this|future]

import EventKit
import Foundation

let store = EKEventStore()

// MARK: - Output helpers

func emitJSON<T: Encodable>(_ value: T) {
    let enc = JSONEncoder()
    enc.outputFormatting = [.withoutEscapingSlashes]
    do {
        let data = try enc.encode(value)
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0a]))
    } catch {
        fail("JSON encoding failed: \(error)")
    }
}

func fail(_ message: String, exitCode: Int32 = 1) -> Never {
    if let data = try? JSONSerialization.data(withJSONObject: ["error": message]) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0a]))
    }
    exit(exitCode)
}

// MARK: - Access (synchronous wait; CLI has no run loop otherwise)

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

// MARK: - Dates

// ISO 8601 in/out. Output is always UTC ("…Z") and unambiguous; the Node layer can
// re-render in the local zone if desired.
let isoOut: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    return f
}()

func isoString(_ d: Date) -> String { isoOut.string(from: d) }

func parseDate(_ s: String) -> Date? {
    let f1 = ISO8601DateFormatter()
    f1.formatOptions = [.withInternetDateTime]
    if let d = f1.date(from: s) { return d }
    let f2 = ISO8601DateFormatter()
    f2.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = f2.date(from: s) { return d }
    // Fallbacks for inputs without an explicit zone (interpreted in the local zone).
    let df = DateFormatter()
    df.locale = Locale(identifier: "en_US_POSIX")
    for fmt in ["yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm", "yyyy-MM-dd"] {
        df.dateFormat = fmt
        if let d = df.date(from: s) { return d }
    }
    return nil
}

// Default search window: 1 year back, 2 years forward (matches the smoke test). Used
// when a subcommand needs a window but none was supplied.
func searchWindow() -> (Date, Date) {
    let now = Date()
    let cal = Calendar.current
    let start = cal.date(byAdding: .year, value: -1, to: now)!
    let end = cal.date(byAdding: .year, value: 2, to: now)!
    return (start, end)
}

// MARK: - uid matching / lookup

// AppleScript "uid" == EventKit calendarItemIdentifier (verified by the smoke test).
// Keep the external/event identifiers as fallbacks for robustness.
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

// Resolve a single event by uid. Direct identifier lookup first (fast, no scan);
// fall back to a window scan for ids the direct lookup can't resolve.
func findEvent(uid: String) -> EKEvent? {
    if let item = store.calendarItem(withIdentifier: uid) as? EKEvent { return item }
    return occurrences(forUid: uid).first
}

func calendar(named name: String) -> EKCalendar? {
    return store.calendars(for: .event).first { $0.title == name }
}

// MARK: - Status mapping

func statusName(_ s: EKEventStatus) -> String {
    switch s {
    case .none: return "none"
    case .confirmed: return "confirmed"
    case .tentative: return "tentative"
    case .canceled: return "cancelled"
    @unknown default: return "none"
    }
}

// MARK: - Recurrence (RRULE) <-> EKRecurrenceRule

let weekdayToCode: [EKWeekday: String] = [
    .sunday: "SU", .monday: "MO", .tuesday: "TU", .wednesday: "WE",
    .thursday: "TH", .friday: "FR", .saturday: "SA",
]
let codeToWeekday: [String: EKWeekday] = [
    "SU": .sunday, "MO": .monday, "TU": .tuesday, "WE": .wednesday,
    "TH": .thursday, "FR": .friday, "SA": .saturday,
]

func parseDayOfWeek(_ token: String) -> EKRecurrenceDayOfWeek? {
    let t = token.trimmingCharacters(in: .whitespaces).uppercased()
    guard t.count >= 2 else { return nil }
    let code = String(t.suffix(2))
    let numPart = String(t.dropLast(2))
    guard let wd = codeToWeekday[code] else { return nil }
    if numPart.isEmpty {
        return EKRecurrenceDayOfWeek(wd)
    } else if let n = Int(numPart) {
        return EKRecurrenceDayOfWeek(dayOfTheWeek: wd, weekNumber: n)
    }
    return nil
}

func parseUntil(_ s: String) -> Date? {
    let df = DateFormatter()
    df.locale = Locale(identifier: "en_US_POSIX")
    df.timeZone = TimeZone(identifier: "UTC")
    for fmt in ["yyyyMMdd'T'HHmmss'Z'", "yyyyMMdd'T'HHmmss", "yyyyMMdd"] {
        df.dateFormat = fmt
        if let d = df.date(from: s) { return d }
    }
    return parseDate(s)
}

func parseRRULE(_ raw: String) -> EKRecurrenceRule? {
    var body = raw.trimmingCharacters(in: .whitespaces)
    if body.uppercased().hasPrefix("RRULE:") { body = String(body.dropFirst(6)) }
    var fields: [String: String] = [:]
    for pair in body.split(separator: ";") {
        let kv = pair.split(separator: "=", maxSplits: 1).map(String.init)
        if kv.count == 2 { fields[kv[0].uppercased()] = kv[1] }
    }
    guard let freqStr = fields["FREQ"]?.uppercased() else { return nil }
    let freq: EKRecurrenceFrequency
    switch freqStr {
    case "DAILY": freq = .daily
    case "WEEKLY": freq = .weekly
    case "MONTHLY": freq = .monthly
    case "YEARLY": freq = .yearly
    default: return nil
    }

    let interval = max(1, Int(fields["INTERVAL"] ?? "1") ?? 1)

    var byDay: [EKRecurrenceDayOfWeek]? = nil
    if let v = fields["BYDAY"] {
        let parsed = v.split(separator: ",").compactMap { parseDayOfWeek(String($0)) }
        if !parsed.isEmpty { byDay = parsed }
    }
    var byMonthDay: [NSNumber]? = nil
    if let v = fields["BYMONTHDAY"] {
        let parsed = v.split(separator: ",").compactMap { Int($0) }.map { NSNumber(value: $0) }
        if !parsed.isEmpty { byMonthDay = parsed }
    }
    var byMonth: [NSNumber]? = nil
    if let v = fields["BYMONTH"] {
        let parsed = v.split(separator: ",").compactMap { Int($0) }.map { NSNumber(value: $0) }
        if !parsed.isEmpty { byMonth = parsed }
    }
    var bySetPos: [NSNumber]? = nil
    if let v = fields["BYSETPOS"] {
        let parsed = v.split(separator: ",").compactMap { Int($0) }.map { NSNumber(value: $0) }
        if !parsed.isEmpty { bySetPos = parsed }
    }

    var end: EKRecurrenceEnd? = nil
    if let countStr = fields["COUNT"], let count = Int(countStr), count > 0 {
        end = EKRecurrenceEnd(occurrenceCount: count)
    } else if let untilStr = fields["UNTIL"], let until = parseUntil(untilStr) {
        end = EKRecurrenceEnd(end: until)
    }

    return EKRecurrenceRule(
        recurrenceWith: freq,
        interval: interval,
        daysOfTheWeek: byDay,
        daysOfTheMonth: byMonthDay,
        monthsOfTheYear: byMonth,
        weeksOfTheYear: nil,
        daysOfTheYear: nil,
        setPositions: bySetPos,
        end: end
    )
}

func rruleString(_ r: EKRecurrenceRule) -> String {
    var parts: [String] = []
    let freq: String
    switch r.frequency {
    case .daily: freq = "DAILY"
    case .weekly: freq = "WEEKLY"
    case .monthly: freq = "MONTHLY"
    case .yearly: freq = "YEARLY"
    @unknown default: freq = "DAILY"
    }
    parts.append("FREQ=\(freq)")
    if r.interval > 1 { parts.append("INTERVAL=\(r.interval)") }
    if let days = r.daysOfTheWeek, !days.isEmpty {
        let codes = days.map { d -> String in
            let c = weekdayToCode[d.dayOfTheWeek] ?? ""
            return d.weekNumber != 0 ? "\(d.weekNumber)\(c)" : c
        }
        parts.append("BYDAY=\(codes.joined(separator: ","))")
    }
    if let md = r.daysOfTheMonth, !md.isEmpty {
        parts.append("BYMONTHDAY=\(md.map { "\($0.intValue)" }.joined(separator: ","))")
    }
    if let mo = r.monthsOfTheYear, !mo.isEmpty {
        parts.append("BYMONTH=\(mo.map { "\($0.intValue)" }.joined(separator: ","))")
    }
    if let sp = r.setPositions, !sp.isEmpty {
        parts.append("BYSETPOS=\(sp.map { "\($0.intValue)" }.joined(separator: ","))")
    }
    if let end = r.recurrenceEnd {
        if end.occurrenceCount > 0 {
            parts.append("COUNT=\(end.occurrenceCount)")
        } else if let until = end.endDate {
            let df = DateFormatter()
            df.locale = Locale(identifier: "en_US_POSIX")
            df.timeZone = TimeZone(identifier: "UTC")
            df.dateFormat = "yyyyMMdd'T'HHmmss'Z'"
            parts.append("UNTIL=\(df.string(from: until))")
        }
    }
    return "RRULE:" + parts.joined(separator: ";")
}

// MARK: - Output DTOs (match the TS types exactly)

struct CalendarInfoOut: Encodable {
    let name: String
    let id: String
    let description: String
    let writable: Bool
}

struct CalendarEventOut: Encodable {
    let uid: String
    let summary: String
    let description: String?
    let startDate: String
    let endDate: String
    let allDay: Bool
    let location: String?
    let status: String
    let recurrence: String?
    let url: String?
    let calendar: String
}

func toEventOut(_ ev: EKEvent) -> CalendarEventOut {
    var recurrence: String? = nil
    if let rule = ev.recurrenceRules?.first {
        recurrence = rruleString(rule)
    }
    return CalendarEventOut(
        uid: ev.calendarItemIdentifier,
        summary: ev.title ?? "",
        description: ev.notes,
        startDate: ev.startDate.map(isoString) ?? "",
        endDate: ev.endDate.map(isoString) ?? "",
        allDay: ev.isAllDay,
        location: ev.location,
        status: statusName(ev.status),
        recurrence: recurrence,
        url: ev.url?.absoluteString,
        calendar: ev.calendar?.title ?? ""
    )
}

// MARK: - Argument parsing
// Dumb --flag value pairs into a dict. A --flag with no following value (or followed
// by another --flag) is a boolean flag set to "true".

func parseArgs(_ argv: ArraySlice<String>) -> [String: String] {
    var dict: [String: String] = [:]
    let args = Array(argv)
    var i = 0
    while i < args.count {
        let tok = args[i]
        if tok.hasPrefix("--") {
            let key = String(tok.dropFirst(2))
            if i + 1 < args.count && !args[i + 1].hasPrefix("--") {
                dict[key] = args[i + 1]
                i += 2
            } else {
                dict[key] = "true"
                i += 1
            }
        } else {
            i += 1
        }
    }
    return dict
}

func require(_ args: [String: String], _ key: String, _ cmd: String) -> String {
    guard let v = args[key], !v.isEmpty else {
        fail("\(cmd): missing required --\(key)")
    }
    return v
}

// MARK: - Commands

func cmdListCalendars() {
    // EKCalendar has no notes/description; emit "" to keep the CalendarInfo shape.
    // EventKit DOES populate calendarIdentifier (unlike AppleScript on this account).
    let out = store.calendars(for: .event).map { c in
        CalendarInfoOut(
            name: c.title,
            id: c.calendarIdentifier,
            description: "",
            writable: c.allowsContentModifications
        )
    }
    emitJSON(out)
}

func cmdGetEvents(_ a: [String: String]) {
    let cals: [EKCalendar]?
    if let name = a["calendar"] {
        guard let c = calendar(named: name) else { fail("get-events: calendar not found: \(name)") }
        cals = [c]
    } else {
        cals = nil  // all calendars
    }
    let (defStart, defEnd) = searchWindow()
    let start = a["start"].flatMap(parseDate) ?? defStart
    let end = a["end"].flatMap(parseDate) ?? defEnd
    let pred = store.predicateForEvents(withStart: start, end: end, calendars: cals)
    let evs = store.events(matching: pred).sorted { ($0.startDate ?? .distantPast) < ($1.startDate ?? .distantPast) }
    emitJSON(evs.map(toEventOut))
}

func cmdSearchEvents(_ a: [String: String]) {
    let term = require(a, "term", "search-events").lowercased()
    let cals: [EKCalendar]?
    if let name = a["calendar"] {
        guard let c = calendar(named: name) else { fail("search-events: calendar not found: \(name)") }
        cals = [c]
    } else {
        cals = nil
    }
    let (defStart, defEnd) = searchWindow()
    let start = a["start"].flatMap(parseDate) ?? defStart
    let end = a["end"].flatMap(parseDate) ?? defEnd
    let pred = store.predicateForEvents(withStart: start, end: end, calendars: cals)
    let evs = store.events(matching: pred).filter { ev in
        let title = (ev.title ?? "").lowercased()
        let notes = (ev.notes ?? "").lowercased()
        return title.contains(term) || notes.contains(term)
    }.sorted { ($0.startDate ?? .distantPast) < ($1.startDate ?? .distantPast) }
    emitJSON(evs.map(toEventOut))
}

func cmdCreateEvent(_ a: [String: String]) {
    let calName = require(a, "calendar", "create-event")
    guard let cal = calendar(named: calName) else { fail("create-event: calendar not found: \(calName)") }
    let summary = require(a, "summary", "create-event")
    let startStr = require(a, "start", "create-event")
    let endStr = require(a, "end", "create-event")
    guard let start = parseDate(startStr) else { fail("create-event: bad --start date: \(startStr)") }
    guard let end = parseDate(endStr) else { fail("create-event: bad --end date: \(endStr)") }

    let ev = EKEvent(eventStore: store)
    ev.calendar = cal
    ev.title = summary
    ev.startDate = start
    ev.endDate = end
    if a["all-day"] == "true" { ev.isAllDay = true }
    if let loc = a["location"] { ev.location = loc }
    if let notes = a["notes"] { ev.notes = notes }
    if let urlStr = a["url"], let url = URL(string: urlStr) { ev.url = url }
    if let rruleStr = a["recurrence"] {
        guard let rule = parseRRULE(rruleStr) else { fail("create-event: invalid --recurrence RRULE: \(rruleStr)") }
        ev.addRecurrenceRule(rule)
    }

    do {
        try store.save(ev, span: .thisEvent, commit: true)
    } catch {
        fail("create-event: save failed: \(error.localizedDescription)")
    }
    emitJSON(["uid": ev.calendarItemIdentifier])
}

func cmdUpdateEvent(_ a: [String: String]) {
    let uid = require(a, "uid", "update-event")
    guard let ev = findEvent(uid: uid) else { fail("update-event: event not found for uid: \(uid)") }

    if let summary = a["summary"] { ev.title = summary }
    if let notes = a["notes"] { ev.notes = notes }
    if let loc = a["location"] { ev.location = loc }
    if let startStr = a["start"] {
        guard let d = parseDate(startStr) else { fail("update-event: bad --start date: \(startStr)") }
        ev.startDate = d
    }
    if let endStr = a["end"] {
        guard let d = parseDate(endStr) else { fail("update-event: bad --end date: \(endStr)") }
        ev.endDate = d
    }
    if let allDay = a["all-day"] { ev.isAllDay = (allDay == "true") }
    if let urlStr = a["url"] { ev.url = URL(string: urlStr) }
    if let rruleStr = a["recurrence"] {
        // Replace any existing rules. An empty value clears recurrence (the MCP
        // update_event schema documents "empty string to clear").
        ev.recurrenceRules?.forEach { ev.removeRecurrenceRule($0) }
        if !rruleStr.isEmpty {
            guard let rule = parseRRULE(rruleStr) else { fail("update-event: invalid --recurrence RRULE: \(rruleStr)") }
            ev.addRecurrenceRule(rule)
        }
    }

    let span: EKSpan = spanArg(a, recurring: ev.hasRecurrenceRules)
    do {
        try store.save(ev, span: span, commit: true)
    } catch {
        fail("update-event: save failed: \(error.localizedDescription)")
    }
    emitJSON(["uid": ev.calendarItemIdentifier])
}

func cmdDeleteEvent(_ a: [String: String]) {
    let uid = require(a, "uid", "delete-event")
    guard let ev = findEvent(uid: uid) else { fail("delete-event: event not found for uid: \(uid)") }
    let span: EKSpan = spanArg(a, recurring: ev.hasRecurrenceRules)
    do {
        try store.remove(ev, span: span, commit: true)
    } catch {
        fail("delete-event: remove failed: \(error.localizedDescription)")
    }
    // Honest verification: re-query. (This is the whole point of the EventKit port —
    // AppleScript reported success here while the CalDAV series persisted.)
    let remaining = occurrences(forUid: uid)
    if !remaining.isEmpty {
        fail("delete-event: remove reported success but \(remaining.count) occurrence(s) of uid \(uid) still exist.")
    }
    emitJSON(["deleted": true])
}

// Resolve the --span flag. Explicit "this"/"future" wins; otherwise default to
// .futureEvents for recurring events (delete/edit the whole series) and .thisEvent
// for non-recurring.
func spanArg(_ a: [String: String], recurring: Bool) -> EKSpan {
    switch a["span"]?.lowercased() {
    case "this": return .thisEvent
    case "future": return .futureEvents
    default: return recurring ? .futureEvents : .thisEvent
    }
}

// MARK: - Main

let argv = CommandLine.arguments
guard argv.count >= 2 else {
    fail("usage: eventkit-cli <list-calendars|get-events|search-events|create-event|update-event|delete-event> [--flags]")
}

guard requestAccess() else {
    fail("Full Calendar Access not granted. Approve the prompt (or System Settings → Privacy & Security → Calendars) and retry. Note: the grant is attributed to the responsible GUI app.", exitCode: 3)
}

let command = argv[1]
let flags = parseArgs(argv.dropFirst(2))

switch command {
case "list-calendars":
    cmdListCalendars()
case "get-events":
    cmdGetEvents(flags)
case "search-events":
    cmdSearchEvents(flags)
case "create-event":
    cmdCreateEvent(flags)
case "update-event":
    cmdUpdateEvent(flags)
case "delete-event":
    cmdDeleteEvent(flags)
default:
    fail("unknown command: \(command)")
}
