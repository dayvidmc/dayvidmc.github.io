import { redirect } from 'next/navigation';
import { canAccessHq, currentStaff, isDirector } from '@/server/auth';
import { currentTournament } from '@/server/repo';
import { board, byAgeGroup, entryDivisions, entrySettings } from '@/server/registration';
import { currentProvider } from '@/server/payments/provider';
import { formatDate, formatTime } from '@/domain/time';
import { saveFeesAction, saveWindowAction } from '../actions';

export const dynamic = 'force-dynamic';

const ERROR: Record<string, string> = {
  director_only: 'Only the director can change fees or the opening time.',
  bad_open: 'That opening date and time did not read.',
  bad_close: 'That closing date and time did not read.',
  backwards: 'Entries cannot close before they open.',
  bad_amount: 'A fee has to be an amount of money.',
  bad_cap: 'A cap has to be a whole number of teams, or blank for no limit.',
  deposit_over_fee: 'A deposit cannot be more than the entry fee itself.',
  bad_due_date: 'That balance due date did not read.',
  bad_refund_date: 'That refund cutoff date did not read.',
};

/**
 * Fees, caps and the opening time.
 *
 * The opening time is the only setting in this repository that is announced to
 * ninety people before it takes effect. Moving it afterwards is not a
 * configuration change, it is a decision about who gets in — so it is the
 * director's, and this screen says what it will do rather than just taking a
 * value.
 */
export default async function EntrySettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');

  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const params = await searchParams;
  const [settings, divisions, { divisions: room }] = await Promise.all([
    entrySettings(tournament.id),
    entryDivisions(tournament.id),
    board(tournament.id),
  ]);

  const director = isDirector(staff);
  const provider = currentProvider();
  const providerReady = provider.readiness();
  const capacityFor = new Map(room.map((d) => [d.divisionId, d]));
  const groups = byAgeGroup(divisions);

  return (
    <>
      <h1>Fees and dates</h1>
      <p className="sub">What it costs to enter, how many can, and when the door opens.</p>

      <div className="subnav">
        <a className="btn back" href="/hq/entries">← Entries</a>
        <a className="btn" href="/enter">The public page</a>
      </div>

      {params.saved && <div className="notice ok">Saved.</div>}
      {params.error && <div className="notice error">{ERROR[params.error] ?? 'That did not work.'}</div>}
      {!director && (
        <div className="notice info">
          You can read this. Changing a fee or the opening time is the director&apos;s.
        </div>
      )}

      {/* --- How money can arrive ---------------------------------------------- */}

      <div className={`notice ${provider.live && !providerReady ? 'ok' : 'info'}`}>
        <strong>Card payments: {provider.live && !providerReady ? 'on' : 'off'}.</strong>{' '}
        {provider.live && !providerReady
          ? 'Coaches can pay by card, and their entry updates by itself.'
          : provider.live
            ? `Configured but not usable — ${providerReady}`
            : 'No card provider is connected, so coaches are not offered a card button. e-Transfer and cheque work without one, cost the tournament nothing, and are what most tournaments use — see docs/DEPLOY.md if the committee decides it wants cards as well.'}
      </div>

      {/* --- The window --------------------------------------------------------- */}

      <h2>When entries open</h2>
      <form action={saveWindowAction} className="card">
        <div className="row">
          <div>
            <label htmlFor="openDate">Opens</label>
            <input
              id="openDate" name="openDate" type="date" disabled={!director}
              defaultValue={settings.entriesOpenAt ? formatDate(settings.entriesOpenAt) : ''}
            />
          </div>
          <div>
            <label htmlFor="openTime">at</label>
            <input
              id="openTime" name="openTime" type="time" disabled={!director}
              defaultValue={settings.entriesOpenAt ? formatTime(settings.entriesOpenAt) : '19:00'}
            />
          </div>
        </div>
        <p className="hint">
          Before this minute the public page has no form on it at all, and the server refuses an
          entry even if somebody builds their own. Leave the date blank to take entries down.
        </p>

        <div className="row">
          <div>
            <label htmlFor="closeDate">Closes</label>
            <input
              id="closeDate" name="closeDate" type="date" disabled={!director}
              defaultValue={settings.entriesCloseAt ? formatDate(settings.entriesCloseAt) : ''}
            />
          </div>
          <div>
            <label htmlFor="closeTime">at</label>
            <input
              id="closeTime" name="closeTime" type="time" disabled={!director}
              defaultValue={settings.entriesCloseAt ? formatTime(settings.entriesCloseAt) : '23:59'}
            />
          </div>
        </div>
        <p className="hint">Blank means entries stay open until you take the opening date away.</p>

        <h3 style={{ marginTop: 18, fontSize: 17 }}>When the balance is due</h3>

        <label htmlFor="balanceDueDate">On this date</label>
        <input
          id="balanceDueDate" name="balanceDueDate" type="date"
          defaultValue={settings.balanceDueDate ?? ''} disabled={!director}
        />
        <p className="hint">
          One deadline for everybody, which is what goes on a poster and what makes chasing simple.
          A team accepted after this date owes the money straight away rather than being given a
          fresh fortnight.
        </p>

        <label htmlFor="balanceDueDays">Or this many days after each team is accepted</label>
        <input
          id="balanceDueDays" name="balanceDueDays" type="number" min={1} max={365}
          defaultValue={settings.balanceDueDays} disabled={!director}
        />
        <p className="hint">
          Used only when no date is set above. Fairer to a team accepted off the waitlist in April.
          Either way it is stamped onto the entry when it is accepted, so changing this later never
          moves a deadline somebody has already been told.
        </p>

        <h3 style={{ marginTop: 18, fontSize: 17 }}>Refunds</h3>

        <label htmlFor="refundCutoffDate">Deposits are refundable up to and including</label>
        <input
          id="refundCutoffDate" name="refundCutoffDate" type="date"
          defaultValue={settings.refundCutoffDate ?? ''} disabled={!director}
        />
        <p className="hint">
          Shown on the coach&apos;s page <strong>before</strong> they pay, not after. Leave it blank
          and the page says nothing about refunds at all, which is the honest thing to do with
          somebody&apos;s money when no policy has been agreed.
        </p>

        <label htmlFor="refundPolicyNote">Anything to add</label>
        <input
          id="refundPolicyNote" name="refundPolicyNote" type="text" maxLength={400}
          defaultValue={settings.refundPolicyNote ?? ''} disabled={!director}
          placeholder="what a late withdrawal means for the balance, who to ring"
        />

        <h3 style={{ marginTop: 18, fontSize: 17 }}>Rosters</h3>

        <label htmlFor="maxRosterSize">Maximum players on a roster</label>
        <input
          id="maxRosterSize" name="maxRosterSize" type="number" min={9} max={40}
          defaultValue={settings.maxRosterSize} disabled={!director}
        />
        <p className="hint">
          A warning on the roster screen, not a hard stop — a roster arriving with fifteen names is
          a conversation with a coach, not a crash. Affiliates called up for the weekend are not
          counted against it.
        </p>

        <h3 style={{ marginTop: 18, fontSize: 17 }}>Age groups</h3>

        <label htmlFor="ageGroups">The age groups this tournament runs</label>
        <input
          id="ageGroups" name="ageGroups" type="text" disabled={!director}
          defaultValue={settings.ageGroups.join(', ')}
          placeholder="Rookie, Mosquito, Peewee, Bantam, Midget"
        />
        <p className="hint">
          Comma separated, in the order they should be offered. This is the list a coach picks
          from, and an entry naming anything else is refused. Leave it blank and the box on the
          entry form becomes free text — which is worse, but better than an empty list stopping
          everybody entering.
        </p>

        <h3 style={{ marginTop: 18, fontSize: 17 }}>Fee and deposit</h3>

        <div className="row">
          <div>
            <label htmlFor="defaultFee">Entry fee</label>
            <input
              id="defaultFee" name="defaultFee" type="text" inputMode="decimal"
              defaultValue={
                settings.defaultEntryFeeCents
                  ? (settings.defaultEntryFeeCents / 100).toFixed(2)
                  : ''
              }
              placeholder="700.00" disabled={!director}
            />
          </div>
          <div>
            <label htmlFor="defaultDeposit">Deposit</label>
            <input
              id="defaultDeposit" name="defaultDeposit" type="text" inputMode="decimal"
              defaultValue={(settings.defaultDepositCents / 100).toFixed(2)} disabled={!director}
            />
          </div>
        </div>
        <p className="hint">
          Saving these sets <strong>every one of the {divisions.length} divisions</strong> at once.
          Set them here first, then change only the divisions that differ, further down — that is
          thirteen fewer numbers to type and thirteen fewer chances to mistype one. Leave the fee
          blank to leave every division as it is.
        </p>

        <h3 style={{ marginTop: 18, fontSize: 17 }}>Where money can be sent</h3>

        <label htmlFor="etransferAddress">e-Transfer address</label>
        <input
          id="etransferAddress" name="etransferAddress" type="text" disabled={!director}
          defaultValue={settings.etransferAddress ?? ''}
          placeholder="treasurer@kanatabaseball.com"
        />
        <p className="hint">
          Shown on every coach&apos;s page with their reference to quote. Blank hides the option.
          This rail costs nothing, so every dollar of it reaches CHEO.
        </p>

        <label htmlFor="chequePayableTo">Cheques payable to</label>
        <input
          id="chequePayableTo" name="chequePayableTo" type="text" disabled={!director}
          defaultValue={settings.chequePayableTo ?? ''}
        />

        <label htmlFor="chequeMailTo">Posted to</label>
        <input
          id="chequeMailTo" name="chequeMailTo" type="text" disabled={!director}
          defaultValue={settings.chequeMailTo ?? ''}
          placeholder="the address on the back of the cheque"
        />

        {director && (
          <button type="submit" className="primary wide" style={{ minHeight: 48, marginTop: 14 }}>
            Save
          </button>
        )}
      </form>

      {/* --- Fees per division --------------------------------------------------- */}

      <h2>Fees and caps</h2>
      {divisions.length === 0 ? (
        <div className="empty">No divisions set up yet.</div>
      ) : (
        groups.map((group) => (
        <div key={group.ageGroup ?? 'other'}>
        <h3 style={{ fontSize: 17, margin: '18px 0 6px' }}>{group.ageGroup ?? 'Other'}</h3>
        {group.divisions.map((division) => {
          const room = capacityFor.get(division.id);
          return (
            <form key={division.id} action={saveFeesAction} className="card">
              <input type="hidden" name="divisionId" value={division.id} />
              <strong style={{ display: 'block', fontSize: 17 }}>{division.name}</strong>
              <div className="meta" style={{ marginBottom: 8 }}>
                {room ? `${room.accepted} in · ${room.waiting} waiting` : ''}
              </div>

              <div className="row">
                <div>
                  <label htmlFor={`fee-${division.id}`}>Entry fee</label>
                  <input
                    id={`fee-${division.id}`} name="fee" type="text" inputMode="decimal"
                    defaultValue={(division.entryFeeCents / 100).toFixed(2)} disabled={!director}
                  />
                </div>
                <div>
                  <label htmlFor={`deposit-${division.id}`}>Deposit</label>
                  <input
                    id={`deposit-${division.id}`} name="deposit" type="text" inputMode="decimal"
                    defaultValue={(division.depositCents / 100).toFixed(2)} disabled={!director}
                  />
                </div>
                <div>
                  <label htmlFor={`cap-${division.id}`}>Teams</label>
                  <input
                    id={`cap-${division.id}`} name="cap" type="number" min={1}
                    defaultValue={division.teamCap ?? ''} placeholder="no limit"
                    disabled={!director}
                  />
                </div>
              </div>

              {director && (
                <button type="submit" className="wide" style={{ minHeight: 44, marginTop: 10 }}>
                  Save {division.name}
                </button>
              )}
            </form>
          );
        })}
        </div>
        ))
      )}

      <p className="sub">
        A cap does not stop anybody entering — a full division still takes entries onto its
        waitlist, because teams drop out every year and a coach turned away at the door does not
        come back to check.
      </p>
    </>
  );
}
