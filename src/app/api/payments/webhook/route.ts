import { NextResponse } from 'next/server';
import { currentProvider } from '@/server/payments/provider';
import { applyPaymentEvent } from '@/server/registration';

/**
 * Where the card provider tells us a coach paid.
 *
 * This endpoint is the only way a payment gets recorded without a person, so
 * it is the only place where getting it wrong means a team is marked paid when
 * no money arrived. Three defences, in this order:
 *
 *   1. **A signature, or nothing.** The body is read as raw bytes and checked
 *      against the shared secret before it is parsed. No secret configured
 *      means every request is refused, including the real ones — an endpoint
 *      that accepts unsigned traffic while somebody sorts the configuration
 *      out is worse than an endpoint that is down.
 *   2. **Exactly once.** The provider's event id is claimed in the same
 *      transaction that writes the payment, so a retry — and they all retry —
 *      finds it taken and does nothing.
 *   3. **Their amount, our entry.** The entry comes from metadata we set when
 *      we created the checkout, never from anything guessable in the request.
 *
 * The response is deliberately 200 for anything we have decided about,
 * including events we ignore. A non-2xx makes the provider retry, and retrying
 * a message we correctly refused just fills their dashboard with red.
 */

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const provider = currentProvider();

  if (!provider.live) {
    // The dry-run provider. Nothing legitimate posts here.
    return new NextResponse('no payment provider configured', { status: 404 });
  }

  const notReady = provider.readiness();
  if (notReady) {
    console.error(`[payments] webhook refused: ${notReady}`);
    return new NextResponse('provider not configured', { status: 503 });
  }

  // Raw text, before any parsing: a signature covers the bytes that were sent.
  const raw = await request.text();
  const signature =
    request.headers.get('stripe-signature') ?? request.headers.get('x-signature') ?? null;

  const verified = provider.verifyWebhook(raw, signature);
  if (!verified.ok) {
    console.error(`[payments] webhook rejected: ${verified.error}`);
    return new NextResponse('invalid signature', { status: 400 });
  }

  if (!verified.event) return NextResponse.json({ ignored: true });

  const result = await applyPaymentEvent(provider.name, verified.event, safeParse(raw));
  return NextResponse.json(result);
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return { unparsed: raw.slice(0, 2000) };
  }
}
