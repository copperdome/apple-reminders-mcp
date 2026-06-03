// ABOUTME: AppleScript execution utility for Reminders app integration

import { exec } from 'child_process';
import { promisify } from 'util';
import { escAS, parseReminders } from './applescript-util.js';

const execAsync = promisify(exec);

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
  priority: number;
  creationDate: string;
  modificationDate: string;
  flagged: boolean;
  tags: string[];
}

export class AppleScriptExecutor {
  private async executeScript(script: string): Promise<string> {
    try {
      // Use a single-quoted heredoc (same pattern as CalendarExecutor) instead of
      // `osascript -e '...'`. The old `-e` form wrapped the whole script in shell
      // single quotes and tried to escape inner apostrophes with `\'`, which is
      // INVALID inside a single-quoted /bin/sh string — any apostrophe in a reminder
      // name/body/list ("Mom's birthday") broke execution entirely. With <<'APPLESCRIPT'
      // the shell passes the script through literally; only AppleScript-level escaping
      // of " and \ (via escAS) is needed.
      const { stdout } = await execAsync(
        `osascript <<'APPLESCRIPT'\n${script}\nAPPLESCRIPT`,
        { timeout: 28000, maxBuffer: 10 * 1024 * 1024 }
      );
      return stdout.trim();
    } catch (error: any) {
      if (error.killed) {
        throw new Error('AppleScript timed out (28s) — Reminders may be syncing with iCloud. Try again in a moment.');
      }
      throw new Error(`AppleScript execution failed: ${error}`);
    }
  }

  async getReminderLists(): Promise<RemindersList[]> {
    // Use per-item §§§ separator instead of concatenating two lists with |||.
    // The old approach produced misaligned name/id pairs when the default iCloud
    // list's id was missing value (rendered as empty, shifting all subsequent IDs).
    const script = `
      tell application "Reminders"
        set outputStr to ""
        repeat with reminderList in every list
          set listName to name of reminderList as string
          set listId to ""
          try
            set listId to id of reminderList as string
          end try
          if outputStr is not "" then set outputStr to outputStr & (character id 10)
          set outputStr to outputStr & listName & "§§§" & listId
        end repeat
        return outputStr
      end tell
    `;
    const result = await this.executeScript(script);
    if (!result) return [];
    return result.split('\n').filter(l => l.trim()).map(line => {
      const sep = line.indexOf('§§§');
      return {
        name: sep >= 0 ? line.slice(0, sep) : line,
        id:   sep >= 0 ? line.slice(sep + 3) : '',
      };
    });
  }

  async getReminders(listName?: string, completed?: boolean): Promise<Reminder[]> {
    const completedVal = completed !== undefined ? completed : false;
    const listFilter = listName ? `in list "${escAS(listName)}"` : '';
    // Use "properties of rem" to fetch all scalar props in one Apple Event per reminder
    // instead of individual property accesses \u2014 ~3-4x faster for large lists.
    // container name still requires a separate call.
    const script = `
      tell application "Reminders"
        set targetReminders to every reminder ${listFilter} whose completed is ${completedVal}
        set reminderOutput to ""
        repeat with rem in targetReminders
          set props to properties of rem
          -- Reminders have NO recurrence property in the AppleScript dictionary
          -- (verified against reminders-dictionary.md), so none is emitted.
          set dueDateStr to "missing value"
          if (due date of props) is not missing value then
            set dueDateStr to (due date of props) as string
          end if
          set reminderInfo to (name of props as string)
          set reminderInfo to reminderInfo & "\u00a7\u00a7\u00a7" & (body of props as string)
          set reminderInfo to reminderInfo & "\u00a7\u00a7\u00a7" & (completed of props as string)
          set reminderInfo to reminderInfo & "\u00a7\u00a7\u00a7" & (name of container of rem as string)
          set reminderInfo to reminderInfo & "\u00a7\u00a7\u00a7" & (id of props as string)
          set reminderInfo to reminderInfo & "\u00a7\u00a7\u00a7" & (creation date of props as string)
          set reminderInfo to reminderInfo & "\u00a7\u00a7\u00a7" & (modification date of props as string)
          set reminderInfo to reminderInfo & "\u00a7\u00a7\u00a7" & (priority of props as string)
          set reminderInfo to reminderInfo & "\u00a7\u00a7\u00a7" & dueDateStr
          set reminderInfo to reminderInfo & "\u00a7\u00a7\u00a7" & (flagged of props as string)
          if reminderOutput is not "" then
            set reminderOutput to reminderOutput & (character id 10)
          end if
          set reminderOutput to reminderOutput & reminderInfo
        end repeat
        return reminderOutput
      end tell
    `;
    const result = await this.executeScript(script);
    return parseReminders(result);
  }

  async createReminder(
    name: string,
    listName: string,
    body?: string,
    dueDate?: string,
    priority?: number,
    flagged?: boolean,
    tags?: string[],
    earlyReminderMinutes?: number
  ): Promise<string> {
    // Duplicate guard: if a reminder with this name was created in the last 2 minutes
    // in the same list, return its ID instead of creating a new one. This handles the
    // common case where create succeeded but the MCP response timed out — retrying would
    // otherwise produce a duplicate.
    const safeName = escAS(name);
    const safeList = escAS(listName);
    const safeDue  = dueDate ? escAS(dueDate) : '';
    const checkScript = `
      tell application "Reminders"
        set targetList to list "${safeList}"
        set cutoffDate to (current date) - 120
        set matches to every reminder in targetList whose name is "${safeName}" and creation date >= cutoffDate and completed is false
        if (count of matches) > 0 then
          return "EXISTS:" & (id of item 1 of matches as string)
        end if
        return "NOTFOUND"
      end tell
    `;
    const checkResult = await this.executeScript(checkScript);
    if (checkResult.startsWith('EXISTS:')) {
      return checkResult.slice(7); // Return the existing reminder's ID
    }

    const bodyScript = body ? `set body of newReminder to "${escAS(body)}"` : '';
    const dueDateScript = dueDate ? `set due date of newReminder to date "${safeDue}"` : '';
    const priorityScript = priority !== undefined ? `set priority of newReminder to ${priority}` : '';
    const flaggedScript = flagged ? `set flagged of newReminder to true` : '';
    // Reminders have NO recurrence property in the AppleScript dictionary, so it is
    // neither settable here nor exposed on the tool schema (set recurrence manually in
    // the Reminders app if needed).
    // Use "remind me date" (official dict property) instead of alarm objects
    const remindMeScript = (dueDate && earlyReminderMinutes)
      ? `set remind me date of newReminder to (date "${safeDue}") - ${earlyReminderMinutes * 60}`
      : '';
    const script = `
      tell application "Reminders"
        set targetList to list "${safeList}"
        set newReminder to make new reminder in targetList
        set name of newReminder to "${safeName}"
        ${bodyScript}
        ${dueDateScript}
        ${priorityScript}
        ${flaggedScript}
        ${remindMeScript}
        return id of newReminder
      end tell
    `;
    return await this.executeScript(script);
  }

  async updateReminder(
    reminderId: string,
    updates: {
      name?: string;
      body?: string;
      completed?: boolean;
      dueDate?: string;
      priority?: number;
      flagged?: boolean;
      tags?: string[];
      remindMeDate?: string;
    }
  ): Promise<void> {
    const updateCommands: string[] = [];
    if (updates.name) updateCommands.push(`set name of targetReminder to "${escAS(updates.name)}"`);
    if (updates.body !== undefined) updateCommands.push(`set body of targetReminder to "${escAS(updates.body)}"`);
    if (updates.completed !== undefined) updateCommands.push(`set completed of targetReminder to ${updates.completed}`);
    if (updates.dueDate) updateCommands.push(`set due date of targetReminder to date "${escAS(updates.dueDate)}"`);
    if (updates.priority !== undefined) updateCommands.push(`set priority of targetReminder to ${updates.priority}`);
    if (updates.flagged !== undefined) updateCommands.push(`set flagged of targetReminder to ${updates.flagged}`);
    if (updates.remindMeDate) updateCommands.push(`set remind me date of targetReminder to date "${escAS(updates.remindMeDate)}"`);
    const script = `
      tell application "Reminders"
        set targetReminder to reminder id "${escAS(reminderId)}"
        ${updateCommands.join('\n        ')}
      end tell
    `;
    await this.executeScript(script);
  }

  async deleteReminder(reminderId: string): Promise<void> {
    const script = `
      tell application "Reminders"
        delete reminder id "${escAS(reminderId)}"
      end tell
    `;
    await this.executeScript(script);
  }

  async searchReminders(searchTerm: string, listName?: string): Promise<Reminder[]> {
    // Same "properties of rem" optimization as getReminders.
    // The name/body contains check still requires individual access on the first pass,
    // but once we have a match we batch the remaining properties.
    const safeTerm = escAS(searchTerm);
    const listFilter = listName ? `in list "${escAS(listName)}"` : '';
    const script = `
      tell application "Reminders"
        set allReminders to every reminder ${listFilter} whose completed is false
        set reminderOutput to ""
        repeat with rem in allReminders
          set props to properties of rem
          set remName to name of props as string
          set remBody to body of props as string
          if remName contains "${safeTerm}" or remBody contains "${safeTerm}" then
            -- Reminders have no recurrence property in the dictionary, so none is emitted.
            set dueDateStr to "missing value"
            if (due date of props) is not missing value then
              set dueDateStr to (due date of props) as string
            end if
            set reminderInfo to remName
            set reminderInfo to reminderInfo & "\u00a7\u00a7\u00a7" & remBody
            set reminderInfo to reminderInfo & "\u00a7\u00a7\u00a7" & (completed of props as string)
            set reminderInfo to reminderInfo & "\u00a7\u00a7\u00a7" & (name of container of rem as string)
            set reminderInfo to reminderInfo & "\u00a7\u00a7\u00a7" & (id of props as string)
            set reminderInfo to reminderInfo & "\u00a7\u00a7\u00a7" & (creation date of props as string)
            set reminderInfo to reminderInfo & "\u00a7\u00a7\u00a7" & (modification date of props as string)
            set reminderInfo to reminderInfo & "\u00a7\u00a7\u00a7" & (priority of props as string)
            set reminderInfo to reminderInfo & "\u00a7\u00a7\u00a7" & dueDateStr
            set reminderInfo to reminderInfo & "\u00a7\u00a7\u00a7" & (flagged of props as string)
            if reminderOutput is not "" then
              set reminderOutput to reminderOutput & (character id 10)
            end if
            set reminderOutput to reminderOutput & reminderInfo
          end if
        end repeat
        return reminderOutput
      end tell
    `;
    const result = await this.executeScript(script);
    return parseReminders(result);
  }
}
