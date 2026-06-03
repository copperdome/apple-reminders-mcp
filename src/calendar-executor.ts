// ABOUTME: AppleScript execution utility for Calendar app integration

import { exec } from 'child_process';
import { promisify } from 'util';
import { escAS, isoToAppleScriptDate, parseEvents, interpretDeleteResult } from './applescript-util.js';

const execAsync = promisify(exec);

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

export class CalendarExecutor {
  private async executeScript(script: string): Promise<string> {
    try {
      // Use heredoc to avoid shell-escaping issues with AppleScript's apostrophes
      const { stdout } = await execAsync(
        `osascript <<'APPLESCRIPT'\n${script}\nAPPLESCRIPT`,
        { timeout: 28000, maxBuffer: 10 * 1024 * 1024 }
      );
      return stdout.trim();
    } catch (error: any) {
      if (error.killed) {
        throw new Error('AppleScript timed out (28s) — Calendar may be syncing. Try again in a moment.');
      }
      throw new Error(`AppleScript execution failed: ${error}`);
    }
  }

  async getCalendars(): Promise<CalendarInfo[]> {
    // NOTE: Calendar objects do NOT support "properties of cal" (returns AppleEvent -10000).
    // Must access each property individually. This affects ~5-20 objects so performance is fine.
    const script = `
      tell application "Calendar"
        set outputStr to ""
        repeat with cal in every calendar
          set calName to ""
          set calId to ""
          set calDesc to ""
          set calWritable to "false"
          try
            set calName to name of cal as string
          end try
          try
            -- NOTE: returns "" on this account's CalDAV/Google calendars (verified
            -- 2026-06-03). An "id of cal" fallback was tried and confirmed to also
            -- yield "" — neither term resolves an id here. Targeting is by name
            -- everywhere, so a blank id is cosmetic.
            set calId to calendarIdentifier of cal as string
          end try
          try
            set calDesc to description of cal as string
          end try
          try
            set calWritable to writable of cal as string
          end try
          set calInfo to calName & "§§§" & calId & "§§§" & calDesc & "§§§" & calWritable
          if outputStr is not "" then set outputStr to outputStr & (character id 10)
          set outputStr to outputStr & calInfo
        end repeat
        return outputStr
      end tell
    `;
    const result = await this.executeScript(script);
    if (!result) return [];
    return result.split('\n').filter(l => l.trim()).map(line => {
      const p = line.split('§§§');
      return {
        name:        p[0] || '',
        id:          p[1] || '',
        description: p[2] || '',
        writable:    p[3] === 'true',
      };
    });
  }

  async getEvents(calendarName?: string, startDate?: string, endDate?: string): Promise<CalendarEvent[]> {
    // Build calendar target block
    const calBlock = calendarName
      ? `set targetCals to {calendar "${calendarName}"}`
      : `set targetCals to every calendar`;

    // Build date filter. If no dates given, TypeScript layer always supplies them.
    const startBlock = startDate
      ? `set startFilter to date "${isoToAppleScriptDate(startDate)}"`
      : `set startFilter to missing value`;
    const endBlock = endDate
      ? `set endFilter to date "${isoToAppleScriptDate(endDate)}"`
      : `set endFilter to missing value`;

    const script = `
      tell application "Calendar"
        ${startBlock}
        ${endBlock}
        ${calBlock}
        set output to {}
        repeat with cal in targetCals
          set calName to name of cal as string
          set calEvents to {}
          if startFilter is not missing value and endFilter is not missing value then
            set calEvents to every event of cal whose start date >= startFilter and start date <= endFilter
          else if startFilter is not missing value then
            set calEvents to every event of cal whose start date >= startFilter
          else
            set calEvents to every event of cal
          end if
          repeat with ev in calEvents
            set evUid to uid of ev as string
            set evSummary to summary of ev as string
            set evDesc to "missing value"
            try
              set evDesc to description of ev as string
              -- sanitize newlines in description
              set saveTID to AppleScript's text item delimiters
              set AppleScript's text item delimiters to (character id 10)
              set descParts to text items of evDesc
              set AppleScript's text item delimiters to "\\n"
              set evDesc to descParts as string
              set AppleScript's text item delimiters to (character id 13)
              set descParts to text items of evDesc
              set AppleScript's text item delimiters to "\\n"
              set evDesc to descParts as string
              set AppleScript's text item delimiters to saveTID
            end try
            set evStart to start date of ev as string
            set evEnd to end date of ev as string
            set evAllDay to allday event of ev as string
            set evLoc to "missing value"
            try
              set evLoc to location of ev as string
              -- sanitize newlines in location
              set saveTID to AppleScript's text item delimiters
              set AppleScript's text item delimiters to (character id 10)
              set locParts to text items of evLoc
              set AppleScript's text item delimiters to "\\n"
              set evLoc to locParts as string
              set AppleScript's text item delimiters to (character id 13)
              set locParts to text items of evLoc
              set AppleScript's text item delimiters to "\\n"
              set evLoc to locParts as string
              set AppleScript's text item delimiters to saveTID
            end try
            set evStatus to status of ev as string
            set evRecur to "missing value"
            try
              set evRecur to recurrence of ev as string
            end try
            set evUrl to "missing value"
            try
              set evUrl to url of ev as string
            end try
            set evLine to evUid & "§§§" & evSummary & "§§§" & evDesc & "§§§" & evStart & "§§§" & evEnd & "§§§" & evAllDay & "§§§" & evLoc & "§§§" & evStatus & "§§§" & evRecur & "§§§" & evUrl & "§§§" & calName
            set end of output to evLine
          end repeat
        end repeat
        set outputStr to ""
        repeat with lineItem in output
          if outputStr is not "" then set outputStr to outputStr & "§REC§"
          set outputStr to outputStr & lineItem
        end repeat
        return outputStr
      end tell
    `;
    const result = await this.executeScript(script);
    return parseEvents(result);
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
    const startStr = isoToAppleScriptDate(startDate);
    const endStr   = isoToAppleScriptDate(endDate);

    const props: string[] = [
      `summary:"${escAS(summary)}"`,
      `start date:date "${startStr}"`,
      `end date:date "${endStr}"`,
    ];
    if (options?.allDay)       props.push('allday event:true');
    if (options?.description)  props.push(`description:"${escAS(options.description)}"`);
    if (options?.location)     props.push(`location:"${escAS(options.location)}"`);
    if (options?.recurrence)   props.push(`recurrence:"${escAS(options.recurrence)}"`);
    if (options?.url)          props.push(`url:"${escAS(options.url)}"`);

    const script = `
      tell application "Calendar"
        tell calendar "${calendarName}"
          set newEvent to make new event with properties {${props.join(', ')}}
          return uid of newEvent
        end tell
      end tell
    `;
    return await this.executeScript(script);
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
    calendarName?: string
  ): Promise<void> {
    const cmds: string[] = [];
    if (updates.summary !== undefined)
      cmds.push(`set summary of targetEvent to "${escAS(updates.summary)}"`);
    if (updates.description !== undefined)
      cmds.push(`set description of targetEvent to "${escAS(updates.description)}"`);
    if (updates.startDate !== undefined)
      cmds.push(`set start date of targetEvent to date "${isoToAppleScriptDate(updates.startDate)}"`);
    if (updates.endDate !== undefined)
      cmds.push(`set end date of targetEvent to date "${isoToAppleScriptDate(updates.endDate)}"`);
    if (updates.location !== undefined)
      cmds.push(`set location of targetEvent to "${escAS(updates.location)}"`);
    if (updates.allDay !== undefined)
      cmds.push(`set allday event of targetEvent to ${updates.allDay}`);
    if (updates.recurrence !== undefined)
      cmds.push(`set recurrence of targetEvent to "${escAS(updates.recurrence)}"`);
    if (updates.url !== undefined)
      cmds.push(`set url of targetEvent to "${escAS(updates.url)}"`);

    if (cmds.length === 0) return;

    // If calendarName provided, scope the search to that calendar — avoids scanning all calendars.
    const calTarget = calendarName
      ? `set targetCals to {calendar "${calendarName}"}`
      : `set targetCals to every calendar`;

    const script = `
      tell application "Calendar"
        ${calTarget}
        set targetEvent to missing value
        repeat with cal in targetCals
          set matches to every event of cal whose uid = "${uid}"
          if (count of matches) > 0 then
            set targetEvent to item 1 of matches
            exit repeat
          end if
        end repeat
        if targetEvent is missing value then error "Event UID not found: ${uid}"
        ${cmds.join('\n        ')}
      end tell
    `;
    await this.executeScript(script);
  }

  async deleteEvent(uid: string, calendarName?: string): Promise<void> {
    // If calendarName provided, scope the search to that calendar — avoids scanning all calendars.
    const calTarget = calendarName
      ? `set targetCals to {calendar "${calendarName}"}`
      : `set targetCals to every calendar`;

    // Use "delete every event of cal whose uid = X" rather than finding item 1 and
    // deleting it. For non-recurring events (and recurring series on local/iCloud
    // calendars) this removes the event/series.
    //
    // KNOWN LIMITATION: on CalDAV / Google-backed calendars, deleting a *recurring*
    // series via AppleScript reports success but the master event persists and
    // regenerates the occurrences. To avoid the previous silent-success lie, we
    // re-query after the delete and report whether the event is actually gone, so
    // the caller gets an honest error instead of a false "deleted".
    const script = `
      tell application "Calendar"
        ${calTarget}
        set deletedCount to 0
        repeat with cal in targetCals
          set matches to every event of cal whose uid = "${uid}"
          if (count of matches) > 0 then
            delete every event of cal whose uid = "${uid}"
            set deletedCount to deletedCount + 1
            exit repeat
          end if
        end repeat
        if deletedCount is 0 then return "NOTFOUND"
        -- Verify the delete actually took (CalDAV recurring series often survive).
        set stillThere to 0
        repeat with cal in targetCals
          set remaining to every event of cal whose uid = "${uid}"
          set stillThere to stillThere + (count of remaining)
        end repeat
        if stillThere > 0 then return "PERSISTED"
        return "OK"
      end tell
    `;
    const result = await this.executeScript(script);
    interpretDeleteResult(result, uid);
  }

  async searchEvents(searchTerm: string, calendarName?: string, startDate?: string, endDate?: string): Promise<CalendarEvent[]> {
    const calBlock = calendarName
      ? `set targetCals to {calendar "${calendarName}"}`
      : `set targetCals to every calendar`;

    // Apply search window (default ±1 year). Without a date filter "every event of cal"
    // fetches entire calendar history and reliably times out on large datasets.
    const now = new Date();
    const resolvedStart = startDate ? new Date(startDate) : (() => { const d = new Date(now); d.setFullYear(d.getFullYear() - 1); return d; })();
    const resolvedEnd   = endDate   ? new Date(endDate)   : (() => { const d = new Date(now); d.setFullYear(d.getFullYear() + 1); return d; })();
    // Pass Date objects directly — avoids the toISOString() UTC roundtrip that would
    // shift times in non-UTC timezones.
    const startStr = isoToAppleScriptDate(resolvedStart);
    const endStr   = isoToAppleScriptDate(resolvedEnd);

    const script = `
      tell application "Calendar"
        ${calBlock}
        set startFilter to date "${startStr}"
        set endFilter to date "${endStr}"
        set outputStr to ""
        repeat with cal in targetCals
          set calName to name of cal as string
          set calEvents to every event of cal whose start date >= startFilter and start date <= endFilter
          repeat with ev in calEvents
            set evSummary to summary of ev as string
            -- Read description once; reuse for both the search check and the output.
            set evDescRaw to ""
            set evDescIsSet to false
            try
              set evDescRaw to description of ev as string
              set evDescIsSet to true
            end try
            if evSummary contains "${searchTerm}" or evDescRaw contains "${searchTerm}" then
              set evUid to uid of ev as string
              -- Sanitize description newlines for output (reuse the already-fetched value)
              set evDescVal to "missing value"
              if evDescIsSet then
                set evDescVal to evDescRaw
                set saveTID to AppleScript's text item delimiters
                set AppleScript's text item delimiters to (character id 10)
                set descParts to text items of evDescVal
                set AppleScript's text item delimiters to "\\n"
                set evDescVal to descParts as string
                set AppleScript's text item delimiters to (character id 13)
                set descParts to text items of evDescVal
                set AppleScript's text item delimiters to "\\n"
                set evDescVal to descParts as string
                set AppleScript's text item delimiters to saveTID
              end if
              set evStart to start date of ev as string
              set evEnd to end date of ev as string
              set evAllDay to allday event of ev as string
              set evLoc to "missing value"
              try
                set evLoc to location of ev as string
                set saveTID to AppleScript's text item delimiters
                set AppleScript's text item delimiters to (character id 10)
                set locParts to text items of evLoc
                set AppleScript's text item delimiters to "\\n"
                set evLoc to locParts as string
                set AppleScript's text item delimiters to (character id 13)
                set locParts to text items of evLoc
                set AppleScript's text item delimiters to "\\n"
                set evLoc to locParts as string
                set AppleScript's text item delimiters to saveTID
              end try
              set evStatus to status of ev as string
              set evRecur to "missing value"
              try
                set evRecur to recurrence of ev as string
              end try
              set evUrl to "missing value"
              try
                set evUrl to url of ev as string
              end try
              set evLine to evUid & "§§§" & evSummary & "§§§" & evDescVal & "§§§" & evStart & "§§§" & evEnd & "§§§" & evAllDay & "§§§" & evLoc & "§§§" & evStatus & "§§§" & evRecur & "§§§" & evUrl & "§§§" & calName
              if outputStr is not "" then set outputStr to outputStr & "§REC§"
              set outputStr to outputStr & evLine
            end if
          end repeat
        end repeat
        return outputStr
      end tell
    `;
    const result = await this.executeScript(script);
    return parseEvents(result);
  }
}
