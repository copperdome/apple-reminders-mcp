// Bridging header: C-callable entry points for ReminderKit WRITES (Phase 2). Imported
// into the Swift CLI via `-import-objc-header`. Each function performs exactly one write
// through Apple's PRIVATE ReminderKit framework and returns NULL on success, or a
// heap-allocated C error string the Swift caller copies and free()s.
//
// IDENTIFIERS: reminder_ckid / section_ckid are CloudKit identifiers (ZCKIDENTIFIER),
// which on this account equal EventKit's calendarItemIdentifier — our reminder `id` —
// verified live 2026-06-04. So callers pass our `id` directly; no translation. A reminder
// on a local "On My Mac" list (no ckid) cannot be written this way.
//
// RISK: ReminderKit is a PRIVATE framework with no stable ABI; it may change or vanish
// across macOS releases. The binary weak-links it and rem_available() gates every call,
// so a missing/changed framework degrades to a clean error and never crashes reads.
//
// Ported from Federico Viticci's RemCTL (remctl-private.m, MIT). See THIRD_PARTY_NOTICES.

#ifndef REMINDERS_PRIVATE_H
#define REMINDERS_PRIVATE_H

// 1 if the ReminderKit private framework is loadable at runtime, else 0.
int rem_available(void);

// All return NULL on success, or a malloc'd error string (caller must free()).
const char *rem_set_flagged(const char *reminder_ckid, int flagged);
const char *rem_add_tags(const char *reminder_ckid, const char *tags_csv);          // comma-separated
const char *rem_add_subtask(const char *parent_ckid, const char *title);            // adds a child reminder
const char *rem_assign_section(const char *reminder_ckid, const char *section_ckid); // existing section
const char *rem_add_section_and_assign(const char *reminder_ckid, const char *section_name); // create + assign

#endif
