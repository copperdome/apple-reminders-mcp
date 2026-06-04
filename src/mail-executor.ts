// ABOUTME: Apple Mail integration (read tools) via AppleScript/osascript. Same execution
// model as the Reminders executor — a single-quoted heredoc (`osascript <<'APPLESCRIPT'`)
// so apostrophes survive the shell, with every user input escaped for AppleScript
// double-quote literals via escAS(). All script-generation / output-parsing logic lives
// in the pure, unit-tested mail-util.ts.
//
// Read docs/mail-dictionary.md before changing any of the script strings here — Mail's
// object model differs from both Reminders and Calendar (messages live in mailboxes
// which live in accounts; a message `id` is an integer libraryID; `message id` is the
// RFC header). See mail-util.ts header for the addressing rules.

import { exec } from 'child_process';
import { promisify } from 'util';
import {
  escAS,
  mailboxASExpr,
  dateFloorClause,
  filterMessages,
  parseMailboxes,
  parseMessages,
  parseMessageDetail,
  normalizeAddresses,
  buildRecipientLines,
  type Mailbox,
  type MailMessage,
} from './mail-util.js';

const execAsync = promisify(exec);

// AppleScript snippet (an expression) that builds one §§§-delimited summary record from a
// `msg` variable in scope. Shared by get_emails / search_emails / get_email so the field
// order stays in lockstep with summaryFromParts() in mail-util.ts. `mbxOfMsg` and
// `acctName` are computed just before this runs (see the per-message preamble below).
const SUMMARY_REC_EXPR =
  '((id of msg) as string) & "§§§" & ((subject of msg) as string) & "§§§" & ' +
  '((sender of msg) as string) & "§§§" & ((date sent of msg) as string) & "§§§" & ' +
  '((date received of msg) as string) & "§§§" & ((read status of msg) as string) & "§§§" & ' +
  '((flagged status of msg) as string) & "§§§" & ((name of mbxOfMsg) as string) & "§§§" & acctName';

// Per-message preamble: resolve the message's own mailbox + account (the unified inbox
// spans accounts, so this must be per-message, not taken from the queried mailbox).
const MSG_CONTEXT_PREAMBLE = `
          set mbxOfMsg to mailbox of msg
          set acctName to ""
          try
            set acctName to (name of (account of mbxOfMsg)) as string
          end try`;

export type { Mailbox, MailMessage };

// Default timeout for header-level ops (28s, same as Reminders/Calendar). get_email
// fetches the message BODY, which downloads on access for IMAP and is inherently slower,
// so it runs with a longer budget.
const DEFAULT_TIMEOUT_MS = 28000;
const BODY_TIMEOUT_MS = 55000;

// Scan caps for the filtered read paths. We never enumerate the whole folder; instead we
// walk messages by index up to a cap (within the date floor) and filter in TypeScript.
// These bound the worst-case Apple-Event count so a busy mailbox can't relock Mail.
const UNREAD_SCAN_CAP = 100;
const SEARCH_SCAN_CAP = 200;
const DEFAULT_DAYS_BACK = 30;

export class MailExecutor {
  private async executeScript(script: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<string> {
    try {
      // Single-quoted heredoc — identical rationale to AppleScriptExecutor (Reminders):
      // the shell passes the script through literally, so only AppleScript-level escaping
      // (via escAS) of " and \ is needed, and apostrophes are safe.
      const { stdout } = await execAsync(
        `osascript <<'APPLESCRIPT'\n${script}\nAPPLESCRIPT`,
        { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }
      );
      return stdout.trim();
    } catch (error: any) {
      if (error.killed) {
        throw new Error(
          `AppleScript timed out (${Math.round(timeoutMs / 1000)}s) — Mail may be syncing or ` +
          `prefetching IMAP headers. Narrow the query (smaller daysBack/limit, a specific mailbox) ` +
          `and retry once sync settles.`
        );
      }
      throw new Error(`AppleScript execution failed: ${error}`);
    }
  }

  // Build a script that walks up to `scanCap` messages of `mbxExpr` BY INDEX (no
  // `count of`, no per-property `whose` — both force full-folder enumeration and the
  // IMAP lockout) within an optional date floor, emitting one §§§ summary per message.
  // The try/exit-repeat termination means we stop at the end of the (bounded) set without
  // ever asking Mail how many messages exist.
  private buildScanScript(mbxExpr: string, daysBack: number | undefined, scanCap: number): string {
    const floor = dateFloorClause(daysBack);
    return `
      tell application "Mail"
        set theMailbox to ${mbxExpr}
        set theMessages to (messages of theMailbox${floor})
        set out to ""
        repeat with i from 1 to ${scanCap}
          try
            set msg to item i of theMessages
          on error
            exit repeat
          end try
          ${MSG_CONTEXT_PREAMBLE}
          set rec to ${SUMMARY_REC_EXPR}
          if out is not "" then set out to out & "§REC§"
          set out to out & rec
        end repeat
        return out
      end tell
    `;
  }

  /**
   * List mailboxes across all accounts (account, name, unread count). Top-level mailboxes
   * per account only — deeply nested sub-mailboxes are not recursed (v1 scope).
   */
  async getMailboxes(): Promise<Mailbox[]> {
    const script = `
      tell application "Mail"
        set out to ""
        repeat with acct in every account
          set acctName to (name of acct) as string
          repeat with mbx in (every mailbox of acct)
            set uc to 0
            try
              set uc to (unread count of mbx) as integer
            end try
            if out is not "" then set out to out & "§REC§"
            set out to out & acctName & "§§§" & ((name of mbx) as string) & "§§§" & (uc as string)
          end repeat
        end repeat
        return out
      end tell
    `;
    return parseMailboxes(await this.executeScript(script));
  }

  /**
   * Get message summaries from a mailbox (defaults to the unified Inbox). No body is
   * fetched here — use getEmail for full content.
   *
   * Two paths, both engineered to avoid Mail's IMAP lockout (full-folder enumeration):
   *  - default: walk the first `limit` messages BY INDEX only — minimal footprint, no
   *    date floor needed (the newest messages are always within reach by index).
   *  - `unreadOnly`: bound the scan with a date floor (`daysBack`, default 30) + a scan
   *    cap, then filter unread in TypeScript. Returns up to `limit` unread messages found
   *    within that recent window — older unread beyond the window/cap are not surfaced
   *    (widen `daysBack` to look back further).
   */
  async getEmails(opts: {
    mailbox?: string;
    account?: string;
    limit?: number;
    unreadOnly?: boolean;
    daysBack?: number;
  } = {}): Promise<MailMessage[]> {
    const mbx = mailboxASExpr(opts.account, opts.mailbox);
    const limit = Number.isFinite(opts.limit) && opts.limit! > 0 ? Math.floor(opts.limit!) : 25;
    if (opts.unreadOnly) {
      const daysBack = Number.isFinite(opts.daysBack) ? opts.daysBack! : DEFAULT_DAYS_BACK;
      const script = this.buildScanScript(mbx, daysBack, UNREAD_SCAN_CAP);
      const all = parseMessages(await this.executeScript(script));
      return filterMessages(all, { unreadOnly: true }).slice(0, limit);
    }
    // Unfiltered: no date floor, scan exactly `limit` by index.
    const script = this.buildScanScript(mbx, opts.daysBack, limit);
    return parseMessages(await this.executeScript(script));
  }

  /**
   * Fetch a single message in full (recipients, RFC message-id, body) by its integer id,
   * scoped to a mailbox (default Inbox). The id comes from getEmails / searchEmails.
   * Throws if no message with that id exists in the mailbox.
   */
  async getEmail(messageId: number, mailbox?: string, account?: string): Promise<MailMessage> {
    if (!Number.isFinite(messageId)) {
      throw new Error(`Invalid message id: ${messageId} (expected the integer id from get_emails/search_emails)`);
    }
    const id = Math.floor(messageId);
    const mbx = mailboxASExpr(account, mailbox);
    const script = `
      tell application "Mail"
        set theMailbox to ${mbx}
        set matches to (messages of theMailbox whose id is ${id})
        if (count of matches) is 0 then return "NOTFOUND"
        set msg to item 1 of matches
        ${MSG_CONTEXT_PREAMBLE}
        set toStr to ""
        repeat with r in (to recipients of msg)
          if toStr is not "" then set toStr to toStr & (ASCII character 1)
          set toStr to toStr & ((address of r) as string)
        end repeat
        set ccStr to ""
        repeat with r in (cc recipients of msg)
          if ccStr is not "" then set ccStr to ccStr & (ASCII character 1)
          set ccStr to ccStr & ((address of r) as string)
        end repeat
        set summaryRec to ${SUMMARY_REC_EXPR}
        return summaryRec & "§§§" & toStr & "§§§" & ccStr & "§§§" & ((message id of msg) as string) & "§§§" & ((content of msg) as string)
      end tell
    `;
    // Body downloads on access for IMAP — use the longer timeout.
    const result = await this.executeScript(script, BODY_TIMEOUT_MS);
    if (result === 'NOTFOUND') {
      throw new Error(`Message id ${id} not found in mailbox ${mailbox ?? 'Inbox'}${account ? ` (account ${account})` : ''}.`);
    }
    const msg = parseMessageDetail(result);
    if (!msg) throw new Error(`Message id ${id} could not be parsed from Mail's response.`);
    return msg;
  }

  /**
   * Search a mailbox (default Inbox) for messages whose subject OR sender contains the
   * term (case-insensitive). The matching is done in TypeScript over a bounded, date-
   * scoped batch of summaries — NOT via an AppleScript `whose … contains` clause, which
   * forces Mail to scan the whole folder and was a confirmed cause of the IMAP lockout.
   *
   * Consequence: search covers the most recent ~${SEARCH_SCAN_CAP} messages within
   * `daysBack` days (default 30). It does NOT scan message bodies and will not find older
   * matches outside that window — widen `daysBack` (and accept a slower call) to look
   * further back. `limit` caps the returned matches.
   */
  async searchEmails(searchTerm: string, opts: {
    mailbox?: string;
    account?: string;
    limit?: number;
    daysBack?: number;
  } = {}): Promise<MailMessage[]> {
    const mbx = mailboxASExpr(opts.account, opts.mailbox);
    const limit = Number.isFinite(opts.limit) && opts.limit! > 0 ? Math.floor(opts.limit!) : 25;
    const daysBack = Number.isFinite(opts.daysBack) ? opts.daysBack! : DEFAULT_DAYS_BACK;
    const script = this.buildScanScript(mbx, daysBack, SEARCH_SCAN_CAP);
    const all = parseMessages(await this.executeScript(script));
    return filterMessages(all, { term: searchTerm }).slice(0, limit);
  }

  // ── Mutating tools ─────────────────────────────────────────────────────────

  // Validate + floor a message id for safe inlining into a `whose id is N` filter
  // (ids are never user free-text, but never inline an unchecked number all the same).
  private requireId(messageId: number): number {
    if (!Number.isFinite(messageId)) {
      throw new Error(`Invalid message id: ${messageId} (expected the integer id from get_emails/search_emails)`);
    }
    return Math.floor(messageId);
  }

  // Run a script that locates a message by id and acts on it. The script must return
  // "OK" on success or "NOTFOUND" if no message with that id exists in the mailbox.
  private async runMessageAction(
    id: number,
    mailbox: string | undefined,
    account: string | undefined,
    actionLines: string,
  ): Promise<void> {
    const mbx = mailboxASExpr(account, mailbox);
    const script = `
      tell application "Mail"
        set theMailbox to ${mbx}
        set matches to (messages of theMailbox whose id is ${id})
        if (count of matches) is 0 then return "NOTFOUND"
        set msg to item 1 of matches
        ${actionLines}
        return "OK"
      end tell
    `;
    const result = await this.executeScript(script);
    if (result === 'NOTFOUND') {
      throw new Error(`Message id ${id} not found in mailbox ${mailbox ?? 'Inbox'}${account ? ` (account ${account})` : ''}.`);
    }
  }

  /** Mark a message read or unread by id (scoped to a mailbox, default Inbox). */
  async setReadStatus(messageId: number, read: boolean, mailbox?: string, account?: string): Promise<void> {
    const id = this.requireId(messageId);
    await this.runMessageAction(id, mailbox, account, `set read status of msg to ${read ? 'true' : 'false'}`);
  }

  /**
   * Move a message (by id, from a source mailbox/account) to a destination mailbox.
   * The destination is resolved the same way as any mailbox (well-known names → unified
   * mailbox; destAccount scopes it to one account).
   */
  async moveEmail(
    messageId: number,
    destMailbox: string,
    opts: { mailbox?: string; account?: string; destAccount?: string } = {},
  ): Promise<void> {
    const id = this.requireId(messageId);
    if (!destMailbox || !destMailbox.trim()) throw new Error('moveEmail requires a destination mailbox.');
    const destExpr = mailboxASExpr(opts.destAccount, destMailbox);
    await this.runMessageAction(id, opts.mailbox, opts.account, `move msg to (${destExpr})`);
  }

  /**
   * Trash a message by id (Mail's `delete` moves it to the account's Trash, honoring the
   * account's "move deleted messages to trash" setting). Scoped to a mailbox (default Inbox).
   */
  async trashEmail(messageId: number, mailbox?: string, account?: string): Promise<void> {
    const id = this.requireId(messageId);
    await this.runMessageAction(id, mailbox, account, `delete msg`);
  }

  // ── Sending ────────────────────────────────────────────────────────────────

  /**
   * Compose and SEND a new email immediately (no draft, no visible window). `to` may be a
   * single comma-separated string or an array; cc/bcc likewise. `sender` optionally sets
   * the From address (must be one of the account's configured addresses, else Mail errors).
   */
  async sendEmail(opts: {
    to: string | string[];
    subject: string;
    body: string;
    cc?: string | string[];
    bcc?: string | string[];
    sender?: string;
  }): Promise<void> {
    const to = normalizeAddresses(opts.to);
    if (to.length === 0) throw new Error('sendEmail requires at least one "to" recipient.');
    const cc = normalizeAddresses(opts.cc);
    const bcc = normalizeAddresses(opts.bcc);
    const senderLine = opts.sender ? `set sender of newMsg to "${escAS(opts.sender)}"` : '';
    const script = `
      tell application "Mail"
        set newMsg to make new outgoing message with properties {subject:"${escAS(opts.subject ?? '')}", content:"${escAS(opts.body ?? '')}", visible:false}
        ${senderLine}
        tell newMsg
          ${buildRecipientLines('to', to)}
          ${buildRecipientLines('cc', cc)}
          ${buildRecipientLines('bcc', bcc)}
        end tell
        send newMsg
      end tell
    `;
    await this.executeScript(script);
  }

  /**
   * Reply to a message (by id, scoped to a mailbox) and SEND immediately. The reply keeps
   * Mail's quoted original; `body` is prepended above it. `replyAll` replies to all
   * recipients instead of just the sender.
   */
  async replyToEmail(
    messageId: number,
    body: string,
    opts: { mailbox?: string; account?: string; replyAll?: boolean } = {},
  ): Promise<void> {
    const id = this.requireId(messageId);
    const mbx = mailboxASExpr(opts.account, opts.mailbox);
    const script = `
      tell application "Mail"
        set theMailbox to ${mbx}
        set matches to (messages of theMailbox whose id is ${id})
        if (count of matches) is 0 then return "NOTFOUND"
        set originalMsg to item 1 of matches
        set replyMsg to reply originalMsg opening window false reply to all ${opts.replyAll ? 'true' : 'false'}
        tell replyMsg
          set content to "${escAS(body ?? '')}" & return & return & (content)
        end tell
        send replyMsg
        return "OK"
      end tell
    `;
    const result = await this.executeScript(script);
    if (result === 'NOTFOUND') {
      throw new Error(`Message id ${id} not found in mailbox ${opts.mailbox ?? 'Inbox'}${opts.account ? ` (account ${opts.account})` : ''}.`);
    }
  }
}
