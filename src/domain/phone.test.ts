import { describe, expect, it } from 'vitest';
import { formatPhone, normalisePhone } from './phone';

describe('phone numbers', () => {
  it('accepts what a person actually types and stores one shape', () => {
    for (const typed of ['613 555 0142', '(613) 555-0142', '6135550142', '+16135550142', '1-613-555-0142']) {
      expect(normalisePhone(typed)).toEqual({ ok: true, value: '+16135550142' });
    }
  });

  it('treats blank as "no number", which is a real state', () => {
    expect(normalisePhone('')).toEqual({ ok: true, value: null });
    expect(normalisePhone('   ')).toEqual({ ok: true, value: null });
  });

  it('rejects rather than guesses', () => {
    // A wrong number fails silently all weekend; a missing one shows up on the
    // readiness checklist. Refusing is the safer of the two.
    expect(normalisePhone('613 555 014').ok).toBe(false);
    expect(normalisePhone('call the coach').ok).toBe(false);
  });

  it('shows a number back the way it is written locally', () => {
    expect(formatPhone('+16135550142')).toBe('(613) 555-0142');
    // Anything unexpected is shown verbatim rather than mangled.
    expect(formatPhone('+442071234567')).toBe('+442071234567');
  });
});
