import { redirect } from 'next/navigation';
import { canAccessHq, currentStaff } from '@/server/auth';
import { currentTournament } from '@/server/repo';
import { cashMovements, cashNow } from '@/server/fundraising';
import { formatDateFriendly, formatTimeFriendly, toWallClock } from '@/domain/time';
import { recordCashAction } from '../actions';

export const dynamic = 'force-dynamic';

const money = (cents: number) =>
  `$${(cents / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const KIND_LABEL: Record<string, string> = {
  float_out: 'Float out',
  takings_in: 'Takings in',
  bank_deposit: 'To the bank',
  overnight_out: 'Home overnight',
  overnight_back: 'Brought back',
};

/**
 * Where the cash physically is.
 *
 * The canteen tills already record a float and a count at close. Nothing
 * covered the auction table, the raffle sellers, or the bank run — and money is
 * moving at all of them, in a park, in cash, on behalf of a children's
 * hospital.
 *
 * The second name on a count is the point of this screen. It is not
 * bureaucracy: a volunteer alone at 10pm with four thousand dollars is in a
 * position nobody should be put in, and this record is what protects them if
 * the number is ever questioned. It is never *required*, because at 10pm there
 * may genuinely be nobody else — but a count with one name on it is listed as
 * such rather than passing quietly.
 */
export default async function CashPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');

  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const params = await searchParams;
  const [position, movements] = await Promise.all([
    cashNow(tournament.id),
    cashMovements(tournament.id),
  ]);

  return (
    <>
      <h1>Cash</h1>
      <p className="sub">Float out, counted back, and banked — everywhere money is taken.</p>

      <div className="subnav">
        <a className="btn back" href="/hq/money">← Money</a>
        <a className="btn" href="/hq/concessions">Canteens</a>
      </div>

      {params.error === 'bad_amount' && (
        <div className="notice error">That needed a place and an amount above zero.</div>
      )}

      <div className="card">
        <strong style={{ fontSize: 28, display: 'block' }}>{money(position.onHandCents)}</strong>
        <div className="meta">counted in and not yet banked</div>
        <div className="meta" style={{ marginTop: 6 }}>
          {money(position.takingsInCents)} counted · {money(position.bankedCents)} banked ·{' '}
          {money(position.floatOutCents)} float issued
        </div>
      </div>

      {position.openSources.length > 0 && (
        <div className="notice warn">
          <strong>Not counted back yet:</strong> {position.openSources.join(', ')}.{' '}
          {money(position.outstandingFloatCents)} of float is still out there.
        </div>
      )}

      {position.overnightHolders.length > 0 && (
        <div className="notice warn">
          <strong>{money(position.overnightHeldCents)} is not at the field.</strong>{' '}
          {position.overnightHolders.length === 1
            ? `${position.overnightHolders[0]!.who} has had it since ` +
              `${formatDateFriendly(toWallClock(position.overnightHolders[0]!.since))}.`
            : `${position.overnightHolders
                .map(
                  (held) =>
                    `${held.who} ${money(held.amountCents)} since ` +
                    `${formatDateFriendly(toWallClock(held.since))}`,
                )
                .join(' · ')}.`}{' '}
          Record it coming back on Sunday morning, or going to the bank.
        </div>
      )}

      {position.unwitnessed.length > 0 && (
        <div className="notice warn">
          {position.unwitnessed.length} count
          {position.unwitnessed.length === 1 ? ' has' : 's have'} only one name on{' '}
          {position.unwitnessed.length === 1 ? 'it' : 'them'}:{' '}
          {[...new Set(position.unwitnessed.map((m) => m.source))].join(', ')}. Worth a second
          signature before the money moves again.
        </div>
      )}

      <h2>Record a movement</h2>
      <form action={recordCashAction} className="card">
        <label htmlFor="kind">What happened</label>
        <select id="kind" name="kind" defaultValue="takings_in">
          <option value="float_out">Float handed out</option>
          <option value="takings_in">Takings counted in</option>
          <option value="bank_deposit">Taken to the bank</option>
          <option value="overnight_out">Gone home with somebody overnight</option>
          <option value="overnight_back">Brought back in</option>
        </select>
        <p className="hint">
          Cash going home on the Saturday night is normal — the banks are shut and the field is not
          a safe. What is not normal is nobody having written down who has it. For those two, put
          the <strong>person&rsquo;s name</strong> in the box below rather than a place.
        </p>

        <label htmlFor="source">Where from or to</label>
        <input
          id="source" name="source" type="text" required
          placeholder="Silent auction table"
          list="cash-sources"
        />
        <datalist id="cash-sources">
          {[...new Set(movements.map((m) => m.source))].map((source) => (
            <option key={source} value={source} />
          ))}
          <option value="Silent auction table" />
          <option value="Raffle sellers" />
          <option value="Bank" />
        </datalist>

        <label htmlFor="amount">How much</label>
        <input id="amount" name="amount" type="text" inputMode="decimal" placeholder="1250.00" required />

        <div className="row">
          <div>
            <label htmlFor="countedBy">Counted by</label>
            <input id="countedBy" name="countedBy" type="text" defaultValue={staff!.name} required />
          </div>
          <div>
            <label htmlFor="witnessedBy">Witnessed by</label>
            <input id="witnessedBy" name="witnessedBy" type="text" placeholder="second name" />
          </div>
        </div>
        <p className="hint">
          Two names on a count protects whoever did the counting. Leave the second blank if there
          genuinely was nobody — it will be listed as needing one rather than refused.
        </p>

        <label htmlFor="notes">Notes</label>
        <input id="notes" name="notes" type="text" placeholder="optional" />

        <button type="submit" className="primary wide" style={{ marginTop: 12 }}>
          Record it
        </button>
      </form>

      <h2>Today</h2>
      {movements.length === 0 ? (
        <div className="empty">
          Nothing recorded here yet. Canteen tills record their own float and count on{' '}
          <a href="/hq/concessions">the concessions screen</a> and are counted in the totals above.
        </div>
      ) : (
        movements.map((movement) => (
          <div key={movement.id} className="card">
            <div className="top">
              <div>
                <div className="teams" style={{ fontSize: 16 }}>{movement.source}</div>
                <div className="meta">
                  {KIND_LABEL[movement.kind]} ·{' '}
                  {formatDateFriendly(toWallClock(movement.occurredAt))}{' '}
                  {formatTimeFriendly(toWallClock(movement.occurredAt))} · {movement.countedBy}
                  {movement.witnessedBy
                    ? ` with ${movement.witnessedBy}`
                    : movement.kind !== 'float_out'
                      ? ' · no second name'
                      : ''}
                </div>
                {movement.notes && <div className="meta">{movement.notes}</div>}
              </div>
              <strong style={{ fontVariantNumeric: 'tabular-nums' }}>
                {movement.kind === 'float_out' ? '−' : ''}
                {money(movement.amountCents)}
              </strong>
            </div>
          </div>
        ))
      )}
    </>
  );
}
