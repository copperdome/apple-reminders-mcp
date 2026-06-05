// ABOUTME: Reminders app integration. Spawns the EventKit CLI (src/eventkit-cli)
// instead of AppleScript — EventKit fetches all reminders in a single local-store
// query (no per-item Apple Event), fixing the timeout where reading ~339 reminders via
// AppleScript cost ~37s and blew the 28s ceiling (2026-06-04). Replaces the old
// AppleScriptExecutor / applescript-executor.ts.
//
// The class method signatures and the Reminder/RemindersList types index.ts depends on
// are preserved (Reminder is EXPANDED with fields AppleScript couldn't reach:
// startDate, completionDate, remindMeDate, url). All arg-building / output-parsing
// logic is the pure (testable) layer in reminders-util.ts; this file is the spawn
// wrapper, mirroring calendar-executor.ts.

import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
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
  type ReminderUpdateFields,
} from './reminders-util.js';

const execFileAsync = promisify(execFile);

export interface RemindersList {
  name: string;
  id: string;
}

export interface Reminder {
  id: string;
  name: string;
  body?: string;
  completed: boolean;
  list: string;
  dueDate?: string;
  // Expanded EventKit surface (not available via AppleScript):
  startDate?: string;
  completionDate?: string;
  remindMeDate?: string;
  url?: string;
  priority: number;
  creationDate: string;
  modificationDate: string;
  // RFC-2445 RRULE string (first rule), present only when the reminder recurs.
  // EKReminder supports recurrence via the inherited EKCalendarItem.recurrenceRules.
  recurrence?: string;
  // SQLite-sourced enrichment for the four Reminders features EventKit can't read.
  // Present only when Full Disk Access is granted (the CLI reads the Reminders store);
  // OMITTED — never false/[] — otherwise, so absent ≠ false. parentId is the parent
  // reminder's id; isSubtask is true only when parentId is present. See RemindersDB.swift.
  flagged?: boolean;
  tags?: string[];
  parentId?: string;
  isSubtask?: boolean;
  section?: string;
}

// Resolve the compiled CLI binary relative to this module. At runtime this file is
// dist/reminders-executor.js, so the repo root is one level up from dist/. Built by
// `npm run build` (which runs src/eventkit-cli/build-eventkit.sh).
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const CLI_BINARY = join(MODULE_DIR, '..', 'src', 'eventkit-cli', 'build', 'eventkit-cli');

export class RemindersExecutor {
  private async runCli(args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync(CLI_BINARY, args, {
        timeout: 28000,
        maxBuffer: 10 * 1024 * 1024,
      });
      return stdout.trim();
    } catch (error: any) {
      if (error.killed) {
        throw new Error('EventKit CLI timed out (28s) — Reminders may be syncing. Try again in a moment.');
      }
      if (error.code === 'ENOENT') {
        throw new Error(
          `EventKit CLI binary not found at ${CLI_BINARY}. Build it with: npm run build ` +
          `(or: bash src/eventkit-cli/build-eventkit.sh).`
        );
      }
      // Nonzero exit: the CLI prints {"error":"…"} to stdout. Return it so parseCliJson
      // surfaces the real message (TCC denial, list-not-found, persisted-delete, …).
      if (typeof error.stdout === 'string' && error.stdout.trim()) {
        return error.stdout.trim();
      }
      throw new Error(`EventKit CLI failed: ${error.message ?? error}`);
    }
  }

  async getReminderLists(): Promise<RemindersList[]> {
    const out = await this.runCli(['list-reminder-lists']);
    return parseCliJson<RemindersList[]>(out);
  }

  async getReminders(listName?: string, completed?: boolean): Promise<Reminder[]> {
    const out = await this.runCli(buildGetRemindersArgs(listName, completed));
    return parseCliJson<Reminder[]>(out);
  }

  async searchReminders(searchTerm: string, listName?: string): Promise<Reminder[]> {
    const out = await this.runCli(buildSearchRemindersArgs(searchTerm, listName));
    return parseCliJson<Reminder[]>(out);
  }

  async createReminder(
    name: string,
    listName: string,
    body?: string,
    dueDate?: string,
    priority?: number,
    earlyReminderMinutes?: number,
    recurrence?: string,
  ): Promise<string> {
    // earlyReminderMinutes: if a due date and an early-reminder offset are given,
    // compute the remind time (due − offset). Otherwise the CLI defaults an alarm to
    // the due time so the reminder actually notifies.
    let remindMeDate: string | undefined;
    if (dueDate && earlyReminderMinutes) {
      const due = new Date(dueDate);
      if (!isNaN(due.getTime())) {
        remindMeDate = new Date(due.getTime() - earlyReminderMinutes * 60_000).toISOString();
      }
    }
    const out = await this.runCli(
      buildCreateReminderArgs(name, listName, { body, dueDate, priority, remindMeDate, recurrence }),
    );
    return parseCliJson<{ id: string }>(out).id;
  }

  async updateReminder(
    reminderId: string,
    updates: ReminderUpdateFields,
  ): Promise<void> {
    if (Object.keys(updates).length === 0) return;
    const out = await this.runCli(buildUpdateReminderArgs(reminderId, updates));
    parseCliJson<{ id: string }>(out); // throws on {"error":…}
  }

  async deleteReminder(reminderId: string): Promise<void> {
    const out = await this.runCli(buildDeleteReminderArgs(reminderId));
    parseCliJson<{ deleted: boolean }>(out); // throws on {"error":…}
  }

  // ── WRITES via private ReminderKit (Phase 2) ──────────────────────────────
  // Set the fields EventKit can't: flagged, #hashtag tags, subtask, section.
  // `reminderId` is the reminder's id (== ZCKIDENTIFIER). Each throws on {"error":…}.

  async setFlagged(reminderId: string, flagged: boolean): Promise<void> {
    const out = await this.runCli(buildSetFlaggedArgs(reminderId, flagged));
    parseCliJson<{ ok: boolean }>(out);
  }

  async addTags(reminderId: string, tags: string[]): Promise<void> {
    const out = await this.runCli(buildAddTagsArgs(reminderId, tags));
    parseCliJson<{ ok: boolean }>(out);
  }

  // Adds a new child reminder under `parentId`; returns nothing (ReminderKit owns the id).
  async addSubtask(parentId: string, name: string): Promise<void> {
    const out = await this.runCli(buildAddSubtaskArgs(parentId, name));
    parseCliJson<{ ok: boolean }>(out);
  }

  async assignSection(reminderId: string, section: string): Promise<void> {
    const out = await this.runCli(buildAssignSectionArgs(reminderId, section));
    parseCliJson<{ ok: boolean }>(out);
  }
}
