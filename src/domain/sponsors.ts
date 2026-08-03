/**
 * Sponsors, and the two things they are actually owed.
 *
 * A sponsor gives money, or goods, or a day of their staff's labour, and what
 * they want back is not complicated: their name in the pamphlet, and somebody
 * to say thank you afterwards and mean it. Both of those have failed before —
 * not through carelessness but because the promise lived in an inbox and the
 * pamphlet had a print deadline nobody was tracking against it.
 *
 * So this module answers two questions and nothing else:
 *
 *   - **Whose name still has to reach the printer, and by when.**
 *   - **Who has not been thanked, and what would the letter say.**
 *
 * A thank-you that can say what the gift earned — "your barbecue went for
 * $320" — is a different letter from one that thanks somebody vaguely for their
 * support, and the difference is whether they give again.
 */

export interface SponsorGift {
  /** 'cash' | 'goods' | 'services'. Kept apart because only two are receiptable. */
  kind: 'cash' | 'goods' | 'services';
  what: string;
  /** What it was worth, or null where nobody put a value on it. */
  valueCents: number | null;
  /** What it actually fetched, when it went through the auction. */
  earnedCents: number | null;
}

export interface Sponsor {
  id: string;
  name: string;
  pamphletName: string | null;
  promised: string | null;
  pamphletConfirmedAt: Date | null;
  thankedAt: Date | null;
  contactEmail: string | null;
  gifts: SponsorGift[];
}

export interface SponsorTotals {
  cashCents: number;
  goodsValueCents: number;
  /** What their goods actually fetched, which is the number worth writing to them. */
  earnedCents: number;
  /** True when they gave labour, which cannot be receipted however generous. */
  gaveLabour: boolean;
  /** True when something they gave has no value against it. */
  unvalued: boolean;
}

export function totalsFor(sponsor: Sponsor): SponsorTotals {
  let cash = 0;
  let goods = 0;
  let earned = 0;
  let labour = false;
  let unvalued = false;

  for (const gift of sponsor.gifts) {
    if (gift.kind === 'services') {
      labour = true;
      // Donated time genuinely has a value; it just is not a receiptable one.
      if (gift.valueCents === null) unvalued = true;
      continue;
    }
    if (gift.valueCents === null) unvalued = true;
    if (gift.kind === 'cash') cash += gift.valueCents ?? 0;
    else goods += gift.valueCents ?? 0;
    earned += gift.earnedCents ?? 0;
  }

  return {
    cashCents: cash,
    goodsValueCents: goods,
    earnedCents: earned,
    gaveLabour: labour,
    unvalued,
  };
}

export type SponsorTaskKind =
  | 'pamphlet_due'
  | 'pamphlet_overdue'
  | 'no_pamphlet_name'
  | 'not_thanked'
  | 'no_contact';

export interface SponsorTask {
  sponsorId: string;
  sponsorName: string;
  kind: SponsorTaskKind;
  message: string;
  /** Days past the print deadline; negative means it has not arrived. */
  daysLate: number | null;
}

const DAY_MS = 86_400_000;

/**
 * Everything still owed to a sponsor, worst first.
 *
 * The pamphlet outranks the thank-you, and not by a little. A missing
 * thank-you is a letter sent late; a missing pamphlet entry is a promise
 * broken in print, in front of everybody, permanently — and unlike almost
 * everything else in this system it cannot be fixed on the day.
 */
export function sponsorTasks(
  sponsors: readonly Sponsor[],
  pamphletDeadline: Date | null,
  today: Date,
  weekendOver: boolean,
): SponsorTask[] {
  const tasks: SponsorTask[] = [];

  for (const sponsor of sponsors) {
    if (!sponsor.pamphletConfirmedAt) {
      const daysLate = pamphletDeadline
        ? Math.floor((today.getTime() - pamphletDeadline.getTime()) / DAY_MS)
        : null;

      if (!sponsor.pamphletName) {
        tasks.push({
          sponsorId: sponsor.id,
          sponsorName: sponsor.name,
          kind: 'no_pamphlet_name',
          message: 'No printed name recorded. Nobody can set their entry without it.',
          daysLate,
        });
      } else {
        tasks.push({
          sponsorId: sponsor.id,
          sponsorName: sponsor.name,
          kind: daysLate !== null && daysLate > 0 ? 'pamphlet_overdue' : 'pamphlet_due',
          message:
            daysLate !== null && daysLate > 0
              ? `The pamphlet deadline passed ${daysLate} day${daysLate === 1 ? '' : 's'} ago and this entry has not gone in.`
              : 'Not yet sent to whoever makes the pamphlet.',
          daysLate,
        });
      }
    }

    // Only worth raising once there is something to thank them for having
    // done. Chasing a thank-you in March is noise.
    if (weekendOver && !sponsor.thankedAt) {
      tasks.push({
        sponsorId: sponsor.id,
        sponsorName: sponsor.name,
        kind: 'not_thanked',
        message: sponsor.contactEmail
          ? 'Not thanked yet.'
          : 'Not thanked yet, and no email address to do it with.',
        daysLate: null,
      });
    }

    if (!sponsor.contactEmail && !sponsor.thankedAt) {
      tasks.push({
        sponsorId: sponsor.id,
        sponsorName: sponsor.name,
        kind: 'no_contact',
        message: 'No email address. Whoever knows them has it in their phone.',
        daysLate: null,
      });
    }
  }

  const RANK: Record<SponsorTaskKind, number> = {
    pamphlet_overdue: 0,
    no_pamphlet_name: 1,
    pamphlet_due: 2,
    not_thanked: 3,
    no_contact: 4,
  };
  return tasks.sort((a, b) => RANK[a.kind] - RANK[b.kind]);
}

/**
 * The sentence a thank-you letter should lead with.
 *
 * Built here rather than in a template so the two facts that make it worth
 * reading — what they gave, and what it earned — cannot drift apart from the
 * data they came from.
 */
export function thankYouLine(sponsor: Sponsor): string {
  const totals = totalsFor(sponsor);
  const parts: string[] = [];

  if (totals.cashCents > 0) parts.push(`$${(totals.cashCents / 100).toFixed(2)}`);
  const goods = sponsor.gifts.filter((gift) => gift.kind === 'goods');
  if (goods.length > 0) parts.push(goods.map((gift) => gift.what).join(', '));
  const services = sponsor.gifts.filter((gift) => gift.kind === 'services');
  if (services.length > 0) parts.push(services.map((gift) => gift.what).join(', '));

  if (parts.length === 0) return `${sponsor.name} — nothing recorded against them yet.`;

  const gave = `${sponsor.name} gave ${parts.join(', and ')}`;
  return totals.earnedCents > 0
    ? `${gave}, which raised $${(totals.earnedCents / 100).toFixed(2)} for CHEO Cardiology.`
    : `${gave}.`;
}
