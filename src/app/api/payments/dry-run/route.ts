import { NextResponse } from 'next/server';
import { currentProvider } from '@/server/payments/provider';
import { applyPaymentEvent } from '@/server/registration';
import { entryByReference } from '@/server/registration';
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

export async function GET(request: Request) {
  const url = new URL(request.url);
  const reference = normaliseReference(url.searchParams.get('reference') ?? '');
  const kind = url.searchParams.get('kind');

  if (process.env.DEMO_MODE !== 'true') {
    return new NextResponse('not available', { status: 404 });
  }
  const provider = currentProvider();
  if (provider.live) {
    // A real provider is configured. This must not be a way around it.
    return new NextResponse('not available', { status: 404 });
  }

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

  return NextResponse.redirect(new URL(`/enter/${entry.reference}?paid=1`, request.url));
}
