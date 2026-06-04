// ABOUTME: Pure (spawn-free) helpers for the EventKit Reminders CLI integration.
// Build the `--flag value` argument vectors passed to the eventkit-cli binary and
// re-export the JSON parser — extracted so they can be unit-tested without a Mac, the
// live Reminders app, or the compiled Swift binary. The executor
// (reminders-executor.ts) is a thin spawn wrapper around these.
//
// This replaces the old AppleScript Reminders path (applescript-executor.ts +
// applescript-util.ts's escAS/parseReminders). EventKit fetches all reminders in one
// local-store query (no per-item Apple Event), fixing the 2026-06-04 timeout where
// reading ~339 reminders cost ~37s and blew the 28s ceiling.
//
// CLI contract (see src/eventkit-cli/main.swift): each subcommand emits exactly one
// JSON value to stdout. On failure it prints {"error":"…"} and exits nonzero, so
// parseCliJson() (reused from eventkit-util) treats an {error} object as a thrown error.

import { parseCliJson } from './eventkit-util.js';

export { parseCliJson };

export interface ReminderUpdateFields {
  name?: string;
  body?: string;
  completed?: boolean;
  dueDate?: string;
  priority?: number;
  remindMeDate?: string;
  url?: string;
  // RFC-2445 RRULE; "" clears recurrence (handled by the CLI). A non-empty rule
  // requires the reminder to have a due date (EventKit anchors recurrence to it).
  recurrence?: string;
}

export interface CreateReminderOptions {
  body?: string;
  dueDate?: string;
  priority?: number;
  remindMeDate?: string;
  url?: string;
  recurrence?: string;
}

// NOTE on the CLI's "dumb" arg parser (main.swift parseArgs): a `--flag` whose value
// starts with "--" is misread as a boolean flag. Reminder names/bodies starting with
// "--" are vanishingly rare; documented so the edge case isn't a surprise.

export function buildGetRemindersArgs(listName?: string, completed?: boolean): string[] {
  const args = ['get-reminders'];
  if (listName) args.push('--list', listName);
  // Default (completed undefined) => incomplete reminders, matching the old default.
  if (completed === true) args.push('--completed', 'true');
  return args;
}

export function buildSearchRemindersArgs(searchTerm: string, listName?: string): string[] {
  const args = ['search-reminders', '--term', searchTerm];
  if (listName) args.push('--list', listName);
  return args;
}

export function buildCreateReminderArgs(
  name: string,
  listName: string,
  options?: CreateReminderOptions,
): string[] {
  const args = ['create-reminder', '--list', listName, '--name', name];
  if (options?.body !== undefined) args.push('--body', options.body);
  if (options?.dueDate) args.push('--due', options.dueDate);
  if (options?.priority !== undefined) args.push('--priority', String(options.priority));
  if (options?.remindMeDate) args.push('--remind', options.remindMeDate);
  if (options?.url !== undefined) args.push('--url', options.url);
  // Skip empty recurrence — the CLI rejects "" as an invalid RRULE on create.
  if (options?.recurrence) args.push('--recurrence', options.recurrence);
  return args;
}

export function buildUpdateReminderArgs(id: string, updates: ReminderUpdateFields): string[] {
  const args = ['update-reminder', '--id', id];
  if (updates.name !== undefined) args.push('--name', updates.name);
  if (updates.body !== undefined) args.push('--body', updates.body);
  if (updates.completed !== undefined) args.push('--completed', String(updates.completed));
  // due: a date sets it; "" clears it (handled by the CLI). Pass through verbatim,
  // including the empty string, so "clear" works.
  if (updates.dueDate !== undefined) args.push('--due', updates.dueDate);
  if (updates.priority !== undefined) args.push('--priority', String(updates.priority));
  if (updates.remindMeDate !== undefined) args.push('--remind', updates.remindMeDate);
  if (updates.url !== undefined) args.push('--url', updates.url);
  // recurrence: a non-empty RRULE replaces; "" clears (handled by the CLI). Pass it
  // through verbatim including the empty string so "clear" works.
  if (updates.recurrence !== undefined) args.push('--recurrence', updates.recurrence);
  return args;
}

export function buildDeleteReminderArgs(id: string): string[] {
  return ['delete-reminder', '--id', id];
}
