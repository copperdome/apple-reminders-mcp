// ABOUTME: Pure (osascript-free) helpers for the Mail executor — AppleScript escaping
// (re-used from applescript-util), the mailbox-resolver expression builder, and the
// §REC§/§§§ output parsers. Extracted so they can be unit-tested without a Mac or the
// live Mail app, exactly like applescript-util.ts (Reminders) and eventkit-util.ts
// (Calendar). Add a regression test here whenever you touch escaping, the mailbox
// resolver, or the delimiter parsers.
//
// Mail's object model differs from BOTH Reminders and Calendar (see
// docs/mail-dictionary.md — read it before changing the script strings in
// mail-executor.ts). Notably: a message's `id` is an INTEGER libraryID (unique within
// the local store), `message id` is the RFC Message-ID header, and messages live inside
// mailboxes which live inside accounts — there is no app-level "message id X" lookup, so
// addressing a single message needs (mailbox [, account], id).

import { escAS } from './applescript-util.js';

export { escAS };

export interface Mailbox {
  account: string;
  name: string;
  unreadCount: number;
}

export interface MailMessage {
  id: string;            // Mail's integer libraryID, as a string
  subject: string;
  sender: string;        // fully-formatted "Name <addr>" as Mail returns it
  dateSent?: string;
  dateReceived?: string;
  read: boolean;
  flagged: boolean;
  mailbox: string;
  account: string;
  // Detail-only (get_email) — undefined on the list/search summaries:
  to?: string[];
  cc?: string[];
  messageId?: string;    // the RFC Message-ID header string
  content?: string;
}

// Record/field separators shared with the executor's script strings. Recipient
// addresses are joined with U+0001 (an address's display form can contain commas, so
// comma is unsafe); the script emits it via `(ASCII character 1)`.
export const REC = '§REC§';
export const FIELD = '§§§';
export const ADDR_SEP = String.fromCharCode(1);

// Field order emitted by the message scripts. The detail script appends to/cc/messageId/
// content after the shared summary fields, so a summary record is a prefix of a detail
// record — parseMessages reads the first 9, parseMessageDetail reads all of them.
//   0 id  1 subject  2 sender  3 dateSent  4 dateReceived  5 read  6 flagged
//   7 mailbox  8 account  [9 to  10 cc  11 messageId  12 content]

/**
 * Build the AppleScript expression that resolves to a single Mail mailbox.
 *
 * Order of preference:
 *  - account + mailbox → `mailbox "<m>" of account "<a>"` (most specific / unambiguous)
 *  - mailbox only, a well-known unified name (inbox/sent/drafts/junk/trash/outbox) →
 *    the app-level shortcut property, which spans all accounts
 *  - mailbox only, anything else → `mailbox "<m>"` (first match at the app level)
 *  - neither → `inbox` (the unified Inbox)
 *
 * The returned string is a bare specifier meant to be used INSIDE a `tell application
 * "Mail"` block. Names are escaped for AppleScript double-quote literals via escAS.
 */
export function mailboxASExpr(account?: string, mailbox?: string): string {
  const special: Record<string, string> = {
    inbox: 'inbox',
    sent: 'sent mailbox',
    'sent mailbox': 'sent mailbox',
    drafts: 'drafts mailbox',
    draft: 'drafts mailbox',
    junk: 'junk mailbox',
    trash: 'trash mailbox',
    deleted: 'trash mailbox',
    outbox: 'outbox',
  };
  const a = account?.trim();
  const m = mailbox?.trim();
  if (a && m) return `mailbox "${escAS(m)}" of account "${escAS(a)}"`;
  if (m) {
    const shortcut = special[m.toLowerCase()];
    if (shortcut) return shortcut;
    return `mailbox "${escAS(m)}"`;
  }
  return 'inbox';
}

/**
 * Parse the §REC§-record / §§§-field mailbox listing emitted by the list-mailboxes
 * script. One mailbox per record: account §§§ name §§§ unreadCount.
 */
export function parseMailboxes(result: string): Mailbox[] {
  if (!result) return [];
  return result.split(REC).filter(r => r.trim()).map(rec => {
    const p = rec.split(FIELD);
    return {
      account: p[0] || '',
      name: p[1] || '',
      unreadCount: parseInt(p[2], 10) || 0,
    };
  });
}

function summaryFromParts(p: string[]): MailMessage {
  return {
    id: p[0] || '',
    subject: p[1] || '',
    sender: p[2] || '',
    dateSent: (p[3] && p[3] !== 'missing value') ? p[3] : undefined,
    dateReceived: (p[4] && p[4] !== 'missing value') ? p[4] : undefined,
    read: p[5] === 'true',
    flagged: p[6] === 'true',
    mailbox: p[7] || '',
    account: p[8] || '',
  };
}

/**
 * Parse the §REC§/§§§ message summaries emitted by get-emails / search-emails.
 * Reads only the 9 shared summary fields; detail-only fields are left undefined.
 */
export function parseMessages(result: string): MailMessage[] {
  if (!result) return [];
  return result.split(REC).filter(r => r.trim()).map(rec => summaryFromParts(rec.split(FIELD)));
}

function splitAddrs(s: string): string[] | undefined {
  if (!s || s === 'missing value') return undefined;
  const list = s.split(ADDR_SEP).map(a => a.trim()).filter(Boolean);
  return list.length ? list : undefined;
}

/**
 * Parse the single detailed message record emitted by get-email. Same 9 summary fields
 * plus to (9), cc (10), messageId (11), and content (12, last). Recipient lists are
 * joined with U+0001 in the script (commas are unsafe — display names contain them).
 * Content is the LAST field and the record separator is §REC§ (not newline), so raw
 * newlines in the body survive intact and need no encoding. Returns undefined if the
 * script produced no record.
 */
export function parseMessageDetail(result: string): MailMessage | undefined {
  if (!result || !result.trim()) return undefined;
  const p = result.split(REC)[0].split(FIELD);
  const msg = summaryFromParts(p);
  msg.to = splitAddrs(p[9]);
  msg.cc = splitAddrs(p[10]);
  msg.messageId = (p[11] && p[11] !== 'missing value') ? p[11] : undefined;
  msg.content = (p[12] !== undefined && p[12] !== 'missing value') ? p[12] : undefined;
  return msg;
}
