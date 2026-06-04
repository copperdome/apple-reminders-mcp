// Regression tests for the pure (osascript-free) Mail helpers. Mirrors the
// applescript-util / eventkit-util test style. The risky layers here are the mailbox
// resolver (special-name shortcuts vs. account-scoped specifiers) and the §REC§/§§§
// parsers — exercise both, including the U+0001-joined recipient lists.
//
// Imports use no file extension so Vitest resolves the .ts source directly.

import { describe, it, expect } from 'vitest';
import {
  mailboxASExpr,
  parseMailboxes,
  parseMessages,
  parseMessageDetail,
  REC,
  FIELD,
  ADDR_SEP,
} from '../src/mail-util';

describe('mailboxASExpr', () => {
  it('defaults to the unified inbox when nothing is given', () => {
    expect(mailboxASExpr()).toBe('inbox');
    expect(mailboxASExpr(undefined, '  ')).toBe('inbox');
  });

  it('maps well-known names to app-level shortcuts (case-insensitive)', () => {
    expect(mailboxASExpr(undefined, 'Inbox')).toBe('inbox');
    expect(mailboxASExpr(undefined, 'SENT')).toBe('sent mailbox');
    expect(mailboxASExpr(undefined, 'Drafts')).toBe('drafts mailbox');
    expect(mailboxASExpr(undefined, 'junk')).toBe('junk mailbox');
    expect(mailboxASExpr(undefined, 'Trash')).toBe('trash mailbox');
    expect(mailboxASExpr(undefined, 'deleted')).toBe('trash mailbox');
    expect(mailboxASExpr(undefined, 'Outbox')).toBe('outbox');
  });

  it('builds an app-level specifier for an arbitrary mailbox name', () => {
    expect(mailboxASExpr(undefined, 'Receipts')).toBe('mailbox "Receipts"');
  });

  it('builds an account-scoped specifier when both are given (takes precedence over shortcuts)', () => {
    expect(mailboxASExpr('Work', 'Inbox')).toBe('mailbox "Inbox" of account "Work"');
    expect(mailboxASExpr('jbeck@copperdome.com', 'Receipts'))
      .toBe('mailbox "Receipts" of account "jbeck@copperdome.com"');
  });

  it('escapes double quotes in names (AppleScript literal safety)', () => {
    expect(mailboxASExpr(undefined, 'a "b" c')).toBe('mailbox "a \\"b\\" c"');
    expect(mailboxASExpr('acc"t', 'box')).toBe('mailbox "box" of account "acc\\"t"');
  });

  it('leaves apostrophes untouched (heredoc-safe, like escAS)', () => {
    expect(mailboxASExpr(undefined, "John's box")).toBe('mailbox "John\'s box"');
  });
});

describe('parseMailboxes', () => {
  it('returns [] for empty input', () => {
    expect(parseMailboxes('')).toEqual([]);
  });

  it('parses account/name/unreadCount records split on §REC§', () => {
    const out = parseMailboxes(['Work§§§Inbox§§§3', 'Work§§§Sent§§§0', 'iCloud§§§Inbox§§§12'].join(REC));
    expect(out).toEqual([
      { account: 'Work', name: 'Inbox', unreadCount: 3 },
      { account: 'Work', name: 'Sent', unreadCount: 0 },
      { account: 'iCloud', name: 'Inbox', unreadCount: 12 },
    ]);
  });

  it('coerces a non-numeric unread count to 0', () => {
    expect(parseMailboxes('A§§§B§§§missing value')[0].unreadCount).toBe(0);
  });

  it('ignores blank records', () => {
    expect(parseMailboxes(`${REC}A§§§B§§§1${REC}`)).toHaveLength(1);
  });
});

const summary = (over: Record<string, string> = {}) => {
  const f = {
    id: '42', subject: 'Hi', sender: 'Ann <ann@x.test>',
    dateSent: 'Mon', dateReceived: 'Tue', read: 'false', flagged: 'true',
    mailbox: 'Inbox', account: 'Work', ...over,
  };
  return [f.id, f.subject, f.sender, f.dateSent, f.dateReceived, f.read, f.flagged, f.mailbox, f.account].join(FIELD);
};

describe('parseMessages', () => {
  it('returns [] for empty input', () => {
    expect(parseMessages('')).toEqual([]);
  });

  it('parses a full summary record (9 fields, no detail fields)', () => {
    const [m] = parseMessages(summary());
    expect(m).toEqual({
      id: '42', subject: 'Hi', sender: 'Ann <ann@x.test>',
      dateSent: 'Mon', dateReceived: 'Tue', read: false, flagged: true,
      mailbox: 'Inbox', account: 'Work',
    });
    expect(m).not.toHaveProperty('content');
    expect(m).not.toHaveProperty('to');
  });

  it('splits multiple messages on §REC§ and reads booleans', () => {
    const out = parseMessages([summary({ id: '1', read: 'true', flagged: 'false' }), summary({ id: '2' })].join(REC));
    expect(out.map(m => m.id)).toEqual(['1', '2']);
    expect(out[0].read).toBe(true);
    expect(out[0].flagged).toBe(false);
  });

  it('maps "missing value" dates to undefined', () => {
    const [m] = parseMessages(summary({ dateSent: 'missing value', dateReceived: 'missing value' }));
    expect(m.dateSent).toBeUndefined();
    expect(m.dateReceived).toBeUndefined();
  });

  it('preserves a subject containing newlines (record sep is §REC§, not \\n)', () => {
    const [m] = parseMessages(summary({ subject: 'line1\nline2' }));
    expect(m.subject).toBe('line1\nline2');
  });
});

describe('parseMessageDetail', () => {
  it('returns undefined for empty input', () => {
    expect(parseMessageDetail('')).toBeUndefined();
    expect(parseMessageDetail('   ')).toBeUndefined();
  });

  it('parses summary + to/cc/messageId/content', () => {
    const rec = [
      summary({ id: '7', subject: 'Re: lunch' }),
      ['a@x.test', 'b@x.test'].join(ADDR_SEP), // to
      'c@x.test',                              // cc
      '<msg-1@mail>',                          // messageId
      'Hello,\n\nlet us meet.',                // content (real newlines survive)
    ].join(FIELD);
    const m = parseMessageDetail(rec)!;
    expect(m.id).toBe('7');
    expect(m.subject).toBe('Re: lunch');
    expect(m.to).toEqual(['a@x.test', 'b@x.test']);
    expect(m.cc).toEqual(['c@x.test']);
    expect(m.messageId).toBe('<msg-1@mail>');
    expect(m.content).toBe('Hello,\n\nlet us meet.');
  });

  it('maps empty / missing recipient and optional fields to undefined', () => {
    const rec = [summary(), '', 'missing value', 'missing value', 'body'].join(FIELD);
    const m = parseMessageDetail(rec)!;
    expect(m.to).toBeUndefined();
    expect(m.cc).toBeUndefined();
    expect(m.messageId).toBeUndefined();
    expect(m.content).toBe('body');
  });

  it('preserves commas inside a single recipient (joined on U+0001, not comma)', () => {
    const rec = [summary(), ['"Doe, John" <j@x.test>'].join(ADDR_SEP), '', '<id>', 'b'].join(FIELD);
    expect(parseMessageDetail(rec)!.to).toEqual(['"Doe, John" <j@x.test>']);
  });
});
