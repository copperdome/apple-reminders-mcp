// Regression tests for the pure (spawn-free) EventKit CLI helpers: the `--flag value`
// argument vectors handed to the eventkit-cli binary, and the error-aware JSON parser.
// These let us assert the TS→CLI mapping without a Mac or the compiled Swift binary.

import { describe, it, expect } from 'vitest';
import {
  buildGetEventsArgs,
  buildSearchEventsArgs,
  buildCreateEventArgs,
  buildUpdateEventArgs,
  buildDeleteEventArgs,
  parseCliJson,
} from '../src/eventkit-util';

describe('buildGetEventsArgs', () => {
  it('bare command with no filters', () => {
    expect(buildGetEventsArgs()).toEqual(['get-events']);
  });
  it('includes calendar + date window', () => {
    expect(buildGetEventsArgs('Personal', '2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z'))
      .toEqual(['get-events', '--calendar', 'Personal', '--start', '2026-06-01T00:00:00Z', '--end', '2026-07-01T00:00:00Z']);
  });
  it('omits flags for undefined values', () => {
    expect(buildGetEventsArgs(undefined, '2026-06-01T00:00:00Z'))
      .toEqual(['get-events', '--start', '2026-06-01T00:00:00Z']);
  });
});

describe('buildSearchEventsArgs', () => {
  it('always includes the term', () => {
    expect(buildSearchEventsArgs('standup')).toEqual(['search-events', '--term', 'standup']);
  });
  it('passes a term with spaces/apostrophes as a single arg (no shell escaping needed)', () => {
    // execFile passes argv elements verbatim — no quoting, so "Mom's meeting" is one arg.
    expect(buildSearchEventsArgs("Mom's meeting", 'Family'))
      .toEqual(['search-events', '--term', "Mom's meeting", '--calendar', 'Family']);
  });
  it('includes calendar + window', () => {
    expect(buildSearchEventsArgs('x', 'Work', '2026-01-01T00:00:00Z', '2026-12-31T00:00:00Z'))
      .toEqual(['search-events', '--term', 'x', '--calendar', 'Work', '--start', '2026-01-01T00:00:00Z', '--end', '2026-12-31T00:00:00Z']);
  });
});

describe('buildCreateEventArgs', () => {
  it('required fields only', () => {
    expect(buildCreateEventArgs('Personal', 'Lunch', '2026-06-10T15:00:00Z', '2026-06-10T16:00:00Z'))
      .toEqual(['create-event', '--calendar', 'Personal', '--summary', 'Lunch', '--start', '2026-06-10T15:00:00Z', '--end', '2026-06-10T16:00:00Z']);
  });
  it('all-day is a bare flag (no value)', () => {
    const args = buildCreateEventArgs('Personal', 'Holiday', '2026-06-10T00:00:00Z', '2026-06-11T00:00:00Z', { allDay: true });
    expect(args).toContain('--all-day');
    // the token after --all-day must NOT be a value
    const idx = args.indexOf('--all-day');
    expect(args[idx + 1]).toBeUndefined();
  });
  it('does not emit --all-day when false/absent', () => {
    expect(buildCreateEventArgs('Personal', 'x', 'a', 'b', { allDay: false })).not.toContain('--all-day');
    expect(buildCreateEventArgs('Personal', 'x', 'a', 'b', {})).not.toContain('--all-day');
  });
  it('maps description to --notes and includes location/url/recurrence', () => {
    const args = buildCreateEventArgs('Personal', 'Sync', 's', 'e', {
      description: 'agenda', location: 'Room 1', url: 'https://x.test', recurrence: 'FREQ=WEEKLY;COUNT=4',
    });
    expect(args).toEqual([
      'create-event', '--calendar', 'Personal', '--summary', 'Sync', '--start', 's', '--end', 'e',
      '--notes', 'agenda', '--location', 'Room 1', '--url', 'https://x.test', '--recurrence', 'FREQ=WEEKLY;COUNT=4',
    ]);
  });
  it('skips empty-string recurrence on create (CLI rejects "" as RRULE)', () => {
    expect(buildCreateEventArgs('Personal', 'x', 's', 'e', { recurrence: '' })).not.toContain('--recurrence');
  });
  it('emits an empty --notes value when description is the empty string', () => {
    const args = buildCreateEventArgs('Personal', 'x', 's', 'e', { description: '' });
    const idx = args.indexOf('--notes');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('');
  });
});

describe('buildUpdateEventArgs', () => {
  it('uid only when no fields', () => {
    expect(buildUpdateEventArgs('UID1', {})).toEqual(['update-event', '--uid', 'UID1']);
  });
  it('all-day uses an explicit boolean value (unlike create)', () => {
    expect(buildUpdateEventArgs('UID1', { allDay: true })).toEqual(['update-event', '--uid', 'UID1', '--all-day', 'true']);
    expect(buildUpdateEventArgs('UID1', { allDay: false })).toEqual(['update-event', '--uid', 'UID1', '--all-day', 'false']);
  });
  it('passes empty-string recurrence through to clear it', () => {
    expect(buildUpdateEventArgs('UID1', { recurrence: '' })).toEqual(['update-event', '--uid', 'UID1', '--recurrence', '']);
  });
  it('maps description→--notes and emits fields in the builder order (recurrence before url)', () => {
    expect(buildUpdateEventArgs('UID1', {
      summary: 'New', description: 'notes', startDate: 's', endDate: 'e', location: 'L', url: 'u', recurrence: 'FREQ=DAILY',
    })).toEqual([
      'update-event', '--uid', 'UID1',
      '--summary', 'New', '--notes', 'notes', '--start', 's', '--end', 'e',
      '--location', 'L', '--recurrence', 'FREQ=DAILY', '--url', 'u',
    ]);
  });
  it('omits fields left undefined', () => {
    const args = buildUpdateEventArgs('UID1', { summary: 'Only summary' });
    expect(args).toEqual(['update-event', '--uid', 'UID1', '--summary', 'Only summary']);
    expect(args).not.toContain('--notes');
    expect(args).not.toContain('--all-day');
  });
});

describe('buildDeleteEventArgs', () => {
  it('uid only — span/calendar are resolved by the CLI', () => {
    expect(buildDeleteEventArgs('UID1')).toEqual(['delete-event', '--uid', 'UID1']);
  });
});

describe('parseCliJson', () => {
  it('parses a JSON array', () => {
    expect(parseCliJson<number[]>('[1,2,3]')).toEqual([1, 2, 3]);
  });
  it('parses a JSON object', () => {
    expect(parseCliJson<{ uid: string }>('{"uid":"ABC"}')).toEqual({ uid: 'ABC' });
  });
  it('throws the CLI error message for an {error} object', () => {
    expect(() => parseCliJson('{"error":"calendar not found: Nope"}')).toThrow('calendar not found: Nope');
  });
  it('does NOT treat an array as an error even if it contains error-like items', () => {
    expect(parseCliJson<any[]>('[{"error":"x"}]')).toEqual([{ error: 'x' }]);
  });
  it('throws a wrapped error on non-JSON output', () => {
    expect(() => parseCliJson('not json')).toThrow(/non-JSON output/);
  });
});
