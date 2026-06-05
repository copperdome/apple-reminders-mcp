// Best-effort SQLite enrichment for Reminders fields EventKit's public API cannot read:
// flagged, #hashtag tags, subtask (parent/child) relationship, and section membership.
//
// WHY THIS EXISTS: EKReminder exposes none of the four. Reminders.app persists them in a
// CloudKit-mirrored Core Data store under the app's group container. We open that store
// READ-ONLY and join a handful of tables, keyed so the result lines up 1:1 with the
// EventKit reminders we already fetched.
//
// THE KEY THAT MAKES THIS WORK (verified live on macOS, 2026-06-04): EventKit's
// calendarItemIdentifier — our reminder `id` — equals ZREMCDREMINDER.ZCKIDENTIFIER. So the
// enrichment map is keyed by ZCKIDENTIFIER and the caller looks up by the reminder's `id`
// with no translation. A reminder on a local "On My Mac" list may have a null ZCKIDENTIFIER
// (it isn't in CloudKit); it simply won't appear in the map and its four fields are omitted.
//
// DESIGN — degrade, never fail:
//   * No Full Disk Access / store missing / open error  => return nil (caller augments nothing).
//   * One table/column drifted across a macOS update     => only that FIELD goes nil, because
//     each field is loaded by an INDEPENDENT prepared statement. The base scan failing takes
//     everything down to nil; a tag/section failure leaves flagged+parentId intact.
//   * This function never calls fail(), never throws, and never blocks reads — get-reminders
//     still returns every reminder if enrichment is unavailable.
//
// ATTRIBUTION: the store location, schema, and queries below are ported from Federico
// Viticci's RemCTL (MIT). Reference paths cited inline as `remctl:<line>` /
// `<file>:<line>`. See THIRD_PARTY_NOTICES at the repo root. Pinned against macOS as of
// 2026-06-04; if Reminders changes its schema, the per-field degradation above is the
// safety net and the citations are the map back to the source of truth.
//
// Full Disk Access is a MANUAL grant (System Settings → Privacy & Security → Full Disk
// Access) with NO Info.plist usage-string key — confirmed `remctl-permissions.swift:124,193`.
// It is attributed to the responsible GUI app: Terminal.app for the CLI, Claude Desktop when
// the MCP spawns this binary.

import Foundation
import SQLite3

// SQLite wants SQLITE_TRANSIENT (copy the bound bytes) for text we don't keep alive.
private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

// The four enrichment fields for one reminder. Any may be nil (unknown / not applicable);
// nil fields are omitted from the JSON by the caller, so absent ≠ false.
struct ReminderEnrichment {
    var flagged: Bool?
    var tags: [String]?
    var parentId: String?   // the PARENT reminder's ZCKIDENTIFIER (our id space), if a subtask
    var section: String?    // section display name, if the reminder belongs to one
}

// Locate the live Reminders store: the LARGEST `Data-*.sqlite` under the app group's
// Stores directory (`remctl:194`, `remctl_runtime.py:13`). Returns nil if the directory
// or any store is absent (e.g. Reminders never launched).
private func locateStore() -> String? {
    let home = FileManager.default.homeDirectoryForCurrentUser
    let storesDir = home
        .appendingPathComponent("Library/Group Containers/group.com.apple.reminders")
        .appendingPathComponent("Container_v1/Stores")
    guard let entries = try? FileManager.default.contentsOfDirectory(
        at: storesDir, includingPropertiesForKeys: [.fileSizeKey]) else { return nil }
    let candidates = entries.filter {
        $0.lastPathComponent.hasPrefix("Data-") && $0.pathExtension == "sqlite"
    }
    guard !candidates.isEmpty else { return nil }
    return candidates.max { a, b in
        let sa = (try? a.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        let sb = (try? b.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        return sa < sb
    }?.path
}

private func logDB(_ message: String) {
    FileHandle.standardError.write("RemindersDB: \(message)\n".data(using: .utf8)!)
}

// Open the store read-only. We try a PLAIN read-only open FIRST: in WAL mode this reads
// the live `-wal` (so changes written moments ago — e.g. via ReminderKit — are visible)
// and does NOT block the writer (WAL lets readers and the single writer coexist). A probe
// query confirms the connection can actually read (the wal-index/`-shm` is attachable).
// If it can't (no `-shm` access, or a fully-checkpointed idle store), we fall back to the
// lock-free `immutable=1` URI, which reads only the main file and may lag the `-wal`.
// A 2s busy timeout bounds any momentary checkpoint contention. nil on any failure.
private func openStore(_ path: String) -> OpaquePointer? {
    var db: OpaquePointer?
    if sqlite3_open_v2(path, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK {
        sqlite3_busy_timeout(db, 2000)
        if sqlite3_exec(db, "SELECT 1 FROM ZREMCDREMINDER LIMIT 1", nil, nil, nil) == SQLITE_OK {
            return db   // reads the live -wal → fresh
        }
        sqlite3_close(db); db = nil   // opened but couldn't read (e.g. wal-index unopenable)
    } else if db != nil {
        sqlite3_close(db); db = nil
    }
    let uri = "file:\(path)?immutable=1"
    if sqlite3_open_v2(uri, &db, SQLITE_OPEN_READONLY | SQLITE_OPEN_URI, nil) == SQLITE_OK {
        sqlite3_busy_timeout(db, 2000)
        return db   // lock-free fallback; main file only, may lag -wal
    }
    logDB("open failed for \(path) — likely no Full Disk Access; degrading")
    if db != nil { sqlite3_close(db) }
    return nil
}

// Build the [reminder ckid -> ReminderEnrichment] map. nil ⇒ enrichment unavailable
// (no FDA / no store / open error); the caller then augments nothing. Individual fields
// degrade to nil independently when their table/column has drifted.
func loadReminderEnrichments() -> [String: ReminderEnrichment]? {
    guard let path = locateStore() else {
        logDB("no Data-*.sqlite store found; degrading")
        return nil
    }
    guard let db = openStore(path) else { return nil }
    defer { sqlite3_close(db) }

    // ---- Base scan: flagged + parent linkage + the Z_PK->ckid index -------------------
    // ZREMCDREMINDER holds one row per reminder. We read ZFLAGGED and ZPARENTREMINDER
    // (the PARENT's Z_PK, or NULL), and build pkToCkid so a parent's Z_PK can be rendered
    // back into our id space. Skip soft-deleted rows. If THIS scan fails we have no key
    // space to attach anything to, so we abort to nil.
    var result: [String: ReminderEnrichment] = [:]
    var pkToCkid: [Int64: String] = [:]
    var parentPkByCkid: [String: Int64] = [:]   // ckid -> parent's Z_PK, resolved after the scan

    let baseSQL = """
        SELECT Z_PK, ZCKIDENTIFIER, ZFLAGGED, ZPARENTREMINDER
        FROM ZREMCDREMINDER
        WHERE ZMARKEDFORDELETION = 0
        """
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, baseSQL, -1, &stmt, nil) == SQLITE_OK else {
        logDB("base prepare failed: \(String(cString: sqlite3_errmsg(db))); degrading")
        return nil
    }
    while sqlite3_step(stmt) == SQLITE_ROW {
        let pk = sqlite3_column_int64(stmt, 0)
        guard sqlite3_column_type(stmt, 1) != SQLITE_NULL,
              let ckidC = sqlite3_column_text(stmt, 1) else { continue }   // local list: no ckid
        let ckid = String(cString: ckidC)
        pkToCkid[pk] = ckid

        var e = result[ckid] ?? ReminderEnrichment()
        e.flagged = sqlite3_column_int(stmt, 2) != 0
        result[ckid] = e

        if sqlite3_column_type(stmt, 3) != SQLITE_NULL {
            parentPkByCkid[ckid] = sqlite3_column_int64(stmt, 3)
        }
    }
    sqlite3_finalize(stmt)

    // Resolve each subtask's parentId into our id space (parent's ckid). A parent on a
    // local list (no ckid) simply yields no parentId.
    for (ckid, parentPk) in parentPkByCkid {
        if let parentCkid = pkToCkid[parentPk] {
            result[ckid]?.parentId = parentCkid
        }
    }

    // ---- Tags (independent; failure leaves only `tags` nil) ---------------------------
    // remctl_serialization.py:155-159 — hashtag labels joined to their reminder by Z_PK
    // (o.ZREMINDER3). We translate Z_PK back to ckid via the index built above.
    loadTags(db: db, pkToCkid: pkToCkid, into: &result)

    // ---- Section membership (independent; failure leaves only `section` nil) ----------
    // ZREMCDBASESECTION holds the section rows; membership is keyed by the reminder's
    // ckid (remctl:1481-1526, q_section_memberships at remctl:1493-1526).
    loadSections(db: db, into: &result)

    return result
}

// Attach tags. Groups ZNAME by reminder Z_PK, then maps Z_PK -> ckid. Any prepare/step
// failure logs and returns, leaving `tags` nil on every reminder.
private func loadTags(db: OpaquePointer, pkToCkid: [Int64: String],
                      into result: inout [String: ReminderEnrichment]) {
    let sql = """
        SELECT o.ZREMINDER3, h.ZNAME
        FROM ZREMCDOBJECT o
        JOIN ZREMCDHASHTAGLABEL h ON o.ZHASHTAGLABEL = h.Z_PK
        """
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
        logDB("tags prepare failed: \(String(cString: sqlite3_errmsg(db))); omitting tags")
        return
    }
    defer { sqlite3_finalize(stmt) }
    var tagsByCkid: [String: [String]] = [:]
    while sqlite3_step(stmt) == SQLITE_ROW {
        guard sqlite3_column_type(stmt, 0) != SQLITE_NULL,
              let nameC = sqlite3_column_text(stmt, 1) else { continue }
        let pk = sqlite3_column_int64(stmt, 0)
        guard let ckid = pkToCkid[pk] else { continue }
        tagsByCkid[ckid, default: []].append(String(cString: nameC))
    }
    for (ckid, tags) in tagsByCkid where result[ckid] != nil {
        result[ckid]?.tags = tags
    }
}

// Attach section display names, keyed by the reminder's ckid. Section membership is NOT a
// per-reminder FK on ZREMCDREMINDER (there is no ZSECTION column). It lives in a JSON blob
// on the owning LIST: ZREMCDBASELIST.ZMEMBERSHIPSOFREMINDERSINSECTIONSASDATA, shaped
// {"memberships":[{"memberID":<reminder ckid>,"groupID":<section ckid>,"isObsolete":bool}]}.
// Section ckid -> display name comes from ZREMCDBASESECTION. Ported from RemCTL's
// q_section_memberships (remctl:1493-1511). Both keys (memberID, groupID) are ckids, so the
// result lands directly in our id space. Any prepare/parse failure logs and leaves `section`
// nil everywhere.
private func loadSections(db: OpaquePointer, into result: inout [String: ReminderEnrichment]) {
    // section ckid -> display name
    var sectionNameByCkid: [String: String] = [:]
    let secSQL = """
        SELECT ZCKIDENTIFIER, ZDISPLAYNAME
        FROM ZREMCDBASESECTION
        WHERE ZMARKEDFORDELETION = 0
        """
    var secStmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, secSQL, -1, &secStmt, nil) == SQLITE_OK else {
        logDB("section prepare failed: \(String(cString: sqlite3_errmsg(db))); omitting section")
        return
    }
    while sqlite3_step(secStmt) == SQLITE_ROW {
        guard sqlite3_column_type(secStmt, 0) != SQLITE_NULL,
              let ckidC = sqlite3_column_text(secStmt, 0),
              let nameC = sqlite3_column_text(secStmt, 1) else { continue }
        sectionNameByCkid[String(cString: ckidC)] = String(cString: nameC)
    }
    sqlite3_finalize(secStmt)
    guard !sectionNameByCkid.isEmpty else { return }

    // Per-list membership JSON blob -> (reminder ckid : section display name).
    let memSQL = """
        SELECT ZMEMBERSHIPSOFREMINDERSINSECTIONSASDATA
        FROM ZREMCDBASELIST
        WHERE ZMEMBERSHIPSOFREMINDERSINSECTIONSASDATA IS NOT NULL
        """
    var memStmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, memSQL, -1, &memStmt, nil) == SQLITE_OK else {
        logDB("section membership prepare failed: \(String(cString: sqlite3_errmsg(db))); omitting section")
        return
    }
    defer { sqlite3_finalize(memStmt) }
    while sqlite3_step(memStmt) == SQLITE_ROW {
        guard let bytes = sqlite3_column_blob(memStmt, 0) else { continue }
        let len = Int(sqlite3_column_bytes(memStmt, 0))
        guard len > 0 else { continue }
        let data = Data(bytes: bytes, count: len)
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let memberships = obj["memberships"] as? [[String: Any]] else { continue }
        for m in memberships {
            if let obsolete = m["isObsolete"] as? Bool, obsolete { continue }
            guard let memberID = m["memberID"] as? String,
                  let groupID = m["groupID"] as? String,
                  let name = sectionNameByCkid[groupID],
                  result[memberID] != nil else { continue }
            result[memberID]?.section = name
        }
    }
}

// Resolve an EXISTING section by display name (case-insensitive) within the list that
// owns the given reminder. Returns the section's ZCKIDENTIFIER, or nil if there's no such
// section / the store can't be read (no FDA). Used by `assign-section` to decide between
// assigning to an existing section vs. creating a new one. Ported from RemCTL's
// resolve_section_ckid (remctl:3073).
func resolveSectionCkid(reminderCkid: String, sectionName: String) -> String? {
    guard let path = locateStore(), let db = openStore(path) else { return nil }
    defer { sqlite3_close(db) }

    // reminder ckid -> its owning list's Z_PK
    var listPk: Int64?
    var s1: OpaquePointer?
    if sqlite3_prepare_v2(db,
        "SELECT ZLIST FROM ZREMCDREMINDER WHERE ZCKIDENTIFIER = ? AND ZMARKEDFORDELETION = 0",
        -1, &s1, nil) == SQLITE_OK {
        sqlite3_bind_text(s1, 1, reminderCkid, -1, SQLITE_TRANSIENT)
        if sqlite3_step(s1) == SQLITE_ROW, sqlite3_column_type(s1, 0) != SQLITE_NULL {
            listPk = sqlite3_column_int64(s1, 0)
        }
    }
    sqlite3_finalize(s1)
    guard let lp = listPk else { return nil }

    // section in that list whose display name matches (case-insensitive)
    var found: String?
    var s2: OpaquePointer?
    if sqlite3_prepare_v2(db,
        """
        SELECT ZCKIDENTIFIER FROM ZREMCDBASESECTION
        WHERE ZLIST = ? AND ZMARKEDFORDELETION = 0 AND lower(ZDISPLAYNAME) = lower(?)
        """, -1, &s2, nil) == SQLITE_OK {
        sqlite3_bind_int64(s2, 1, lp)
        sqlite3_bind_text(s2, 2, sectionName, -1, SQLITE_TRANSIENT)
        if sqlite3_step(s2) == SQLITE_ROW, sqlite3_column_type(s2, 0) != SQLITE_NULL,
           let c = sqlite3_column_text(s2, 0) {
            found = String(cString: c)
        }
    }
    sqlite3_finalize(s2)
    return found
}
