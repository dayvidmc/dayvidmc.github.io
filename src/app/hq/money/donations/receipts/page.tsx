import { redirect } from 'next/navigation';
import { canAccessHq, currentStaff } from '@/server/auth';
import { currentTournament } from '@/server/repo';
import { receiptsDue } from '@/server/donations';
import { formatMoney } from '@/domain/pos';
import { formatDateFriendly } from '@/domain/time';
import { CopyText } from '../../../../_components/CopyText';
import { askForAddressesAction, markReceiptsSentAction } from '../../actions';

export const dynamic = 'force-dynamic';

/**
 * What CHEO needs, and what has already gone.
 *
 * CHEO issues the receipts, not the tournament — so this screen's whole job is
 * to hand over a name, an address and an amount, and then to record that it
 * did. Without the second half somebody receipts the same donor twice, or
 * nobody can say which gifts are still outstanding, and both are worse than the
 * first half being slightly awkward.
 *
 * A donor who did not ask for a receipt is not here. Neither is an anonymous
 * one — there is nobody to receipt.
 */
export default async function ReceiptsScreen({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; asked?: string; noEmail?: string }>;
}) {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');

  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const params = await searchParams;
  const all = await receiptsDue(tournament.id, true);
  const due = all.filter((line) => line.sentAt === null);
  const sent = all.filter((line) => line.sentAt !== null);

  const noAddress = due.filter((line) => !line.addressLine || !line.addressPostal);
  const total = due.reduce((sum, line) => sum + line.amountCents, 0);

  // Tab-separated: the shape that pastes straight into a spreadsheet, which is
  // what a foundation will ask for.
  const table = [
    ['Name', 'Address', 'City', 'Province', 'Postal code', 'Amount', 'Received', 'Method'].join('\t'),
    ...due.map((line) =>
      [
        line.donorName,
        line.addressLine ?? '',
        line.addressCity ?? '',
        line.addressProvince ?? '',
        line.addressPostal ?? '',
        (line.amountCents / 100).toFixed(2),
        line.receivedAt.toISOString().slice(0, 10),
        line.method,
      ].join('\t'),
    ),
  ].join('\n');

  return (
    <>
      <h1>Receipts for CHEO</h1>
      <p className="sub">
        {due.length} waiting · {formatMoney(total)} · {sent.length} already sent
      </p>

      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <a className="btn" href="/hq/money/donations" style={{ flex: 1 }}>← Donations</a>
      </div>

      {params.sent && (
        <div className="notice ok">
          {params.sent} marked as sent. They will not appear in the next batch.
        </div>
      )}

      {params.asked && (
        <div className="notice ok">
          {params.asked === '0'
            ? 'Nobody new to ask — everybody with an email has already been written to.'
            : `${params.asked} donor${params.asked === '1' ? '' : 's'} asked for their address. The message is queued; it goes out with the next send.`}
          {params.noEmail && params.noEmail !== '0'
            ? ` ${params.noEmail} left no email address either, so those can only be chased by hand.`
            : ''}
        </div>
      )}

      <div className="notice info">
        <strong>CHEO issues these, not the tournament.</strong> The job here is to hand over the
        details and record that it was done. Nothing on this screen sends anything by itself.
      </div>

      {noAddress.length > 0 && (
        <div className="notice warn">
          <p>
            {noAddress.length} donor{noAddress.length === 1 ? '' : 's'} asked for a receipt without
            a full address: {noAddress.map((line) => line.donorName).join(', ')}. A foundation
            cannot post to a name alone.
          </p>
          {/* The button this notice asked for and, until email existed, could
              not have. It queues one message each and skips anybody already
              written to. */}
          <form action={askForAddressesAction}>
            {noAddress.map((line) => (
              <input key={line.id} type="hidden" name="id" value={line.id} />
            ))}
            <button type="submit" className="wide" style={{ minHeight: 48, marginTop: 8 }}>
              Email {noAddress.length === 1 ? 'them' : 'them all'} and ask
            </button>
            <p className="hint">
              {noAddress.filter((line) => line.donorEmail).length} of {noAddress.length} left an
              email address. The rest can only be chased by hand — nothing here can reach them.
            </p>
          </form>
        </div>
      )}

      {due.length === 0 ? (
        <div className="empty">
          Nothing waiting. Donors who asked for a receipt appear here once their payment has
          confirmed.
        </div>
      ) : (
        <>
          <h2>Waiting</h2>
          <div className="card">
            {due.map((line) => (
              <div key={line.id} className="row-item" style={{ alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontWeight: 600 }}>{line.donorName}</div>
                  <div className="meta">
                    {[line.addressLine, line.addressCity, line.addressProvince, line.addressPostal]
                      .filter(Boolean)
                      .join(', ') || 'no address given'}
                  </div>
                  <div className="meta">
                    {formatDateFriendly(line.receivedAt)} · {line.method}
                    {line.donorEmail ? ` · ${line.donorEmail}` : ''}
                  </div>
                </div>
                <strong style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {formatMoney(line.amountCents)}
                </strong>
              </div>
            ))}
          </div>

          <h2>Send it</h2>
          <CopyText
            value={table}
            label="Tab-separated — pastes straight into a spreadsheet"
            rows={Math.min(20, due.length + 2)}
          />

          <form action={markReceiptsSentAction} style={{ marginTop: 16 }}>
            {due.map((line) => (
              <input key={line.id} type="hidden" name="id" value={line.id} />
            ))}
            <button type="submit" className="primary wide" style={{ minHeight: 48 }}>
              Mark all {due.length} as sent to CHEO
            </button>
            <p className="hint">
              Press this once the list has actually gone. It only records that it went — nothing is
              sent from here, and a gift marked as sent drops out of the next batch.
            </p>
          </form>
        </>
      )}

      {sent.length > 0 && (
        <>
          <h2>Already sent</h2>
          <div className="card">
            {sent.map((line) => (
              <div key={line.id} className="row-item">
                <div>
                  <div style={{ fontWeight: 600 }}>{line.donorName}</div>
                  <div className="meta">
                    sent {line.sentAt ? formatDateFriendly(line.sentAt) : ''}
                  </div>
                </div>
                <span className="meta">{formatMoney(line.amountCents)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
