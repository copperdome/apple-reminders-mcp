// Regression tests for the pure (spawn-free) EventKit Reminders CLI helpers: the
// `--flag value` argument vectors handed to the eventkit-cli binary. These assert the
// TS→CLI mapping without a Mac or the compiled Swift binary. parseCliJson itself is
// covered by eventkit-util.test.ts (re-exported, same function).

import { describe, it, expect } from 'vitest';
import {
  buildGetRemindersArgs,
  buildSearchRemindersArgs,
  buildCreateReminderArgs,
  buildUpdateReminderArgs,
  buildDeleteReminderArgs,
  buildSetFlaggedArgs,
  buildAddTagsArgs,
  buildAddSubtaskArgs,
  buildAssignSectionArgs,
  parseCliJson,
} from '../src/reminders-util';
import type { Reminder } from '../src/reminders-executor';

describe('buildGetRemindersArgs', () => {
  it('bare command with no filters (defaults to incomplete — no --completed)', () => {
    expect(buildGetRemindersArgs()).toEqual(['get-reminders']);
  });
  it('includes the list', () => {
    expect(buildGetRemindersArgs('Groceries')).toEqual(['get-reminders', '--list', 'Groceries']);
  });
  it('emits --completed true only when completed === true', () => {
    expect(buildGetRemindersArgs(undefined, true)).toEqual(['get-reminders', '--completed', 'true']);
  });
  it('does NOT emit --completed for false (false === incomplete, the default predicate)', () => {
    expect(buildGetRemindersArgs(undefined, false)).toEqual(['get-reminders']);
  });
  it('list name with apostrophe is a single arg (execFile, no shell escaping)', () => {
    expect(buildGetRemindersArgs("Sandee's list")).toEqual(['get-reminders', '--list', "Sandee's list"]);
  });
});

describe('buildSearchRemindersArgs', () => {
  it('always includes the term', () => {
    expect(buildSearchRemindersArgs('milk')).toEqual(['search-reminders', '--term', 'milk']);
  });
  it('includes the list when given', () => {
    expect(buildSearchRemindersArgs('milk', 'Groceries'))
      .toEqual(['search-reminders', '--term', 'milk', '--list', 'Groceries']);
  });
  it('passes a term with spaces/apostrophes as a single arg', () => {
    expect(buildSearchRemindersArgs("Peggy's pill"))
      .toEqual(['search-reminders', '--term', "Peggy's pill"]);
  });
});

describe('buildCreateReminderArgs', () => {
  it('required fields only', () => {
    expect(buildCreateReminderArgs('Buy milk', 'Groceries'))
      .toEqual(['create-reminder', '--list', 'Groceries', '--name', 'Buy milk']);
  });
  it('includes body, due, priority, remind, url', () => {
    const args = buildCreateReminderArgs('Call UPMC', 'Tasks', {
      body: 'about the bill',
      dueDate: '2026-06-10T15:00:00Z',
      priority: 5,
      remindMeDate: '2026-06-10T14:00:00Z',
      url: 'https://example.com',
    });
    expect(args).toEqual([
      'create-reminder', '--list', 'Tasks', '--name', 'Call UPMC',
      '--body', 'about the bill',
      '--due', '2026-06-10T15:00:00Z',
      '--priority', '5',
      '--remind', '2026-06-10T14:00:00Z',
      '--url', 'https://example.com',
    ]);
  });
  it('emits --body for an explicit empty string (clearing) but omits when undefined', () => {
    expect(buildCreateReminderArgs('x', 'L', { body: '' })).toContain('--body');
    expect(buildCreateReminderArgs('x', 'L', {})).not.toContain('--body');
  });
  it('omits --due when falsy', () => {
    expect(buildCreateReminderArgs('x', 'L', { dueDate: '' })).not.toContain('--due');
    expect(buildCreateReminderArgs('x', 'L', {})).not.toContain('--due');
  });
  it('priority 0 is still emitted (0 is a valid EventKit priority)', () => {
    const args = buildCreateReminderArgs('x', 'L', { priority: 0 });
    const idx = args.indexOf('--priority');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('0');
  });
  it('includes --recurrence when given a non-empty RRULE', () => {
    const args = buildCreateReminderArgs('x', 'L', { recurrence: 'FREQ=WEEKLY;INTERVAL=2' });
    const idx = args.indexOf('--recurrence');
    expect(args[idx + 1]).toBe('FREQ=WEEKLY;INTERVAL=2');
  });
  it('omits --recurrence for an empty string (CLI rejects "" on create)', () => {
    expect(buildCreateReminderArgs('x', 'L', { recurrence: '' })).not.toContain('--recurrence');
    expect(buildCreateReminderArgs('x', 'L', {})).not.toContain('--recurrence');
  });
});

describe('buildUpdateReminderArgs', () => {
  it('id only when no updates', () => {
    expect(buildUpdateReminderArgs('ABC', {})).toEqual(['update-reminder', '--id', 'ABC']);
  });
  it('maps each field to its flag', () => {
    const args = buildUpdateReminderArgs('ABC', {
      name: 'New name',
      body: 'notes',
      completed: true,
      priority: 1,
      remindMeDate: '2026-06-10T14:00:00Z',
      url: 'https://x.test',
    });
    expect(args).toEqual([
      'update-reminder', '--id', 'ABC',
      '--name', 'New name',
      '--body', 'notes',
      '--completed', 'true',
      '--priority', '1',
      '--remind', '2026-06-10T14:00:00Z',
      '--url', 'https://x.test',
    ]);
  });
  it('passes an empty --due verbatim so the CLI can clear the due date', () => {
    const args = buildUpdateReminderArgs('ABC', { dueDate: '' });
    const idx = args.indexOf('--due');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('');
  });
  it('passes recurrence through, including an empty string to clear it', () => {
    const set = buildUpdateReminderArgs('ABC', { recurrence: 'FREQ=DAILY' });
    expect(set[set.indexOf('--recurrence') + 1]).toBe('FREQ=DAILY');
    const clear = buildUpdateReminderArgs('ABC', { recurrence: '' });
    const idx = clear.indexOf('--recurrence');
    expect(idx).toBeGreaterThan(-1);
    expect(clear[idx + 1]).toBe('');
  });
  it('completed:false is emitted as the string "false"', () => {
    const args = buildUpdateReminderArgs('ABC', { completed: false });
    const idx = args.indexOf('--completed');
    expect(args[idx + 1]).toBe('false');
  });
});

describe('buildDeleteReminderArgs', () => {
  it('id only', () => {
    expect(buildDeleteReminderArgs('XYZ')).toEqual(['delete-reminder', '--id', 'XYZ']);
  });
});

describe('write arg-builders (ReminderKit)', () => {
  it('set-flagged emits the boolean as a string', () => {
    expect(buildSetFlaggedArgs('A', true)).toEqual(['set-flagged', '--id', 'A', '--flagged', 'true']);
    expect(buildSetFlaggedArgs('A', false)).toEqual(['set-flagged', '--id', 'A', '--flagged', 'false']);
  });
  it('add-tags joins tags with commas', () => {
    expect(buildAddTagsArgs('A', ['work', 'urgent']))
      .toEqual(['add-tags', '--id', 'A', '--tags', 'work,urgent']);
  });
  it('add-tags handles a single tag', () => {
    expect(buildAddTagsArgs('A', ['solo'])).toEqual(['add-tags', '--id', 'A', '--tags', 'solo']);
  });
  it('add-subtask passes parent + name as single args (spaces preserved)', () => {
    expect(buildAddSubtaskArgs('PARENT', 'Buy the milk'))
      .toEqual(['add-subtask', '--parent', 'PARENT', '--name', 'Buy the milk']);
  });
  it('assign-section passes the section name as a single arg', () => {
    expect(buildAssignSectionArgs('A', 'Home Maintenance'))
      .toEqual(['assign-section', '--id', 'A', '--section', 'Home Maintenance']);
  });
});

// The SQLite-sourced enrichment fields (flagged/tags/parentId/isSubtask/section) are
// OMITTED, not false/[], when Full Disk Access is unavailable. The CLI achieves this by
// leaving them out of the JSON entirely; this locks the contract that a missing field
// parses to `undefined` (absent ≠ false), so callers must never read absence as "off".
describe('enrichment fields: omitted ≠ false', () => {
  it('parses present enrichment and treats absent fields as undefined', () => {
    const stdout = JSON.stringify([
      {
        id: 'A', name: 'enriched', completed: false, list: 'L', priority: 0,
        creationDate: '2026-06-04T00:00:00Z', modificationDate: '2026-06-04T00:00:00Z',
        flagged: true, tags: ['verifytag'], parentId: 'P', isSubtask: true, section: 'Errands',
      },
      {
        id: 'B', name: 'plain', completed: false, list: 'L', priority: 0,
        creationDate: '2026-06-04T00:00:00Z', modificationDate: '2026-06-04T00:00:00Z',
      },
    ]);
    const [enriched, plain] = parseCliJson<Reminder[]>(stdout);

    expect(enriched.flagged).toBe(true);
    expect(enriched.tags).toEqual(['verifytag']);
    expect(enriched.parentId).toBe('P');
    expect(enriched.isSubtask).toBe(true);
    expect(enriched.section).toBe('Errands');

    // The crux: absent enrichment is undefined, NOT false / [] / "".
    expect(plain.flagged).toBeUndefined();
    expect(plain.tags).toBeUndefined();
    expect(plain.parentId).toBeUndefined();
    expect(plain.isSubtask).toBeUndefined();
    expect(plain.section).toBeUndefined();
    expect(plain.flagged).not.toBe(false);
  });
});
