import { NextResponse } from 'next/server';
import { currentProvider } from '@/server/payments/provider';
import { applyPaymentEvent } from '@/server/registration';
import { entryByReference } from '@/server/registration';
import { donationById } from '@/server/donations';
import { amountDue, normaliseReference } from '@/domain/registration';

/**
 * The rehearsal card payment.
 *
 * A committee deciding whether to open a merchant account needs to see the
 * whole thing work first: a coach entering, paying, being accepted, and the
 * money appearing on the money screen. Without this the card leg is the one
 * part of the flow nobody can look at until real money is already involved.
 *
 * So it exists, and it is fenced twice. It refuses unless `DEMO_MODE` is on
 * **and** no live provider is configured — the moment a real provider is set
 * up, this route stops working rather than sitting there as a way to mark any
 * entry paid. Both conditions, not either.
 */

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Where to send them back to.
 *
 * The forwarded host rather than `request.url`, for the same reason the rest of
 * the payment flow uses it: behind a proxy the URL this process sees is the
 * internal one, and a redirect to it lands the coach on a host their browser
 * cannot reach. That is a blank page at the end of paying.
 */
function origin(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  if (!forwarded) return new URL(request.url).origin;
  const proto = request.headers.get('x-forwarded-proto') ?? new URL(request.url).protocol.replace(':', '');
  return `${proto}://${forwarded}`;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const raw = url.searchParams.get('reference') ?? '';
  const kind = url.searchParams.get('kind');
  const back = origin(request);

  if (process.env.DEMO_MODE !== 'true') {
    return new NextResponse('not available', { status: 404 });
  }
  const provider = currentProvider();
  if (provider.live) {
    // A real provider is configured. This must not be a way around it.
    return new NextResponse('not available', { status: 404 });
  }

  // A donation carries its own id rather than an entry reference, because there
  // is no entry behind it. Handled before the reference is normalised — a uuid
  // put through the entry-reference tidier comes out as something else.
  if (kind === 'donation') {
    if (!UUID.test(raw)) return new NextResponse('bad request', { status: 400 });

    const gift = await donationById(raw);
    if (!gift) return new NextResponse('not found', { status: 404 });

    if (gift.confirmedAt === null) {
      await applyPaymentEvent(
        'dry-run',
        {
          eventId: `dryrun_donation_${gift.id}`,
          eventType: 'checkout.session.completed',
          entryId: gift.id,
          kind: 'donation',
          // Recomputed from the row rather than read off the URL, exactly as it
          // is for a real payment.
          amountCents: gift.amountCents,
          externalRef: `dryrun_donation_${gift.id}`,
          succeeded: true,
        },
        { rehearsal: true, donation: gift.id },
      );
    }

    return NextResponse.redirect(new URL(`/donate?thanks=${gift.id}`, back), 303);
  }

  const reference = normaliseReference(raw);
  if (!reference || (kind !== 'deposit' && kind !== 'balance')) {
    return new NextResponse('bad request', { status: 400 });
  }

  const entry = await entryByReference(reference);
  if (!entry) return new NextResponse('not found', { status: 404 });

  // The amount is recomputed here rather than read from the URL, exactly as it
  // is for a real payment. The rehearsal must not teach the wrong lesson.
  const amountCents = amountDue(
    { entryFeeCents: entry.entryFeeCents, depositCents: entry.depositCents },
    entry.payments,
    kind,
  );

  if (amountCents > 0) {
    await applyPaymentEvent(
      'dry-run',
      {
        eventId: `dryrun_${entry.id}_${kind}_${amountCents}`,
        eventType: 'checkout.session.completed',
        entryId: entry.id,
        kind,
        amountCents,
        externalRef: `dryrun_${entry.id}_${kind}_${amountCents}`,
        succeeded: true,
      },
      { rehearsal: true, reference: entry.reference },
    );
  }

  return NextResponse.redirect(new URL(`/enter/${entry.reference}?paid=1`, back), 303);
}
