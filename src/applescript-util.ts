// ABOUTME: Pure (osascript-free) helpers shared by the Reminders and Calendar executors.
// These are the script-generation and output-parsing pieces — extracted so they can be
// unit-tested without a Mac or the live apps (that's where the 2026-06-03 bugs lived:
// shell/AS escaping, date formatting, delimiter parsing).

import type { Reminder } from './applescript-executor.js';
import type { CalendarEvent } from './calendar-executor.js';

/**
 * Escape a string for safe inclusion inside an AppleScript double-quoted literal.
 * Order matters: backslashes first, then double quotes.
 *
 * NOTE: apostrophes are intentionally NOT escaped. The whole script is passed to
 * osascript via a single-quoted heredoc (`<<'APPLESCRIPT'`), so the shell never sees
 * the apostrophe as a delimiter. The old `osascript -e '...'` form escaped apostrophes
 * as `\'`, which is invalid inside a single-quoted /bin/sh string and broke any
 * reminder containing one ("Mom's birthday"). Adding apostrophe handling here would
 * reintroduce that bug — leave it out.
 */
export function escAS(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Convert an ISO 8601 string or a Date object to the "Month D, YYYY at H:MM AM/PM"
 * format that AppleScript's `date` keyword reliably accepts on US-locale Macs.
 * Accepting a Date directly avoids the UTC-roundtrip that toISOString() introduces
 * when computing internal date windows. A string that doesn't parse (e.g. an
 * already-formatted AppleScript date) is passed through unchanged.
 */
export function isoToAppleScriptDate(dateOrStr: string | Date): string {
  const d = typeof dateOrStr === 'string' ? new Date(dateOrStr) : dateOrStr;
  if (isNaN(d.getTime())) {
    // If it already looks like an AppleScript date string, pass through
    return typeof dateOrStr === 'string' ? dateOrStr : '';
  }
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const month = months[d.getMonth()];
  const day = d.getDate();
  const year = d.getFullYear();
  let hours = d.getHours();
  const minutes = d.getMinutes().toString().padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  return `${month} ${day}, ${year} at ${hours}:${minutes} ${ampm}`;
}

/**
 * Parse the §§§-delimited reminder lines emitted by the Reminders AppleScript.
 * One reminder per newline; fields separated by §§§ in a fixed order.
 * "missing value" (AppleScript's null) maps to undefined for optional fields.
 *
 * Note: reminders have no recurrence property in the AppleScript dictionary, so the
 * script emits 10 fields (name…flagged) and none is parsed for recurrence.
 */
export function parseReminders(result: string): Reminder[] {
  if (!result) return [];
  const reminderLines = result.split('\n').filter(line => line.trim());
  return reminderLines.map(line => {
    const parts = line.split('§§§');
    return {
      name: parts[0] || '',
      body: (parts[1] && parts[1] !== 'missing value') ? parts[1] : undefined,
      completed: parts[2] === 'true',
      list: parts[3] || '',
      id: parts[4] || '',
      creationDate: parts[5] || '',
      modificationDate: parts[6] || '',
      priority: parseInt(parts[7]) || 0,
      dueDate: (parts[8] && parts[8] !== 'missing value') ? parts[8] : undefined,
      tags: [],
      flagged: parts[9] === 'true',
    };
  });
}

/**
 * Parse the §REC§-record / §§§-field output emitted by the Calendar AppleScript.
 * Newlines inside description/location are encoded as the literal "\n" by the script
 * and restored here.
 */
export function parseEvents(result: string): CalendarEvent[] {
  if (!result) return [];
  return result.split('§REC§').filter(l => l.trim()).map(line => {
    const p = line.split('§§§');
    const restoreNewlines = (s: string) => s.replace(/\\n/g, '\n');
    return {
      uid:         p[0]  || '',
      summary:     p[1]  || '',
      description: (p[2] && p[2] !== 'missing value') ? restoreNewlines(p[2]) : undefined,
      startDate:   p[3]  || '',
      endDate:     p[4]  || '',
      allDay:      p[5]  === 'true',
      location:    (p[6] && p[6] !== 'missing value') ? restoreNewlines(p[6]) : undefined,
      status:      p[7]  || '',
      recurrence:  (p[8] && p[8] !== 'missing value' && p[8] !== '') ? p[8] : undefined,
      url:         (p[9] && p[9] !== 'missing value') ? p[9] : undefined,
      calendar:    p[10] || '',
    };
  });
}

/**
 * Interpret the sentinel returned by the deleteEvent AppleScript and translate it
 * into the right outcome: OK → return, NOTFOUND/PERSISTED → throw an honest error.
 * Extracted so the branch mapping is testable without running osascript.
 *
 * PERSISTED is the known CalDAV/Google recurring-series case: AppleScript reports
 * success but the master event regenerates. We re-query in the script and surface
 * an honest error here rather than the old silent-success lie.
 */
export function interpretDeleteResult(result: string, uid: string): void {
  if (result === 'NOTFOUND') {
    throw new Error(`Event UID not found: ${uid}`);
  }
  if (result === 'PERSISTED') {
    throw new Error(
      `Delete reported success but event ${uid} still exists. This is a known ` +
      `AppleScript limitation for recurring series on CalDAV/Google-backed calendars ` +
      `(e.g. "Personal"). Delete the series in the Calendar app UI instead.`
    );
  }
}
