import { redirect } from 'next/navigation';
import { canAccessHq, currentStaff, isDirector } from '@/server/auth';
import { currentTournament } from '@/server/repo';
import { giftSummary, gifts } from '@/server/fundraising';
import { addGiftAction, markReceiptAction } from '../actions';

export const dynamic = 'force-dynamic';

const money = (cents: number) =>
  `$${(cents / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * What was given rather than bought.
 *
 * Montana's donate the food and the labour for the BBQ at the main field. Every
 * item on the auction table came from somebody. Two reasons this has to be
 * recorded at the time rather than reconstructed:
 *
 *   1. **The thank-you.** A business that gave $2,000 of food should be told
 *      what it earned. Next year's ask is a different conversation with a
 *      number in it.
 *   2. **Receipting.** Fair market value has to be captured when the thing
 *      arrives. In September nobody can say what forty auction items were
 *      worth, and a receipt without a defensible value is the charity's
 *      problem, not the donor's.
 */
export default async function GiftsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');

  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const params = await searchParams;
  const director = isDirector(staff);
  const [all, summary] = await Promise.all([gifts(tournament.id), giftSummary(tournament.id)]);

  return (
    <>
      <h1>Gifts in kind</h1>
      <p className="sub">
        {summary.donors} donor{summary.donors === 1 ? '' : 's'} ·{' '}
        {money(summary.goodsValueCents + summary.servicesValueCents)} of goods and time
      </p>

      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <a className="btn" href="/hq/money" style={{ flex: 1 }}>← Money</a>
        <a className="btn" href="/hq/money/cash" style={{ flex: 1 }}>Cash</a>
      </div>

      {params.error === 'bad_value' && (
        <div className="notice error">That value did not read as an amount. Leave it blank if unknown.</div>
      )}

      <div className="card" style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <span>
          <strong>{money(summary.goodsValueCents)}</strong> goods
        </span>
        <span>
          <strong>{money(summary.servicesValueCents)}</strong> time
        </span>
        {summary.unvalued > 0 && (
          <span>
            <strong>{summary.unvalued}</strong> unvalued
          </span>
        )}
      </div>

      {summary.serviceReceiptsImpossible.length > 0 && (
        <div className="notice warn">
          <strong>A receipt has been asked for against donated time.</strong> Under CRA rules a gift
          has to be of property, so donated labour cannot be receipted however generous it was —{' '}
          {summary.serviceReceiptsImpossible.map((g) => g.donor).join(', ')}. A business can invoice,
          be paid and donate the money back, which can be receipted, but somebody has to have that
          conversation. Do not simply never send anything.
        </div>
      )}

      {summary.unvalued > 0 && (
        <div className="notice info">
          {summary.unvalued} gift{summary.unvalued === 1 ? '' : 's'} with no value recorded. Worth
          asking now — nobody can work it out after the weekend.
        </div>
      )}

      {summary.receiptsOutstanding > 0 && (
        <div className="notice info">
          {summary.receiptsOutstanding} receipt{summary.receiptsOutstanding === 1 ? '' : 's'} asked
          for and not yet issued.
        </div>
      )}

      <h2>Record a gift</h2>
      <form action={addGiftAction} className="card">
        <label htmlFor="donor">Who gave it</label>
        <input id="donor" name="donor" type="text" required placeholder="Montana's" />

        <label htmlFor="what">What</label>
        <input
          id="what" name="what" type="text" required
          placeholder="Burgers, hot dogs and pulled pork for the main field"
        />

        <label htmlFor="kind">Goods or time</label>
        <select id="kind" name="kind" defaultValue="goods">
          <option value="goods">Goods — food, an auction item, printing</option>
          <option value="services">Time — labour, cooking, a service</option>
        </select>
        <p className="hint">
          Kept apart because only goods can be receipted. Donated time still belongs here — it is
          most of what a sponsor actually gave, and the thank-you should say so.
        </p>

        <label htmlFor="value">What it was worth</label>
        <input id="value" name="value" type="text" inputMode="decimal" placeholder="2000.00" />
        <p className="hint">Leave blank if nobody knows yet — but ask before the weekend ends.</p>

        <label htmlFor="destination">Where it went</label>
        <input id="destination" name="destination" type="text" placeholder="Tokessy BBQ / auction table" />

        <label htmlFor="contact">Contact</label>
        <input id="contact" name="contact" type="text" placeholder="optional — who to thank" />

        <label className="toggle" htmlFor="receiptRequested">
          <input id="receiptRequested" name="receiptRequested" type="checkbox" value="true" />
          <span>They have asked for a receipt</span>
        </label>

        <button type="submit" className="primary wide" style={{ marginTop: 12 }}>
          Record it
        </button>
      </form>

      <h2>Recorded</h2>
      {all.length === 0 ? (
        <div className="empty">Nothing recorded yet.</div>
      ) : (
        all.map((gift) => (
          <div key={gift.id} className="card">
            <div className="top">
              <div>
                <div className="teams" style={{ fontSize: 16 }}>{gift.donor}</div>
                <div className="meta">
                  {gift.what}
                  {gift.destination ? ` · ${gift.destination}` : ''}
                </div>
                <div className="meta">
                  {gift.kind === 'services' ? 'Donated time' : 'Donated goods'}
                  {gift.contact ? ` · ${gift.contact}` : ''}
                  {gift.receiptRequested && (gift.receiptIssued ? ' · receipt issued' : ' · receipt asked for')}
                </div>
              </div>
              <strong style={{ fontVariantNumeric: 'tabular-nums' }}>
                {gift.fairMarketValueCents === null ? '—' : money(gift.fairMarketValueCents)}
              </strong>
            </div>

            {director && gift.receiptRequested && !gift.receiptIssued && gift.kind === 'goods' && (
              <form action={markReceiptAction} style={{ marginTop: 8 }}>
                <input type="hidden" name="id" value={gift.id} />
                <button type="submit" style={{ minHeight: 44, padding: '8px 12px', fontSize: 14 }}>
                  Receipt issued
                </button>
              </form>
            )}
          </div>
        ))
      )}
    </>
  );
}
