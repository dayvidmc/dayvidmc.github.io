/**
 * Contact details, normalised.
 *
 * Phone numbers arrive typed by a volunteer on a phone, so they arrive as
 * "613-555-0142", "(613) 555 0142", "6135550142" and "+1 613 555 0142". They
 * have to come out the other side identical, because an inbound text is
 * matched to a person by exact string comparison against this column — a
 * number stored one way and received another is a text nobody can place.
 */

export type NormalisedPhone =
  | { ok: true; value: string | null }
  | { ok: false; error: string };

export function normalisePhone(raw: string): NormalisedPhone {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, value: null };

  const digits = trimmed.replace(/[^\d+]/g, '');
  const bare = digits.replace(/^\+?1?/, '');
  if (bare.length !== 10 || !/^\d{10}$/.test(bare)) {
    return { ok: false, error: 'Needs 10 digits, e.g. 613 555 0142.' };
  }
  return { ok: true, value: `+1${bare}` };
}

export function looksLikeEmail(value: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
}

/** North American display form, for a number already normalised to +1XXXXXXXXXX. */
export function formatPhone(stored: string | null): string {
  if (!stored) return '';
  const bare = stored.replace(/^\+1/, '');
  if (bare.length !== 10) return stored;
  return `${bare.slice(0, 3)} ${bare.slice(3, 6)} ${bare.slice(6)}`;
}
