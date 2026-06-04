// ABOUTME: Shared AppleScript-escaping helper. Mail is the remaining AppleScript-based
// executor (Reminders and Calendar moved to the EventKit CLI), and both mail-util.ts
// and mail-executor.ts re-use escAS() from here. Kept as a pure (osascript-free) module
// so it stays unit-testable without a Mac.
//
// History: this file previously also held parseReminders / isoToAppleScriptDate
// (Reminders) and parseEvents / interpretDeleteResult (Calendar). All four were removed
// when Reminders was ported to EventKit (2026-06-04) — Calendar's had already been dead
// since the EventKit Calendar port. Only escAS remains, because Mail still needs it.

/**
 * Escape a string for safe inclusion inside an AppleScript double-quoted literal.
 * Order matters: backslashes first, then double quotes.
 *
 * NOTE: apostrophes are intentionally NOT escaped. AppleScript is passed to osascript
 * via a single-quoted heredoc (`<<'APPLESCRIPT'`), so the shell never sees the
 * apostrophe as a delimiter. The old `osascript -e '...'` form escaped apostrophes as
 * `\'`, which is invalid inside a single-quoted /bin/sh string and broke any value
 * containing one ("Mom's birthday"). Adding apostrophe handling here would reintroduce
 * that bug — leave it out.
 */
export function escAS(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
