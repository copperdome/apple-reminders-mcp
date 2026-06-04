// ABOUTME: MCP server exposing both Apple Reminders and Apple Calendar via AppleScript

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { AppleScriptExecutor } from './applescript-executor.js';
import { CalendarExecutor } from './calendar-executor.js';
import { MailExecutor } from './mail-executor.js';

class AppleMCPServer {
  private server: Server;
  private reminders: AppleScriptExecutor;
  private calendar: CalendarExecutor;
  private mail: MailExecutor;

  constructor() {
    this.server = new Server(
      { name: 'apple-mcp', version: '2.0.0' },
      { capabilities: { tools: {} } }
    );
    this.reminders = new AppleScriptExecutor();
    this.calendar  = new CalendarExecutor();
    this.mail      = new MailExecutor();
    this.setupToolHandlers();
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          // ── Reminders ──────────────────────────────────────────────
          {
            name: 'list_reminder_lists',
            description: 'Get all reminder lists in the Reminders app',
            inputSchema: { type: 'object', properties: {} },
          },
          {
            name: 'get_reminders',
            description: 'Get reminders from a specific list or all lists. Returns flagged, dueDate, priority. Pass searchTerm to filter by text (routes to search internally — prefer search_reminders for pure text search).',
            inputSchema: {
              type: 'object',
              properties: {
                listName:   { type: 'string',  description: 'Reminder list name (optional)' },
                completed:  {                  description: 'Filter by completion status (optional, default false)' },
                searchTerm: { type: 'string',  description: 'Filter by name or body text (optional)' },
              },
            },
          },
          {
            name: 'create_reminder',
            description: 'Create a new reminder. Supports flagged, priority, dueDate, body, and early alarm.',
            inputSchema: {
              type: 'object',
              properties: {
                name:                 { type: 'string', description: 'Reminder name' },
                listName:             { type: 'string', description: 'List to add it to' },
                body:                 { type: 'string', description: 'Notes/body (optional)' },
                dueDate:              { type: 'string', description: 'Due date, e.g. "April 8, 2026 at 7:30 AM" (optional)' },
                priority:             {                 description: '0=none 1=high 5=medium 9=low (optional)' },
                flagged:              {                 description: 'Flag the reminder (optional)' },
                tags:                 {                 description: 'Tag strings — not supported by AppleScript, stored for future use' },
                earlyReminderMinutes: {                 description: 'Minutes before due date for early alert (optional)' },
              },
              required: ['name', 'listName'],
            },
          },
          {
            name: 'update_reminder',
            description: 'Update a reminder by ID.',
            inputSchema: {
              type: 'object',
              properties: {
                reminderId:     { type: 'string', description: 'Reminder ID' },
                name:           { type: 'string' },
                body:           { type: 'string' },
                completed:      {                 description: 'Mark complete/incomplete' },
                dueDate:        { type: 'string' },
                priority:       {                 description: '0=none 1=high 5=medium 9=low' },
                flagged:        {                 description: 'Set flagged status' },
                tags:           {                 description: 'Not supported via AppleScript, ignored' },
                remindMeDate:   { type: 'string', description: 'Explicit remind-me date/time' },
              },
              required: ['reminderId'],
            },
          },
          {
            name: 'delete_reminder',
            description: 'Delete a reminder by ID',
            inputSchema: {
              type: 'object',
              properties: {
                reminderId: { type: 'string', description: 'Reminder ID' },
              },
              required: ['reminderId'],
            },
          },
          {
            name: 'search_reminders',
            description: 'Search incomplete reminders by name or body text. Equivalent to get_reminders with a searchTerm — use this for quick text searches, get_reminders when you also need to filter by list or completion status.',
            inputSchema: {
              type: 'object',
              properties: {
                searchTerm: { type: 'string', description: 'Text to search for' },
                listName:   { type: 'string', description: 'Limit search to a specific list (optional — omit to search all lists)' },
              },
              required: ['searchTerm'],
            },
          },

          // ── Calendar ───────────────────────────────────────────────
          {
            name: 'list_calendars',
            description: 'List all calendars in the Calendar app (name, id, description, writable).',
            inputSchema: { type: 'object', properties: {} },
          },
          {
            name: 'get_events',
            description: 'Get events from one or all calendars, with optional date range. Defaults to today + 30 days if no dates provided. Returns uid, summary, dates, location, recurrence, status.',
            inputSchema: {
              type: 'object',
              properties: {
                calendarName: { type: 'string', description: 'Calendar name to filter (optional — omit for all)' },
                startDate:    { type: 'string', description: 'ISO 8601 start, e.g. "2026-04-08T00:00:00" (optional)' },
                endDate:      { type: 'string', description: 'ISO 8601 end, e.g. "2026-05-08T23:59:59" (optional)' },
              },
            },
          },
          {
            name: 'create_event',
            description: 'Create a calendar event. Recurrence works via RFC 2445 RRULE strings (unlike Reminders). Returns the new event UID.',
            inputSchema: {
              type: 'object',
              properties: {
                calendarName: { type: 'string', description: 'Calendar to add the event to' },
                summary:      { type: 'string', description: 'Event title' },
                startDate:    { type: 'string', description: 'ISO 8601 start, e.g. "2026-04-10T14:00:00"' },
                endDate:      { type: 'string', description: 'ISO 8601 end, e.g. "2026-04-10T15:00:00"' },
                description:  { type: 'string', description: 'Event notes (optional)' },
                location:     { type: 'string', description: 'Event location (optional)' },
                allDay:       {                 description: 'True for all-day event (optional)' },
                recurrence:   { type: 'string', description: 'RFC 2445 RRULE, e.g. "FREQ=WEEKLY;BYDAY=MO,WE,FR" (optional). NOTE: recurrence IS writable in Calendar (unlike Reminders).' },
                url:          { type: 'string', description: 'URL to associate with event (optional)' },
              },
              required: ['calendarName', 'summary', 'startDate', 'endDate'],
            },
          },
          {
            name: 'update_event',
            description: 'Update a calendar event by UID. Find UIDs with get_events or search_events. Pass calendarName to speed up the UID lookup.',
            inputSchema: {
              type: 'object',
              properties: {
                uid:          { type: 'string', description: 'Event UID (from get_events or create_event)' },
                calendarName: { type: 'string', description: 'Calendar the event is in — optional but speeds up lookup' },
                summary:      { type: 'string', description: 'New title (optional)' },
                description:  { type: 'string', description: 'New notes (optional)' },
                startDate:    { type: 'string', description: 'New ISO 8601 start (optional)' },
                endDate:      { type: 'string', description: 'New ISO 8601 end (optional)' },
                location:     { type: 'string', description: 'New location (optional)' },
                allDay:       {                 description: 'Change all-day status (optional)' },
                recurrence:   { type: 'string', description: 'New RRULE or empty string to clear (optional)' },
                url:          { type: 'string', description: 'New URL (optional)' },
              },
              required: ['uid'],
            },
          },
          {
            name: 'delete_event',
            description: 'Delete a calendar event by UID. For recurring events, deletes the entire series. Pass calendarName to speed up the UID lookup.',
            inputSchema: {
              type: 'object',
              properties: {
                uid:          { type: 'string', description: 'Event UID' },
                calendarName: { type: 'string', description: 'Calendar the event is in — optional but speeds up lookup' },
              },
              required: ['uid'],
            },
          },
          {
            name: 'search_events',
            description: 'Search events by text in summary or description across all (or one) calendar. Defaults to a ±1 year window; pass startDate/endDate to search outside that range.',
            inputSchema: {
              type: 'object',
              properties: {
                searchTerm:   { type: 'string', description: 'Text to search for' },
                calendarName: { type: 'string', description: 'Limit search to one calendar (optional)' },
                startDate:    { type: 'string', description: 'ISO 8601 start of search window, e.g. "2024-01-01T00:00:00" (optional, defaults to 1 year ago)' },
                endDate:      { type: 'string', description: 'ISO 8601 end of search window, e.g. "2027-01-01T00:00:00" (optional, defaults to 1 year from now)' },
              },
              required: ['searchTerm'],
            },
          },

          // ── Mail ───────────────────────────────────────────────────
          {
            name: 'list_mailboxes',
            description: 'List mailboxes across all Mail accounts (account, name, unread count). Top-level mailboxes per account.',
            inputSchema: { type: 'object', properties: {} },
          },
          {
            name: 'get_emails',
            description: 'Get message summaries (id, subject, sender, dates, read/flagged status) from a mailbox. Defaults to the unified Inbox. No body is fetched — use get_email for full content. Returns the integer id needed to address a message in get_email.',
            inputSchema: {
              type: 'object',
              properties: {
                mailbox:    { type: 'string', description: 'Mailbox name. Well-known names (Inbox, Sent, Drafts, Junk, Trash, Outbox) map to the unified mailbox spanning accounts. Omit for Inbox.' },
                account:    { type: 'string', description: 'Account name — scopes the mailbox to one account (optional).' },
                limit:      {                 description: 'Max messages to return (optional, default 25), in Mail\'s default order (typically newest first).' },
                unreadOnly: {                 description: 'Only return unread messages (optional).' },
              },
            },
          },
          {
            name: 'get_email',
            description: 'Fetch one message in full — recipients, RFC message-id, and body — by its integer id (from get_emails/search_emails), scoped to a mailbox (default Inbox).',
            inputSchema: {
              type: 'object',
              properties: {
                messageId: {                 description: 'The integer message id from get_emails/search_emails' },
                mailbox:   { type: 'string', description: 'Mailbox the message is in (optional, default Inbox)' },
                account:   { type: 'string', description: 'Account the mailbox belongs to (optional)' },
              },
              required: ['messageId'],
            },
          },
          {
            name: 'search_emails',
            description: 'Search a mailbox (default Inbox) for messages whose subject OR sender contains the term (case-insensitive). Does NOT scan message bodies (that would force a full download). Returns summaries.',
            inputSchema: {
              type: 'object',
              properties: {
                searchTerm: { type: 'string', description: 'Text to match in subject or sender' },
                mailbox:    { type: 'string', description: 'Mailbox to search (optional, default Inbox)' },
                account:    { type: 'string', description: 'Account to scope the mailbox to (optional)' },
                limit:      {                 description: 'Max results (optional, default 25)' },
              },
              required: ['searchTerm'],
            },
          },
          {
            name: 'mark_email',
            description: 'Mark a message read or unread by its integer id (from get_emails/search_emails), scoped to a mailbox (default Inbox).',
            inputSchema: {
              type: 'object',
              properties: {
                messageId: {                 description: 'The integer message id' },
                read:      {                 description: 'true = mark read, false = mark unread' },
                mailbox:   { type: 'string', description: 'Mailbox the message is in (optional, default Inbox)' },
                account:   { type: 'string', description: 'Account the mailbox belongs to (optional)' },
              },
              required: ['messageId', 'read'],
            },
          },
          {
            name: 'move_email',
            description: 'Move a message (by integer id) from its mailbox to a destination mailbox.',
            inputSchema: {
              type: 'object',
              properties: {
                messageId:   {                 description: 'The integer message id' },
                destMailbox: { type: 'string', description: 'Destination mailbox name (well-known names map to the unified mailbox)' },
                mailbox:     { type: 'string', description: 'Source mailbox the message is currently in (optional, default Inbox)' },
                account:     { type: 'string', description: 'Source account (optional)' },
                destAccount: { type: 'string', description: 'Account that owns the destination mailbox (optional)' },
              },
              required: ['messageId', 'destMailbox'],
            },
          },
          {
            name: 'trash_email',
            description: 'Move a message (by integer id) to Trash. Honors the account\'s deleted-messages setting.',
            inputSchema: {
              type: 'object',
              properties: {
                messageId: {                 description: 'The integer message id' },
                mailbox:   { type: 'string', description: 'Mailbox the message is in (optional, default Inbox)' },
                account:   { type: 'string', description: 'Account the mailbox belongs to (optional)' },
              },
              required: ['messageId'],
            },
          },
          {
            name: 'send_email',
            description: 'Compose and SEND a new email immediately (no draft, no window). to/cc/bcc accept a single comma-separated string or an array of addresses.',
            inputSchema: {
              type: 'object',
              properties: {
                to:      { description: 'Recipient address(es) — string (comma-separated) or array' },
                subject: { type: 'string', description: 'Subject line' },
                body:    { type: 'string', description: 'Plain-text body' },
                cc:      { description: 'CC address(es) (optional)' },
                bcc:     { description: 'BCC address(es) (optional)' },
                sender:  { type: 'string', description: 'From address — must be one of your configured account addresses (optional)' },
              },
              required: ['to', 'subject', 'body'],
            },
          },
          {
            name: 'reply_to_email',
            description: 'Reply to a message (by integer id, scoped to a mailbox) and SEND immediately. Your body is prepended above Mail\'s quoted original.',
            inputSchema: {
              type: 'object',
              properties: {
                messageId: {                 description: 'The integer message id to reply to' },
                body:      { type: 'string', description: 'Your reply text (prepended above the quoted original)' },
                mailbox:   { type: 'string', description: 'Mailbox the original is in (optional, default Inbox)' },
                account:   { type: 'string', description: 'Account the mailbox belongs to (optional)' },
                replyAll:  {                 description: 'Reply to all recipients instead of just the sender (optional)' },
              },
              required: ['messageId', 'body'],
            },
          },
        ],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const args = (request.params.arguments ?? {}) as Record<string, any>;

        switch (request.params.name) {

          // ── Reminders ──────────────────────────────────────────────

          case 'list_reminder_lists': {
            const lists = await this.reminders.getReminderLists();
            return { content: [{ type: 'text', text: JSON.stringify(lists, null, 2) }] };
          }

          case 'get_reminders': {
            const listName   = args.listName as string | undefined;
            const searchTerm = args.searchTerm as string | undefined;
            const completed  = args.completed !== undefined
              ? (args.completed === true || args.completed === 'true')
              : undefined;
            let reminders;
            if (searchTerm) {
              reminders = await this.reminders.searchReminders(searchTerm);
              if (listName)   reminders = reminders.filter(r => r.list === listName);
              if (completed !== undefined) reminders = reminders.filter(r => r.completed === completed);
            } else {
              reminders = await this.reminders.getReminders(listName, completed);
            }
            return { content: [{ type: 'text', text: JSON.stringify(reminders, null, 2) }] };
          }

          case 'create_reminder': {
            const reminderId = await this.reminders.createReminder(
              args.name as string,
              args.listName as string,
              args.body as string | undefined,
              args.dueDate as string | undefined,
              args.priority !== undefined ? Number(args.priority) : undefined,
              args.flagged !== undefined ? (args.flagged === true || args.flagged === 'true') : undefined,
              args.tags !== undefined ? (typeof args.tags === 'string' ? JSON.parse(args.tags) : args.tags) : undefined,
              args.earlyReminderMinutes !== undefined ? Number(args.earlyReminderMinutes) : undefined,
            );
            return { content: [{ type: 'text', text: `Reminder created: ${reminderId}` }] };
          }

          case 'update_reminder': {
            const updates: any = {};
            if (args.name      !== undefined) updates.name      = args.name;
            if (args.body      !== undefined) updates.body      = args.body;
            if (args.completed !== undefined) updates.completed = args.completed === true || args.completed === 'true';
            if (args.dueDate   !== undefined) updates.dueDate   = args.dueDate;
            if (args.priority  !== undefined) updates.priority  = Number(args.priority);
            if (args.flagged   !== undefined) updates.flagged   = args.flagged === true || args.flagged === 'true';
            if (args.tags      !== undefined) updates.tags      = typeof args.tags === 'string' ? JSON.parse(args.tags) : args.tags;
            if (args.remindMeDate   !== undefined) updates.remindMeDate   = args.remindMeDate;
            await this.reminders.updateReminder(args.reminderId as string, updates);
            return { content: [{ type: 'text', text: `Reminder ${args.reminderId} updated` }] };
          }

          case 'delete_reminder': {
            await this.reminders.deleteReminder(args.reminderId as string);
            return { content: [{ type: 'text', text: `Reminder ${args.reminderId} deleted` }] };
          }

          case 'search_reminders': {
            const reminders = await this.reminders.searchReminders(
              args.searchTerm as string,
              args.listName   as string | undefined,
            );
            return { content: [{ type: 'text', text: JSON.stringify(reminders, null, 2) }] };
          }

          // ── Calendar ───────────────────────────────────────────────

          case 'list_calendars': {
            const calendars = await this.calendar.getCalendars();
            return { content: [{ type: 'text', text: JSON.stringify(calendars, null, 2) }] };
          }

          case 'get_events': {
            const calendarName = args.calendarName as string | undefined;
            // Default date window: today to today + 30 days if neither provided
            const now = new Date();
            const defaultEnd = new Date(now);
            defaultEnd.setDate(defaultEnd.getDate() + 30);
            const startDate = (args.startDate as string | undefined) ?? now.toISOString();
            const endDate   = (args.endDate   as string | undefined) ?? defaultEnd.toISOString();
            const events = await this.calendar.getEvents(calendarName, startDate, endDate);
            return { content: [{ type: 'text', text: JSON.stringify(events, null, 2) }] };
          }

          case 'create_event': {
            const uid = await this.calendar.createEvent(
              args.calendarName as string,
              args.summary      as string,
              args.startDate    as string,
              args.endDate      as string,
              {
                description: args.description as string | undefined,
                location:    args.location    as string | undefined,
                allDay:      args.allDay !== undefined ? (args.allDay === true || args.allDay === 'true') : undefined,
                recurrence:  args.recurrence  as string | undefined,
                url:         args.url         as string | undefined,
              },
            );
            return { content: [{ type: 'text', text: `Event created. UID: ${uid}` }] };
          }

          case 'update_event': {
            const updates: any = {};
            if (args.summary     !== undefined) updates.summary     = args.summary;
            if (args.description !== undefined) updates.description = args.description;
            if (args.startDate   !== undefined) updates.startDate   = args.startDate;
            if (args.endDate     !== undefined) updates.endDate     = args.endDate;
            if (args.location    !== undefined) updates.location    = args.location;
            if (args.allDay      !== undefined) updates.allDay      = args.allDay === true || args.allDay === 'true';
            if (args.recurrence  !== undefined) updates.recurrence  = args.recurrence;
            if (args.url         !== undefined) updates.url         = args.url;
            await this.calendar.updateEvent(args.uid as string, updates, args.calendarName as string | undefined);
            return { content: [{ type: 'text', text: `Event ${args.uid} updated` }] };
          }

          case 'delete_event': {
            await this.calendar.deleteEvent(args.uid as string, args.calendarName as string | undefined);
            return { content: [{ type: 'text', text: `Event ${args.uid} deleted` }] };
          }

          case 'search_events': {
            const events = await this.calendar.searchEvents(
              args.searchTerm   as string,
              args.calendarName as string | undefined,
              args.startDate    as string | undefined,
              args.endDate      as string | undefined,
            );
            return { content: [{ type: 'text', text: JSON.stringify(events, null, 2) }] };
          }

          // ── Mail ───────────────────────────────────────────────────

          case 'list_mailboxes': {
            const mailboxes = await this.mail.getMailboxes();
            return { content: [{ type: 'text', text: JSON.stringify(mailboxes, null, 2) }] };
          }

          case 'get_emails': {
            const emails = await this.mail.getEmails({
              mailbox:    args.mailbox as string | undefined,
              account:    args.account as string | undefined,
              limit:      args.limit !== undefined ? Number(args.limit) : undefined,
              unreadOnly: args.unreadOnly !== undefined ? (args.unreadOnly === true || args.unreadOnly === 'true') : undefined,
            });
            return { content: [{ type: 'text', text: JSON.stringify(emails, null, 2) }] };
          }

          case 'get_email': {
            const email = await this.mail.getEmail(
              Number(args.messageId),
              args.mailbox as string | undefined,
              args.account as string | undefined,
            );
            return { content: [{ type: 'text', text: JSON.stringify(email, null, 2) }] };
          }

          case 'search_emails': {
            const emails = await this.mail.searchEmails(
              args.searchTerm as string,
              {
                mailbox: args.mailbox as string | undefined,
                account: args.account as string | undefined,
                limit:   args.limit !== undefined ? Number(args.limit) : undefined,
              },
            );
            return { content: [{ type: 'text', text: JSON.stringify(emails, null, 2) }] };
          }

          case 'mark_email': {
            const read = args.read === true || args.read === 'true';
            await this.mail.setReadStatus(
              Number(args.messageId),
              read,
              args.mailbox as string | undefined,
              args.account as string | undefined,
            );
            return { content: [{ type: 'text', text: `Message ${args.messageId} marked ${read ? 'read' : 'unread'}` }] };
          }

          case 'move_email': {
            await this.mail.moveEmail(
              Number(args.messageId),
              args.destMailbox as string,
              {
                mailbox:     args.mailbox as string | undefined,
                account:     args.account as string | undefined,
                destAccount: args.destAccount as string | undefined,
              },
            );
            return { content: [{ type: 'text', text: `Message ${args.messageId} moved to ${args.destMailbox}` }] };
          }

          case 'trash_email': {
            await this.mail.trashEmail(
              Number(args.messageId),
              args.mailbox as string | undefined,
              args.account as string | undefined,
            );
            return { content: [{ type: 'text', text: `Message ${args.messageId} moved to Trash` }] };
          }

          case 'send_email': {
            await this.mail.sendEmail({
              to:      args.to as string | string[],
              subject: args.subject as string,
              body:    args.body as string,
              cc:      args.cc as string | string[] | undefined,
              bcc:     args.bcc as string | string[] | undefined,
              sender:  args.sender as string | undefined,
            });
            return { content: [{ type: 'text', text: 'Email sent' }] };
          }

          case 'reply_to_email': {
            await this.mail.replyToEmail(
              Number(args.messageId),
              args.body as string,
              {
                mailbox:  args.mailbox as string | undefined,
                account:  args.account as string | undefined,
                replyAll: args.replyAll !== undefined ? (args.replyAll === true || args.replyAll === 'true') : undefined,
              },
            );
            return { content: [{ type: 'text', text: `Reply sent to message ${args.messageId}` }] };
          }

          default:
            throw new Error(`Unknown tool: ${request.params.name}`);
        }
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Apple MCP server running on stdio (Reminders + Calendar + Mail)');
  }
}

const server = new AppleMCPServer();
server.run().catch(console.error);
