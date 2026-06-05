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

// Open the store read-only and lock-free via the `immutable=1` URI (so a syncing
// Reminders.app can't block us, at the cost of possibly lagging the live -wal by a
// checkpoint — fine for best-effort enrichment). Returns nil on any failure.
private func openStore(_ path: String) -> OpaquePointer? {
    var db: OpaquePointer?
    let uri = "file:\(path)?immutable=1"
    let rc = sqlite3_open_v2(uri, &db, SQLITE_OPEN_READONLY | SQLITE_OPEN_URI, nil)
    if rc != SQLITE_OK {
        logDB("open failed (rc=\(rc)) for \(path) — likely no Full Disk Access; degrading")
        if db != nil { sqlite3_close(db) }
        return nil
    }
    return db
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
