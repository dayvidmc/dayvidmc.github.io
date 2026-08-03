/**
 * Taking a card payment without ever touching a card.
 *
 * The rule this file exists to enforce: **a card number must never reach this
 * server**. Not in a form post, not in a log, not in a variable. The provider
 * hosts the page that takes the card; we hand it an amount and a reference and
 * get told afterwards what happened. That keeps the tournament in the cheapest
 * PCI bracket (SAQ-A), which is the only one a volunteer committee should ever
 * be asked to attest to.
 *
 * So the interface is two calls. Start a checkout, which returns a URL to send
 * the coach to. Verify a webhook, which turns a signed request body into a
 * payment we believe. There is no "charge this card" method, and there must
 * never be one.
 *
 * Like the SMS provider, the dry-run implementation is not a stub — it is the
 * correct configuration until somebody has deliberately decided to take real
 * money, and it is what the demo and every rehearsal run against.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface CheckoutRequest {
  /** In cents. Always computed on this server from our own fees. */
  amountCents: number;
  currency: 'cad';
  /** What the coach sees on the checkout page and on their statement. */
  description: string;
  /** Ours, not the provider's: the entry reference and which leg is being paid. */
  reference: string;
  kind: 'deposit' | 'balance';
  entryId: string;
  email?: string;
  successUrl: string;
  cancelUrl: string;
}

export interface CheckoutResult {
  ok: boolean;
  /** Where to send the coach. */
  url?: string;
  /** The provider's id for this checkout, for reconciling a statement later. */
  sessionId?: string;
  error?: string;
}

/** A payment we believe happened, extracted from a verified webhook. */
export interface PaymentEvent {
  eventId: string;
  eventType: string;
  entryId: string;
  kind: 'deposit' | 'balance';
  amountCents: number;
  /** The provider's payment id, stored so a refund can be issued against it. */
  externalRef: string;
  /** False for events we recognise but do nothing with. */
  succeeded: boolean;
}

export type WebhookResult =
  | { ok: true; event: PaymentEvent | null }
  | { ok: false; error: string };

export interface PaymentProvider {
  readonly name: string;
  /** True when this provider will actually move money. */
  readonly live: boolean;
  /** Why this provider cannot take a payment, or null if it can. */
  readiness(): string | null;
  startCheckout(request: CheckoutRequest): Promise<CheckoutResult>;
  /**
   * Verify a webhook's signature and pull the payment out of it.
   *
   * Takes the raw body, not a parsed object: a signature covers the bytes that
   * were sent, and re-serialising JSON to check a signature is how signature
   * checks come to pass on tampered payloads.
   */
  verifyWebhook(rawBody: string, signature: string | null): WebhookResult;
}

// --- The dry run -------------------------------------------------------------

/**
 * Moves no money and says so loudly.
 *
 * Its checkout URL points back at our own page, which records the payment as
 * if it had succeeded. That makes the whole flow — form, deposit, acceptance,
 * balance, the money screen — exercisable end to end in a demo without a
 * merchant account, which is exactly what a committee needs to see before it
 * agrees to open one.
 */
export class DryRunProvider implements PaymentProvider {
  readonly name = 'dry-run';
  readonly live = false;

  readiness(): string | null {
    return null;
  }

  async startCheckout(request: CheckoutRequest): Promise<CheckoutResult> {
    // Back to a route that only answers in demo mode, which recomputes the
    // amount for itself rather than trusting this URL.
    const url = new URL('/api/payments/dry-run', request.successUrl);
    url.searchParams.set('reference', request.reference);
    url.searchParams.set('kind', request.kind);
    console.log(
      `[payments:dry-run] would charge ${(request.amountCents / 100).toFixed(2)} CAD ` +
        `for ${request.reference} (${request.kind})`,
    );
    return { ok: true, url: url.toString(), sessionId: `dryrun_${request.entryId}_${request.kind}` };
  }

  verifyWebhook(): WebhookResult {
    // Nothing legitimate can send this provider a webhook, so anything that
    // arrives is either a misconfiguration or somebody trying it on.
    return { ok: false, error: 'No payment provider is configured to receive webhooks.' };
  }
}

// --- Stripe ------------------------------------------------------------------

/**
 * Stripe Checkout, called over its REST API rather than through the SDK.
 *
 * Only the hosted mode: `mode=payment` with a session the coach is redirected
 * to. Stripe's own page renders the card field, so no card data crosses this
 * process, and the amount is one we computed here — never one posted by a
 * browser, which would let anybody enter a $700 team for a dollar.
 */
export class StripeProvider implements PaymentProvider {
  readonly name = 'stripe';
  readonly live = true;

  constructor(
    private readonly secretKey: string,
    private readonly webhookSecret: string,
  ) {}

  readiness(): string | null {
    if (!this.secretKey) return 'STRIPE_SECRET_KEY is not set.';
    if (!this.secretKey.startsWith('sk_')) return 'STRIPE_SECRET_KEY does not look like a secret key.';
    if (!this.webhookSecret) {
      // Without this we cannot tell a real payment from a forged one, and a
      // forged one marks a team as paid. Refusing to run is the right answer.
      return 'STRIPE_WEBHOOK_SECRET is not set, so no payment could be trusted.';
    }
    return null;
  }

  async startCheckout(request: CheckoutRequest): Promise<CheckoutResult> {
    const body = new URLSearchParams({
      mode: 'payment',
      success_url: request.successUrl,
      cancel_url: request.cancelUrl,
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': request.currency,
      'line_items[0][price_data][unit_amount]': String(request.amountCents),
      'line_items[0][price_data][product_data][name]': request.description,
      // Read back off the webhook. This is how a payment finds its entry, so
      // it has to be on the session rather than inferred from an amount.
      'metadata[entry_id]': request.entryId,
      'metadata[kind]': request.kind,
      'metadata[reference]': request.reference,
      'payment_intent_data[metadata][entry_id]': request.entryId,
      'payment_intent_data[metadata][kind]': request.kind,
    });
    if (request.email) body.set('customer_email', request.email);

    try {
      const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          // A coach double-tapping the pay button must not open two checkouts
          // for the same leg of the same entry.
          'Idempotency-Key': `${request.entryId}:${request.kind}:${request.amountCents}`,
        },
        body,
        signal: AbortSignal.timeout(15_000),
      });

      const payload = (await response.json().catch(() => ({}))) as {
        id?: string;
        url?: string;
        error?: { message?: string };
      };

      if (response.ok && payload.url) {
        return { ok: true, url: payload.url, sessionId: payload.id };
      }
      return { ok: false, error: payload.error?.message ?? `checkout failed (${response.status})` };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  verifyWebhook(rawBody: string, signature: string | null): WebhookResult {
    if (!signature) return { ok: false, error: 'No signature header.' };

    // Stripe's header is `t=<unix>,v1=<hmac>,v1=<hmac>` — more than one v1
    // during a secret rotation, and any of them matching is a valid signature.
    const parts = new Map<string, string[]>();
    for (const piece of signature.split(',')) {
      const [key, value] = piece.split('=', 2);
      if (!key || !value) continue;
      parts.set(key, [...(parts.get(key) ?? []), value]);
    }

    const timestamp = parts.get('t')?.[0];
    const signatures = parts.get('v1') ?? [];
    if (!timestamp || signatures.length === 0) return { ok: false, error: 'Malformed signature header.' };

    // A replayed request from an hour ago is not a payment happening now.
    const age = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (!Number.isFinite(age) || age > 300) return { ok: false, error: 'Signature timestamp is too old.' };

    const expected = createHmac('sha256', this.webhookSecret)
      .update(`${timestamp}.${rawBody}`)
      .digest('hex');

    const matches = signatures.some((candidate) => {
      const a = Buffer.from(expected, 'utf8');
      const b = Buffer.from(candidate, 'utf8');
      return a.length === b.length && timingSafeEqual(a, b);
    });
    if (!matches) return { ok: false, error: 'Signature does not match.' };

    let parsed: {
      id?: string;
      type?: string;
      data?: { object?: Record<string, unknown> };
    };
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return { ok: false, error: 'Body is not JSON.' };
    }

    if (!parsed.id || !parsed.type) return { ok: false, error: 'Not an event.' };

    // Only one event type moves money into an entry. Everything else is
    // recorded as seen and ignored, so a webhook configured too broadly does
    // not create phantom payments.
    if (parsed.type !== 'checkout.session.completed') {
      return { ok: true, event: null };
    }

    const session = parsed.data?.object ?? {};
    const metadata = (session.metadata ?? {}) as Record<string, string>;
    const entryId = metadata.entry_id;
    const kind = metadata.kind;
    const amount = Number(session.amount_total);

    if (!entryId || (kind !== 'deposit' && kind !== 'balance') || !Number.isInteger(amount)) {
      return { ok: false, error: 'Event is missing the entry it belongs to.' };
    }

    return {
      ok: true,
      event: {
        eventId: parsed.id,
        eventType: parsed.type,
        entryId,
        kind,
        amountCents: amount,
        externalRef: String(session.payment_intent ?? session.id ?? parsed.id),
        succeeded: session.payment_status === 'paid',
      },
    };
  }
}

/**
 * The provider this deployment is configured for.
 *
 * `PAYMENT_PROVIDER` must say `stripe` explicitly. Keys sitting in the
 * environment are not consent to charge anybody — the same rule as texting,
 * for the same reason: a stray variable copied between environments must not
 * start taking money from coaches during a rehearsal.
 */
export function currentProvider(): PaymentProvider {
  if (process.env.PAYMENT_PROVIDER === 'stripe') {
    return new StripeProvider(
      process.env.STRIPE_SECRET_KEY ?? '',
      process.env.STRIPE_WEBHOOK_SECRET ?? '',
    );
  }
  return new DryRunProvider();
}
