// Regression tests for escAS — the one remaining pure helper in applescript-util.ts,
// shared by the Mail executor (Reminders and Calendar moved to the EventKit CLI; their
// parsers/date-helpers were removed with that port). Escaping is the layer where the
// 2026-06-03 critical bug lived ("Mom's birthday" broke under the old `-e` form).
//
// Imports use no file extension so Vitest resolves the .ts source directly.

import { describe, it, expect } from 'vitest';
import { escAS } from '../src/applescript-util';

describe('escAS', () => {
  it('escapes backslashes', () => {
    expect(escAS('a\\b')).toBe('a\\\\b');
  });

  it('escapes double quotes', () => {
    expect(escAS('say "hi"')).toBe('say \\"hi\\"');
  });

  it('escapes backslash BEFORE quote (order matters — no double-escaping the added backslash)', () => {
    // Input: backslash then quote.  Expect: escaped backslash (\\) then escaped quote (\").
    expect(escAS('\\"')).toBe('\\\\\\"');
  });

  it('leaves apostrophes untouched — the 2026-06-03 critical bug', () => {
    // The whole script is passed to osascript via a single-quoted heredoc, so the
    // shell never treats the apostrophe as a delimiter. Escaping it (the old `-e`
    // behavior) is what broke "Mom's birthday" entirely.
    expect(escAS("Mom's birthday")).toBe("Mom's birthday");
  });

  it('handles a mix of quotes and apostrophes', () => {
    expect(escAS(`quote "x" and apostrophe's`)).toBe(`quote \\"x\\" and apostrophe's`);
  });

  it('is a no-op for plain text', () => {
    expect(escAS('Buy milk')).toBe('Buy milk');
  });

  it('handles empty string', () => {
    expect(escAS('')).toBe('');
  });
});
