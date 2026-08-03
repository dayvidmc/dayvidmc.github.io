import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DryRunProvider, StripeProvider } from './provider';

/**
 * These are the tests that matter most in the repository.
 *
 * Everything else here can be wrong and somebody notices. If this is wrong,
 * anybody who can reach the webhook URL can mark any team as having paid, and
 * the first sign of it is a division full of teams that never sent money.
 */

const SECRET = 'whsec_test_secret';

function sign(body: string, secret = SECRET, timestamp = Math.floor(Date.now() / 1000)): string {
  const mac = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${mac}`;
}

const completed = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: 'evt_1',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_1',
        payment_intent: 'pi_1',
        payment_status: 'paid',
        amount_total: 20000,
        metadata: { entry_id: 'entry-1', kind: 'deposit', reference: 'TK-ABCD-EFGH' },
        ...overrides,
      },
    },
  });

describe('the Stripe provider refuses to run without what it needs', () => {
  it('will not start without a secret key', () => {
    expect(new StripeProvider('', SECRET).readiness()).toMatch(/STRIPE_SECRET_KEY/);
  });

  it('will not start without a webhook secret, because nothing could be trusted', () => {
    expect(new StripeProvider('sk_test_x', '').readiness()).toMatch(/STRIPE_WEBHOOK_SECRET/);
  });

  it('is ready with both', () => {
    expect(new StripeProvider('sk_test_x', SECRET).readiness()).toBeNull();
  });
});

describe('webhook verification', () => {
  const provider = new StripeProvider('sk_test_x', SECRET);

  it('accepts a correctly signed event and pulls the entry out of it', () => {
    const body = completed();
    const result = provider.verifyWebhook(body, sign(body));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event).toEqual({
      eventId: 'evt_1',
      eventType: 'checkout.session.completed',
      entryId: 'entry-1',
      kind: 'deposit',
      amountCents: 20000,
      externalRef: 'pi_1',
      succeeded: true,
    });
  });

  it('rejects a request with no signature at all', () => {
    const body = completed();
    expect(provider.verifyWebhook(body, null)).toEqual({ ok: false, error: 'No signature header.' });
  });

  it('rejects a signature made with a different secret', () => {
    const body = completed();
    const result = provider.verifyWebhook(body, sign(body, 'whsec_someone_elses'));
    expect(result.ok).toBe(false);
  });

  it('rejects a body that was changed after it was signed', () => {
    // The exact attack: take a real webhook, raise the amount, keep the signature.
    const body = completed();
    const signature = sign(body);
    const tampered = body.replace('"amount_total":20000', '"amount_total":1');
    expect(provider.verifyWebhook(tampered, signature).ok).toBe(false);
  });

  it('rejects a replayed request from five minutes ago', () => {
    const body = completed();
    const old = Math.floor(Date.now() / 1000) - 600;
    expect(provider.verifyWebhook(body, sign(body, SECRET, old)).ok).toBe(false);
  });

  it('rejects a malformed signature header rather than reading past it', () => {
    const body = completed();
    for (const header of ['', 'garbage', 't=123', 'v1=abc', 't=,v1=']) {
      expect(provider.verifyWebhook(body, header).ok).toBe(false);
    }
  });

  it('accepts a valid signature during a secret rotation', () => {
    // Stripe sends every active secret's signature in the same header.
    const body = completed();
    const timestamp = Math.floor(Date.now() / 1000);
    const mine = createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex');
    const header = `t=${timestamp},v1=deadbeef,v1=${mine}`;
    expect(provider.verifyWebhook(body, header).ok).toBe(true);
  });

  it('ignores event types it does not act on instead of guessing', () => {
    const body = JSON.stringify({ id: 'evt_2', type: 'charge.updated', data: { object: {} } });
    const result = provider.verifyWebhook(body, sign(body));
    expect(result).toEqual({ ok: true, event: null });
  });

  it('refuses an event with no entry on it', () => {
    const body = completed({ metadata: {} });
    expect(provider.verifyWebhook(body, sign(body)).ok).toBe(false);
  });

  it('refuses an event whose kind is not one of ours', () => {
    const body = completed({ metadata: { entry_id: 'entry-1', kind: 'merchandise' } });
    expect(provider.verifyWebhook(body, sign(body)).ok).toBe(false);
  });

  it('accepts a donation, which carries no entry of its own', () => {
    const body = completed({ metadata: { entry_id: 'donation', kind: 'donation' } });
    const result = provider.verifyWebhook(body, sign(body));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.event?.kind).toBe('donation');
  });

  it('reports an unpaid session as not succeeded rather than dropping it', () => {
    // A session can complete without being paid. It must be recorded as seen
    // so the webhook is not retried forever, and must not create a payment.
    const body = completed({ payment_status: 'unpaid' });
    const result = provider.verifyWebhook(body, sign(body));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.event?.succeeded).toBe(false);
  });

  it('rejects a body that is not JSON', () => {
    expect(provider.verifyWebhook('not json', sign('not json')).ok).toBe(false);
  });
});

describe('the dry run', () => {
  const provider = new DryRunProvider();

  it('is not live, so nothing can mistake it for taking money', () => {
    expect(provider.live).toBe(false);
  });

  it('accepts no webhook at all', () => {
    expect(provider.verifyWebhook().ok).toBe(false);
  });

  it('sends the coach to the demo-only route, carrying no amount', async () => {
    const result = await provider.startCheckout({
      amountCents: 20000,
      currency: 'cad',
      description: 'Deposit',
      reference: 'TK-ABCD-EFGH',
      kind: 'deposit',
      entryId: 'entry-1',
      successUrl: 'https://example.com/enter/TK-ABCD-EFGH',
      cancelUrl: 'https://example.com/enter/TK-ABCD-EFGH',
    });
    expect(result.ok).toBe(true);
    expect(result.url).toContain('/api/payments/dry-run');
    expect(result.url).toContain('reference=TK-ABCD-EFGH');
    // The amount is recomputed at the other end. A URL that carried one would
    // teach the rehearsal a lesson the real flow must never learn.
    expect(result.url).not.toContain('amount=');
  });
});
