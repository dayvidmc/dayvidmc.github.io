import { looksLikeEmail } from './contact';

/**
 * What the tournament sends by email, and what it refuses to.
 *
 * Pure, like everything else in this directory: a template takes facts and
 * returns a subject and a body. No database, no clock, no sending. That is
 * what makes it possible to assert on the exact words a coach will read,
 * which matters more here than in most places — these are messages from a
 * volunteer-run charity to people who are about to send it money.
 *
 * **Plain text, deliberately.** No HTML body, no tracking pixel, no images. A
 * tournament that has never sent email before will land in spam folders on its
 * first send no matter what it does; a plain-text message from a real address
 * with no images and no links to anywhere but its own site is the version most
 * likely to arrive. It is also the version that reads correctly on a phone in
 * a car park, which is where these get opened.
 *
 * **Every message says how to stop.** Not because a footer is a legal
 * incantation, but because CASL requires an unsubscribe on commercial
 * electronic messages and the honest reading is that an entry confirmation
 * from a tournament somebody applied to is at best arguable. The cost of
 * including it is one line.
 */

export interface Email {
  subject: string;
  body: string;
}

/**
 * Whether this address is worth queueing at all.
 *
 * Stricter than `looksLikeEmail` in one specific way: a bare local part with
 * no dot in the domain gets through that check in forms where a human is
 * looking at what they typed, and does not deserve to consume five delivery
 * attempts here.
 */
export function sendableAddress(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  if (trimmed === '') return null;
  if (trimmed.length > 254) return null;
  if (!looksLikeEmail(trimmed)) return null;
  // A header injection dressed as an address. Nothing legitimate contains one.
  if (/[\r\n,;<>]/.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

/**
 * A subject line that survives a phone's inbox.
 *
 * Roughly forty characters are visible on an iPhone list. Anything past that
 * is for the person who already opened it, so the useful half goes first and
 * the whole thing is capped well before the point where a client truncates it
 * in the middle of a word.
 */
export function subjectLine(parts: readonly string[]): string {
  const joined = parts.filter((part) => part.trim() !== '').join(' · ');
  return joined.length <= 78 ? joined : `${joined.slice(0, 77).trimEnd()}…`;
}

interface Signature {
  tournamentName: string;
  /** Where a reply should go. Empty is allowed; the line is dropped. */
  contactEmail?: string;
  siteUrl?: string;
}

/**
 * The bottom of every message.
 *
 * One paragraph, three facts: who this is, how to reach a human, and how to
 * stop. A reply address that reaches a volunteer beats any support portal.
 */
function signOff(signature: Signature): string {
  const lines = [
    '—',
    signature.tournamentName,
    'Run entirely by volunteers. 100% of proceeds go to CHEO Cardiology.',
  ];
  if (signature.contactEmail) {
    lines.push(`Reply to this message, or write to ${signature.contactEmail}.`);
  }
  if (signature.siteUrl) lines.push(signature.siteUrl);
  lines.push(
    'To stop receiving email from the tournament, reply with the word STOP and somebody will take you off.',
  );
  return lines.join('\n');
}

/** Assemble a body from paragraphs, dropping the empty ones. */
function compose(paragraphs: readonly (string | null | false)[], signature: Signature): string {
  const kept = paragraphs.filter((p): p is string => typeof p === 'string' && p.trim() !== '');
  return `${kept.join('\n\n')}\n\n${signOff(signature)}\n`;
}

// --- Entries ----------------------------------------------------------------

export interface EntryReceivedFacts extends Signature {
  contactName: string;
  teamName: string;
  divisionName: string;
  reference: string;
  statusUrl: string;
  /** Null when no deposit is being asked for. */
  depositDue?: string | null;
  payBy?: string | null;
}

/**
 * "We have your application."
 *
 * The single most valuable email here, because of what it carries: the
 * reference. Today that number appears on a web page after submitting the
 * form, and a coach who closes the tab has lost the thing their e-transfer has
 * to quote. This is the copy of it that lives in their inbox.
 */
export function entryReceived(facts: EntryReceivedFacts): Email {
  return {
    subject: subjectLine([`Entry received — ${facts.teamName}`, facts.reference]),
    body: compose(
      [
        `${facts.contactName ? `${facts.contactName},` : 'Hello,'}`,
        `Your entry for ${facts.teamName} in ${facts.divisionName} has reached us. Nothing else is needed from you yet — a person reads every application and you will hear back once yours has been looked at.`,
        `Your reference is ${facts.reference}. Keep this message: that reference is what identifies your team, and any payment you send should quote it.`,
        facts.depositDue
          ? `A deposit of ${facts.depositDue} holds the place${facts.payBy ? `, and we need it by ${facts.payBy}` : ''}. Nothing is confirmed until it arrives.`
          : null,
        `You can check where your entry stands at any time: ${facts.statusUrl}`,
        'A place is not held by applying. Places go in the order the money arrives, and the divisions do fill.',
      ],
      facts,
    ),
  };
}

export type EntryOutcome = 'accepted' | 'waitlisted' | 'declined';

export interface EntryDecidedFacts extends Signature {
  contactName: string;
  teamName: string;
  divisionName: string;
  reference: string;
  outcome: EntryOutcome;
  statusUrl: string;
  balanceDue?: string | null;
  payBy?: string | null;
  /** Free text from HQ, e.g. why a division could not take them. */
  note?: string | null;
}

/**
 * Accepted, waitlisted or declined.
 *
 * Three genuinely different messages rather than one with the word swapped,
 * because a coach who has been declined should not have to read a paragraph
 * about paying a balance to work out that they are not in. The waitlist
 * version says the one thing a waitlisted coach actually wants to know: that
 * teams do drop out.
 */
export function entryDecided(facts: EntryDecidedFacts): Email {
  const opening = facts.contactName ? `${facts.contactName},` : 'Hello,';
  const headline: Record<EntryOutcome, string> = {
    accepted: `${facts.teamName} is in`,
    waitlisted: `${facts.teamName} is on the waiting list`,
    declined: `${facts.teamName} — ${facts.divisionName} is full`,
  };

  const middle: Record<EntryOutcome, (string | null)[]> = {
    accepted: [
      `${facts.teamName} has a place in ${facts.divisionName}. We are glad to have you.`,
      facts.balanceDue
        ? `The balance is ${facts.balanceDue}${facts.payBy ? `, due by ${facts.payBy}` : ''}. Quote ${facts.reference} when you send it.`
        : 'Nothing further is owed.',
      'The schedule goes out closer to the weekend, and your team gets its own page with its games, times and diamonds on it — one link you can forward to your parents once.',
    ],
    waitlisted: [
      `${facts.divisionName} is full, so ${facts.teamName} is on the waiting list. Nothing has been charged.`,
      'This is worth more than it sounds. Teams drop out most years, and the list is worked through in order — you would be told as soon as a place opens.',
      'If your plans change and you would rather come off the list, reply and say so; it costs nothing and it lets us tell somebody else sooner.',
    ],
    declined: [
      `We are sorry — ${facts.divisionName} could not take ${facts.teamName} this year. Nothing has been charged.`,
      'This is not a judgement on the team. The divisions fill in the order entries and deposits arrive, and the diamonds the city gives us decide how many we can take.',
      'We would be glad to see the entry again next year, and the opening date goes on the website well before it happens.',
    ],
  };

  return {
    subject: subjectLine([headline[facts.outcome], facts.reference]),
    body: compose(
      [opening, ...middle[facts.outcome], `Where your entry stands: ${facts.statusUrl}`, facts.note ?? null],
      facts,
    ),
  };
}

export interface BalanceReminderFacts extends Signature {
  contactName: string;
  teamName: string;
  reference: string;
  balanceDue: string;
  payBy?: string | null;
  statusUrl: string;
  howToPay?: string | null;
}

/**
 * The balance chase.
 *
 * Written to be the least awkward version of an awkward message. It states the
 * amount, the reference and the date once, does not imply the coach has done
 * anything wrong, and says what happens if it is genuinely a problem — because
 * for a family-run team in a charity tournament, sometimes it is, and the
 * committee would rather hear that than lose the team.
 */
export function balanceReminder(facts: BalanceReminderFacts): Email {
  return {
    subject: subjectLine([`Balance outstanding — ${facts.teamName}`, facts.balanceDue]),
    body: compose(
      [
        facts.contactName ? `${facts.contactName},` : 'Hello,',
        `A friendly note that ${facts.balanceDue} is still outstanding for ${facts.teamName}${facts.payBy ? `, due by ${facts.payBy}` : ''}.`,
        `Quote ${facts.reference} when you send it, which is what lets the treasurer match it to your team.`,
        facts.howToPay ?? null,
        `Where your entry stands: ${facts.statusUrl}`,
        'If it has already gone, thank you and please ignore this — it can take a couple of days to reach us. If paying by the date is a difficulty, reply and say so. This is a charity tournament run by volunteers and we would far rather hear from you than chase you.',
      ],
      facts,
    ),
  };
}

// --- Donations --------------------------------------------------------------

export interface ReceiptAddressFacts extends Signature {
  donorName: string;
  amount: string;
}

/**
 * "You asked for a receipt and we have nowhere to post it."
 *
 * This is the message the receipts screen has been asking for and could not
 * send. CHEO issues the receipt, so the tournament's whole job is to hand over
 * a name, an address and an amount — and a donor who ticked the box on a phone
 * at the gate and left the address blank breaks that at the last step.
 *
 * It thanks them first. Somebody who has just given money and is being asked
 * for one more thing should be thanked before they are asked.
 */
export function receiptAddress(facts: ReceiptAddressFacts): Email {
  return {
    subject: subjectLine(['Your donation receipt — we need a posting address']),
    body: compose(
      [
        facts.donorName ? `${facts.donorName},` : 'Hello,',
        `Thank you for your donation of ${facts.amount}. Every dollar of it goes to CHEO Cardiology.`,
        'You asked for a receipt. The CHEO Foundation issues those rather than the tournament, and they post them — so they need a mailing address, and we do not have one for you.',
        'If you reply to this message with your address, town and postal code, it goes across with the next batch. If you would rather not, that is completely fine and nothing more will be sent about it; the donation is unaffected either way.',
      ],
      facts,
    ),
  };
}
