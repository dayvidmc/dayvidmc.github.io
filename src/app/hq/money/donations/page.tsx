import { redirect } from 'next/navigation';
import { canAccessHq, currentStaff } from '@/server/auth';
import { currentTournament } from '@/server/repo';
import { donations, receiptsDue } from '@/server/donations';
import { formatMoney } from '@/domain/pos';
import { formatDateFriendly } from '@/domain/time';
import { recordDonationAction, voidDonationAction } from '../actions';

export const dynamic = 'force-dynamic';

const METHOD_LABEL: Record<string, string> = {
  card: 'Card',
  cash: 'Cash',
  cheque: 'Cheque',
  etransfer: 'E-transfer',
  other: 'Other',
};

/**
 * Every donation, including the ones that never completed.
 *
 * The unconfirmed rows are shown rather than hidden. Somebody who opened the
 * payment page and changed their mind leaves one behind, and a treasurer
 * reconciling a provider statement needs to be able to see that a row exists
 * and adds nothing — otherwise the first explanation reached for is that the
 * software lost a payment.
 */
export default async function DonationsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');

  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const params = await searchParams;
  const [all, due] = await Promise.all([donations(tournament.id), receiptsDue(tournament.id)]);

  const counted = all.filter((gift) => gift.confirmedAt !== null && gift.voidedAt === null);
  const abandoned = all.filter((gift) => gift.confirmedAt === null && gift.voidedAt === null);
  const voided = all.filter((gift) => gift.voidedAt !== null);
  const total = counted.reduce((sum, gift) => sum + gift.amountCents, 0);

  return (
    <>
      <h1>Donations</h1>
      <p className="sub">
        {counted.length} gift{counted.length === 1 ? '' : 's'} · {formatMoney(total)}
      </p>

      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <a className="btn" href="/hq/money" style={{ flex: 1 }}>← Money</a>
        <a className="btn" href="/donate" style={{ flex: 1 }}>The public page</a>
        <a className="btn" href="/hq/money/donations/receipts" style={{ flex: 1 }}>
          Receipts{due.length > 0 ? ` (${due.length})` : ''}
        </a>
      </div>

      {params.saved && <div className="notice ok">Saved.</div>}
      {due.length > 0 && (
        <div className="notice info">
          {due.length} donor{due.length === 1 ? '' : 's'} asked for a receipt and{' '}
          {due.length === 1 ? 'has' : 'have'} not been passed to CHEO yet.{' '}
          <a href="/hq/money/donations/receipts">Take the list across</a>.
        </div>
      )}
      {params.error && <div className="notice error">That did not work.</div>}

      {!tournament.donations_open && (
        <div className="notice info">
          The public donate page is not open. <a href="/hq/settings">Turn it on in settings</a> when
          the committee has decided to ask. Gifts handed over in person can still be recorded here
          either way.
        </div>
      )}

      {/* --- A gift handed over in person -------------------------------------- */}

      <h2>Record a gift given in person</h2>
      <form action={recordDonationAction} className="card">
        <div className="row">
          <div>
            <label htmlFor="amount">How much</label>
            <input id="amount" name="amount" type="text" inputMode="decimal" placeholder="100.00" required />
          </div>
          <div>
            <label htmlFor="method">How</label>
            <select id="method" name="method" defaultValue="cash">
              <option value="cash">Cash</option>
              <option value="cheque">Cheque</option>
              <option value="etransfer">E-transfer</option>
              <option value="other">Other</option>
            </select>
          </div>
        </div>

        <label htmlFor="donorName">Who from</label>
        <input id="donorName" name="donorName" type="text" maxLength={160} placeholder="blank if they asked to stay anonymous" />

        <label htmlFor="donorEmail">Email, if they want a receipt</label>
        <input id="donorEmail" name="donorEmail" type="email" maxLength={200} placeholder="optional" />

        <label htmlFor="message">A note</label>
        <input id="message" name="message" type="text" maxLength={500} placeholder="optional — e.g. in memory of somebody" />

        <label htmlFor="showPublicly" style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 14 }}>
          <input
            id="showPublicly" name="showPublicly" type="checkbox"
            style={{ width: 24, height: 24, minHeight: 24, flex: '0 0 auto' }}
          />
          <span style={{ fontWeight: 400 }}>
            They said we may thank them by name publicly. Only tick this if they actually said so.
          </span>
        </label>

        <button type="submit" className="primary wide" style={{ minHeight: 48, marginTop: 12 }}>
          Record it
        </button>
      </form>

      {/* --- What has come in --------------------------------------------------- */}

      <h2>Received</h2>
      {counted.length === 0 ? (
        <div className="empty">Nothing yet.</div>
      ) : (
        counted.map((gift) => (
          <div key={gift.id} className="card">
            <div className="top">
              <div>
                <div className="teams" style={{ fontSize: 17 }}>
                  {gift.donorName ?? 'Anonymous'}
                </div>
                <div className="meta">
                  {METHOD_LABEL[gift.method] ?? gift.method} ·{' '}
                  {formatDateFriendly(gift.confirmedAt ?? gift.receivedAt)}
                  {gift.showPublicly ? ' · named publicly' : ' · not named publicly'}
                </div>
                {gift.message && <div className="meta">&ldquo;{gift.message}&rdquo;</div>}
                {gift.donorEmail && <div className="meta">{gift.donorEmail}</div>}
              </div>
              <strong style={{ fontVariantNumeric: 'tabular-nums' }}>
                {formatMoney(gift.amountCents)}
              </strong>
            </div>
            <form action={voidDonationAction} style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <input type="hidden" name="id" value={gift.id} />
              <label htmlFor={`why-${gift.id}`} className="sr-only">
                Why this gift is coming off
              </label>
              <input
                id={`why-${gift.id}`} name="reason" type="text" maxLength={300}
                placeholder="refunded, charged back…"
                style={{ flex: 1, minHeight: 44, fontSize: 14 }}
              />
              <button type="submit" style={{ minHeight: 44, padding: '8px 12px', fontSize: 14 }}>
                Take it off
              </button>
            </form>
          </div>
        ))
      )}

      {abandoned.length > 0 && (
        <>
          <h2>Started and not finished</h2>
          <p className="sub">
            Somebody opened the payment page and did not complete. These count for nothing and need
            no action — they are here so that a row on a provider statement can be matched to one.
          </p>
          <div className="card">
            {abandoned.map((gift) => (
              <div key={gift.id} className="row-item">
                <div>
                  <div style={{ fontWeight: 600 }}>{gift.donorName ?? 'Anonymous'}</div>
                  <div className="meta">{formatDateFriendly(gift.receivedAt)}</div>
                </div>
                <span className="meta">{formatMoney(gift.amountCents)}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {voided.length > 0 && (
        <>
          <h2>Taken off</h2>
          <div className="card">
            {voided.map((gift) => (
              <div key={gift.id} className="row-item">
                <div>
                  <div style={{ fontWeight: 600, textDecoration: 'line-through' }}>
                    {gift.donorName ?? 'Anonymous'}
                  </div>
                  <div className="meta">{gift.voidedReason}</div>
                </div>
                <span className="meta">{formatMoney(gift.amountCents)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
