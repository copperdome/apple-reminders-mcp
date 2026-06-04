// ABOUTME: Calendar app integration. Spawns the EventKit CLI (src/eventkit-cli)
// instead of AppleScript — EventKit reliably deletes recurring series on
// CalDAV/Google-backed calendars and properly expands recurrences, neither of which
// AppleScript could do. See docs/RESEARCH-caldav-recurring-delete.md and HANDOFF.md.
//
// This class, its CalendarInfo/CalendarEvent types, and the index.ts handlers are
// unchanged from the AppleScript implementation — only the execution path differs.
// All script-building / output-parsing logic is the pure (testable) layer in
// eventkit-util.ts; this file is just the spawn wrapper.

import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  buildGetEventsArgs,
  buildSearchEventsArgs,
  buildCreateEventArgs,
  buildUpdateEventArgs,
  buildDeleteEventArgs,
  parseCliJson,
} from './eventkit-util.js';

const execFileAsync = promisify(execFile);

export interface CalendarInfo {
  name: string;
  id: string;
  description: string;
  writable: boolean;
}

export interface CalendarEvent {
  uid: string;
  summary: string;
  description?: string;
  startDate: string;
  endDate: string;
  allDay: boolean;
  location?: string;
  status: string;
  recurrence?: string;
  url?: string;
  calendar: string;
}

// Resolve the compiled CLI binary relative to this module. At runtime this file is
// dist/calendar-executor.js, so the repo root is one level up from dist/. Built by
// `npm run build` (which runs src/eventkit-cli/build-eventkit.sh).
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const CLI_BINARY = join(MODULE_DIR, '..', 'src', 'eventkit-cli', 'build', 'eventkit-cli');

export class CalendarExecutor {
  private async runCli(args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync(CLI_BINARY, args, {
        timeout: 28000,
        maxBuffer: 10 * 1024 * 1024,
      });
      return stdout.trim();
    } catch (error: any) {
      if (error.killed) {
        throw new Error('EventKit CLI timed out (28s) — Calendar may be syncing. Try again in a moment.');
      }
      if (error.code === 'ENOENT') {
        throw new Error(
          `EventKit CLI binary not found at ${CLI_BINARY}. Build it with: npm run build ` +
          `(or: bash src/eventkit-cli/build-eventkit.sh).`
        );
      }
      // Nonzero exit: the CLI prints {"error":"…"} to stdout. Return it so parseCliJson
      // surfaces the real message (TCC denial, calendar-not-found, persisted-delete, …).
      if (typeof error.stdout === 'string' && error.stdout.trim()) {
        return error.stdout.trim();
      }
      throw new Error(`EventKit CLI failed: ${error.message ?? error}`);
    }
  }

  async getCalendars(): Promise<CalendarInfo[]> {
    const out = await this.runCli(['list-calendars']);
    return parseCliJson<CalendarInfo[]>(out);
  }

  async getEvents(calendarName?: string, startDate?: string, endDate?: string): Promise<CalendarEvent[]> {
    const out = await this.runCli(buildGetEventsArgs(calendarName, startDate, endDate));
    return parseCliJson<CalendarEvent[]>(out);
  }

  async createEvent(
    calendarName: string,
    summary: string,
    startDate: string,
    endDate: string,
    options?: {
      description?: string;
      location?: string;
      allDay?: boolean;
      recurrence?: string;
      url?: string;
    }
  ): Promise<string> {
    const out = await this.runCli(buildCreateEventArgs(calendarName, summary, startDate, endDate, options));
    return parseCliJson<{ uid: string }>(out).uid;
  }

  async updateEvent(
    uid: string,
    updates: {
      summary?: string;
      description?: string;
      startDate?: string;
      endDate?: string;
      location?: string;
      allDay?: boolean;
      recurrence?: string;
      url?: string;
    },
    // calendarName is accepted for interface compatibility but unused: EventKit
    // resolves the event by uid (calendarItemIdentifier) directly, no calendar scope.
    _calendarName?: string
  ): Promise<void> {
    if (Object.keys(updates).length === 0) return;
    const out = await this.runCli(buildUpdateEventArgs(uid, updates));
    parseCliJson<{ uid: string }>(out); // throws on {"error":…}
  }

  // calendarName accepted for interface compatibility but unused (resolved by uid).
  async deleteEvent(uid: string, _calendarName?: string): Promise<void> {
    const out = await this.runCli(buildDeleteEventArgs(uid));
    // Throws on {"error":…}, including the honest "remove reported success but N
    // occurrence(s) still exist" — which for EventKit should no longer happen on the
    // CalDAV/Google recurring series that defeated AppleScript.
    parseCliJson<{ deleted: boolean }>(out);
  }

  async searchEvents(searchTerm: string, calendarName?: string, startDate?: string, endDate?: string): Promise<CalendarEvent[]> {
    const out = await this.runCli(buildSearchEventsArgs(searchTerm, calendarName, startDate, endDate));
    return parseCliJson<CalendarEvent[]>(out);
  }
}
