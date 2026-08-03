/**
 * Phone numbers.
 *
 * A number is how the system recognises an inbound text (§5.2) and the only
 * way it can send one. A number saved as "613-555-0142" never matches the
 * "+16135550142" Twilio delivers, and the symptom — a volunteer's reply landing
 * on the unmatched screen for no visible reason — gives no hint of the cause.
 *
 * So every number entered anywhere goes through here first.
 */

export type PhoneResult =
  | { ok: true; value: string | null }
  | { ok: false; error: string };

/**
 * Normalise to E.164. Blank is allowed and means "no number", which is a real
 * state for a team: the readiness checklist counts them.
 *
 * North American numbers only, because this tournament is in Kanata and every
 * team travels to it. A number that does not fit is rejected rather than
 * guessed at — a wrong number is worse than a missing one, since a missing one
 * shows up on the checklist and a wrong one just silently fails all weekend.
 */
export function normalisePhone(raw: string): PhoneResult {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, value: null };

  const digits = trimmed.replace(/[^\d+]/g, '');
  const bare = digits.replace(/^\+?1?/, '');
  if (bare.length !== 10 || !/^\d{10}$/.test(bare)) {
    return { ok: false, error: 'Needs 10 digits, e.g. 613 555 0142.' };
  }
  return { ok: true, value: `+1${bare}` };
}

/** `(613) 555-0142` — how a number is shown back to a person. */
export function formatPhone(e164: string): string {
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  if (!match) return e164;
  return `(${match[1]}) ${match[2]}-${match[3]}`;
}
