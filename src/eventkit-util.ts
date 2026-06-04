// ABOUTME: Pure (spawn-free) helpers for the EventKit Calendar CLI integration.
// These build the `--flag value` argument vectors passed to the eventkit-cli binary
// and parse its JSON output — extracted so they can be unit-tested without a Mac,
// the live Calendar app, or the compiled Swift binary. The executor
// (calendar-executor.ts) is just a thin spawn wrapper around these.
//
// CLI contract (see src/eventkit-cli/main.swift): each subcommand emits exactly one
// JSON value to stdout. On failure it prints {"error":"…"} and exits nonzero, so
// parseCliJson() treats an {error} object as a thrown error regardless of exit code.

import type { CalendarEvent, CalendarInfo } from './calendar-executor.js';

export interface CreateEventOptions {
  description?: string;
  location?: string;
  allDay?: boolean;
  recurrence?: string;
  url?: string;
}

export interface UpdateEventFields {
  summary?: string;
  description?: string;
  startDate?: string;
  endDate?: string;
  location?: string;
  allDay?: boolean;
  recurrence?: string;
  url?: string;
}

// NOTE on the CLI's "dumb" arg parser (main.swift parseArgs): a `--flag` whose value
// starts with "--" is misread as a boolean flag. Event titles/notes starting with
// "--" are vanishingly rare, so we don't defend against it here — documented so the
// edge case isn't a surprise.

export function buildGetEventsArgs(
  calendarName?: string,
  startDate?: string,
  endDate?: string,
): string[] {
  const args = ['get-events'];
  if (calendarName) args.push('--calendar', calendarName);
  if (startDate) args.push('--start', startDate);
  if (endDate) args.push('--end', endDate);
  return args;
}

export function buildSearchEventsArgs(
  searchTerm: string,
  calendarName?: string,
  startDate?: string,
  endDate?: string,
): string[] {
  const args = ['search-events', '--term', searchTerm];
  if (calendarName) args.push('--calendar', calendarName);
  if (startDate) args.push('--start', startDate);
  if (endDate) args.push('--end', endDate);
  return args;
}

export function buildCreateEventArgs(
  calendarName: string,
  summary: string,
  startDate: string,
  endDate: string,
  options?: CreateEventOptions,
): string[] {
  const args = [
    'create-event',
    '--calendar', calendarName,
    '--summary', summary,
    '--start', startDate,
    '--end', endDate,
  ];
  // create-event reads --all-day as a bare boolean flag (presence => true).
  if (options?.allDay) args.push('--all-day');
  if (options?.description !== undefined) args.push('--notes', options.description);
  if (options?.location !== undefined) args.push('--location', options.location);
  if (options?.url !== undefined) args.push('--url', options.url);
  // Skip empty recurrence — the CLI would reject "" as an invalid RRULE on create.
  if (options?.recurrence) args.push('--recurrence', options.recurrence);
  return args;
}

export function buildUpdateEventArgs(uid: string, updates: UpdateEventFields): string[] {
  const args = ['update-event', '--uid', uid];
  if (updates.summary !== undefined) args.push('--summary', updates.summary);
  if (updates.description !== undefined) args.push('--notes', updates.description);
  if (updates.startDate !== undefined) args.push('--start', updates.startDate);
  if (updates.endDate !== undefined) args.push('--end', updates.endDate);
  if (updates.location !== undefined) args.push('--location', updates.location);
  // update-event reads --all-day as an explicit boolean value (true|false).
  if (updates.allDay !== undefined) args.push('--all-day', String(updates.allDay));
  // recurrence: a non-empty RRULE replaces; "" clears (handled by the CLI). Pass it
  // through verbatim including the empty string so "clear" works.
  if (updates.recurrence !== undefined) args.push('--recurrence', updates.recurrence);
  if (updates.url !== undefined) args.push('--url', updates.url);
  return args;
}

export function buildDeleteEventArgs(uid: string): string[] {
  // The CLI resolves the event by uid globally and picks the span automatically
  // (.futureEvents for recurring, .thisEvent otherwise), so no calendar/span flags.
  return ['delete-event', '--uid', uid];
}

/**
 * Parse one JSON value from the CLI's stdout. If the value is an {"error":"…"}
 * object (the CLI's failure shape), throw with that message — this is how TCC
 * denials, "calendar not found", and the honest "delete persisted" error surface
 * to the caller. Non-JSON output (should never happen) throws a wrapped error.
 */
export function parseCliJson<T>(stdout: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`EventKit CLI returned non-JSON output: ${stdout.slice(0, 500)}`);
  }
  if (
    parsed !== null &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    typeof (parsed as { error?: unknown }).error === 'string'
  ) {
    throw new Error((parsed as { error: string }).error);
  }
  return parsed as T;
}

// Re-export the consumer types so tests can reference the parsed shapes if needed.
export type { CalendarEvent, CalendarInfo };
