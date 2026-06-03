// Regression tests for the pure (osascript-free) helpers extracted from the
// Reminders/Calendar executors. Every bug found in the 2026-06-03 live audit lived
// in this layer: shell/AS escaping, date formatting, and §-delimiter parsing.
//
// Imports use no file extension so Vitest resolves the .ts source directly (the
// executors' .js-style imports are type-only and erased before resolution).

import { describe, it, expect } from 'vitest';
import {
  escAS,
  isoToAppleScriptDate,
  parseReminders,
  parseEvents,
  interpretDeleteResult,
} from '../src/applescript-util';

describe('escAS', () => {
  it('escapes backslashes', () => {
    expect(escAS('a\\b')).toBe('a\\\\b');
  });

  it('escapes double quotes', () => {
    expect(escAS('say "hi"')).toBe('say \\"hi\\"');
  });

  it('escapes backslash BEFORE quote (order matters — no double-escaping the added backslash)', () => {
    // Input: backslash then quote.  Expect: escaped backslash (\\) then escaped quote (\").
    expect(escAS('\\"')).toBe('\\\\\\"');
  });

  it('leaves apostrophes untouched — the 2026-06-03 critical bug', () => {
    // The whole script is passed to osascript via a single-quoted heredoc, so the
    // shell never treats the apostrophe as a delimiter. Escaping it (the old `-e`
    // behavior) is what broke "Mom's birthday" entirely.
    expect(escAS("Mom's birthday")).toBe("Mom's birthday");
  });

  it('handles a mix of quotes and apostrophes', () => {
    expect(escAS(`quote "x" and apostrophe's`)).toBe(`quote \\"x\\" and apostrophe's`);
  });

  it('is a no-op for plain text', () => {
    expect(escAS('Buy milk')).toBe('Buy milk');
  });

  it('handles empty string', () => {
    expect(escAS('')).toBe('');
  });
});

describe('isoToAppleScriptDate', () => {
  it('formats a no-timezone ISO string as US-locale AppleScript date (parsed as local time)', () => {
    // A date-time with no offset is interpreted as LOCAL time by the Date constructor,
    // so the output is timezone-independent — this is the round-trip property.
    expect(isoToAppleScriptDate('2026-04-08T07:30:00')).toBe('April 8, 2026 at 7:30 AM');
  });

  it('formats a Date object without UTC drift (uses local getters)', () => {
    const d = new Date(2026, 3, 8, 7, 30); // April 8 2026, 07:30 local
    expect(isoToAppleScriptDate(d)).toBe('April 8, 2026 at 7:30 AM');
  });

  it('renders midnight as 12:00 AM', () => {
    expect(isoToAppleScriptDate(new Date(2026, 11, 25, 0, 0))).toBe('December 25, 2026 at 12:00 AM');
  });

  it('renders noon as 12:00 PM', () => {
    expect(isoToAppleScriptDate(new Date(2026, 0, 1, 12, 0))).toBe('January 1, 2026 at 12:00 PM');
  });

  it('renders afternoon hours in PM', () => {
    expect(isoToAppleScriptDate(new Date(2026, 0, 1, 13, 5))).toBe('January 1, 2026 at 1:05 PM');
  });

  it('zero-pads minutes', () => {
    expect(isoToAppleScriptDate(new Date(2026, 5, 9, 9, 3))).toBe('June 9, 2026 at 9:03 AM');
  });

  it('passes an unparseable string through unchanged (already-AppleScript-format dates)', () => {
    expect(isoToAppleScriptDate('not a real date')).toBe('not a real date');
  });

  it('returns empty string for an invalid Date object', () => {
    expect(isoToAppleScriptDate(new Date('nonsense'))).toBe('');
  });
});

describe('parseReminders', () => {
  it('returns [] for empty input', () => {
    expect(parseReminders('')).toEqual([]);
  });

  it('parses a full §§§-delimited reminder line (10 fields, no recurrence)', () => {
    const line = [
      'Buy milk',            // name
      'from the store',      // body
      'false',               // completed
      'Groceries',           // list
      'x-id-1',              // id
      'Monday, June 1',      // creationDate
      'Tuesday, June 2',     // modificationDate
      '5',                   // priority
      'Wednesday, June 3',   // dueDate
      'true',                // flagged
    ].join('§§§');
    expect(parseReminders(line)).toEqual([{
      name: 'Buy milk',
      body: 'from the store',
      completed: false,
      list: 'Groceries',
      id: 'x-id-1',
      creationDate: 'Monday, June 1',
      modificationDate: 'Tuesday, June 2',
      priority: 5,
      dueDate: 'Wednesday, June 3',
      tags: [],
      flagged: true,
    }]);
  });

  it('does not emit a recurrence field (reminders have no recurrence)', () => {
    const line = ['N', 'missing value', 'false', 'L', 'id', 'c', 'm', '0', 'missing value', 'true'].join('§§§');
    expect(parseReminders(line)[0]).not.toHaveProperty('recurrence');
  });

  it('maps "missing value" body and dueDate to undefined', () => {
    const line = ['N', 'missing value', 'true', 'L', 'id', 'c', 'm', '0', 'missing value', 'false'].join('§§§');
    const [r] = parseReminders(line);
    expect(r.body).toBeUndefined();
    expect(r.dueDate).toBeUndefined();
    expect(r.completed).toBe(true);
    expect(r.priority).toBe(0);
    expect(r.flagged).toBe(false);
  });

  it('parses multiple reminders separated by newlines', () => {
    const a = ['A', 'missing value', 'false', 'L', 'id-a', 'c', 'm', '0', 'missing value', 'false'].join('§§§');
    const b = ['B', 'missing value', 'false', 'L', 'id-b', 'c', 'm', '0', 'missing value', 'false'].join('§§§');
    const out = parseReminders(`${a}\n${b}`);
    expect(out.map(r => r.id)).toEqual(['id-a', 'id-b']);
  });

  it('handles apostrophes in the round-tripped name (no corruption)', () => {
    const line = ["Mom's birthday", 'missing value', 'false', 'L', 'id', 'c', 'm', '0', 'missing value', 'false'].join('§§§');
    expect(parseReminders(line)[0].name).toBe("Mom's birthday");
  });

  it('ignores blank lines', () => {
    const line = ['A', 'missing value', 'false', 'L', 'id', 'c', 'm', '0', 'missing value', 'false'].join('§§§');
    expect(parseReminders(`\n${line}\n\n`)).toHaveLength(1);
  });
});

describe('parseEvents', () => {
  it('returns [] for empty input', () => {
    expect(parseEvents('')).toEqual([]);
  });

  it('parses a full §§§-field event record', () => {
    const rec = [
      'uid-1',          // uid
      'Standup',        // summary
      'daily sync',     // description
      'start-str',      // startDate
      'end-str',        // endDate
      'false',          // allDay
      'Room 4',         // location
      'confirmed',      // status
      'FREQ=DAILY',     // recurrence
      'https://x.test', // url
      'Work',           // calendar
    ].join('§§§');
    expect(parseEvents(rec)).toEqual([{
      uid: 'uid-1',
      summary: 'Standup',
      description: 'daily sync',
      startDate: 'start-str',
      endDate: 'end-str',
      allDay: false,
      location: 'Room 4',
      status: 'confirmed',
      recurrence: 'FREQ=DAILY',
      url: 'https://x.test',
      calendar: 'Work',
    }]);
  });

  it('splits multiple records on §REC§', () => {
    const mk = (uid: string) => ['uid-' + uid, 'S', 'missing value', 's', 'e', 'true', 'missing value', 'ok', '', 'missing value', 'Cal'].join('§§§');
    const out = parseEvents(`${mk('1')}§REC§${mk('2')}`);
    expect(out.map(e => e.uid)).toEqual(['uid-1', 'uid-2']);
    expect(out[0].allDay).toBe(true);
  });

  it('maps "missing value" optionals to undefined and empty recurrence to undefined', () => {
    const rec = ['u', 'S', 'missing value', 's', 'e', 'false', 'missing value', 'ok', '', 'missing value', 'Cal'].join('§§§');
    const [e] = parseEvents(rec);
    expect(e.description).toBeUndefined();
    expect(e.location).toBeUndefined();
    expect(e.recurrence).toBeUndefined();
    expect(e.url).toBeUndefined();
  });

  it('restores escaped newlines (\\n) in description and location', () => {
    const rec = ['u', 'S', 'line1\\nline2', 's', 'e', 'false', 'loc1\\nloc2', 'ok', '', 'missing value', 'Cal'].join('§§§');
    const [e] = parseEvents(rec);
    expect(e.description).toBe('line1\nline2');
    expect(e.location).toBe('loc1\nloc2');
  });
});

describe('interpretDeleteResult', () => {
  it('returns without throwing on OK', () => {
    expect(() => interpretDeleteResult('OK', 'uid-1')).not.toThrow();
  });

  it('throws a not-found error on NOTFOUND, including the uid', () => {
    expect(() => interpretDeleteResult('NOTFOUND', 'uid-9')).toThrow(/not found.*uid-9/i);
  });

  it('throws an honest "still exists" error on PERSISTED (CalDAV recurring case)', () => {
    expect(() => interpretDeleteResult('PERSISTED', 'uid-7')).toThrow(/still exists/i);
  });

  it('PERSISTED error mentions the Calendar UI workaround', () => {
    expect(() => interpretDeleteResult('PERSISTED', 'uid-7')).toThrow(/Calendar app UI/i);
  });
});
