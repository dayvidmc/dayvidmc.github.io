import { redirect } from 'next/navigation';
import { canAccessHq, currentStaff } from '@/server/auth';
import { currentTournament } from '@/server/repo';
import { board } from '@/server/sponsors';
import { thankYouLine, totalsFor } from '@/domain/sponsors';
import { formatDateFriendly } from '@/domain/time';
import { addSponsorAction, setSponsorFlagAction } from './actions';

export const dynamic = 'force-dynamic';

const money = (cents: number) =>
  `$${(cents / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const ERROR: Record<string, string> = {
  no_name: 'A sponsor needs a name.',
  duplicate: 'There is already a sponsor with that name.',
};

/**
 * Sponsors, and the two things they are actually owed.
 *
 * What a sponsor wants back is not complicated: their name in the pamphlet, and
 * somebody to say thank you afterwards and mean it. Both have failed before —
 * not through carelessness but because the promise lived in an inbox and the
 * pamphlet had a print deadline nobody was tracking against it.
 *
 * So the screen leads with what is still owed, in that order. A late thank-you
 * is a letter sent late. A missing pamphlet entry is a promise broken in print,
 * in front of everybody, and unlike almost everything else here it cannot be
 * fixed on the day.
 */
export default async function SponsorsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');

  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const params = await searchParams;

  // The pamphlet goes to print before the weekend, so its deadline is a month
  // out from the first day rather than anything the tournament has typed in.
  // A real date belongs in settings once somebody knows what the printer needs.
  const startsOn = new Date(`${tournament.starts_on}T12:00:00`);
  const pamphletDeadline = new Date(startsOn.getTime() - 30 * 86_400_000);
  const weekendOver = new Date() > new Date(`${tournament.ends_on}T23:59:59`);

  const { sponsors, tasks, totals } = await board(
    tournament.id,
    pamphletDeadline,
    weekendOver,
  );

  const pamphletTasks = tasks.filter((task) => task.kind.startsWith('pamphlet') || task.kind === 'no_pamphlet_name');
  const thankYouTasks = tasks.filter((task) => task.kind === 'not_thanked');

  return (
    <>
      <h1>Sponsors</h1>
      <p className="sub">
        {sponsors.length} sponsor{sponsors.length === 1 ? '' : 's'} · {money(totals.cashCents)} in
        cash · {money(totals.goodsValueCents)} in goods
      </p>

      <div className="subnav">
        <a className="btn back" href="/hq/money">← Money</a>
        <a className="btn" href="/hq/money/gifts">Gifts in kind</a>
      </div>

      {params.error && <div className="notice error">{ERROR[params.error] ?? 'That did not work.'}</div>}
      {params.saved && <div className="notice ok">Saved.</div>}

      {/* --- What is still owed ------------------------------------------------- */}

      {pamphletTasks.length > 0 && (
        <div className={`notice ${pamphletTasks.some((t) => t.kind === 'pamphlet_overdue') ? 'error' : 'warn'}`}>
          <strong>
            {pamphletTasks.length} sponsor{pamphletTasks.length === 1 ? '' : 's'} not yet in the
            pamphlet.
          </strong>{' '}
          It goes to print around {formatDateFriendly(pamphletDeadline)}, and a name missing from it
          cannot be fixed afterwards.
          <ul style={{ margin: '8px 0 0 18px' }}>
            {pamphletTasks.slice(0, 6).map((task) => (
              <li key={`${task.sponsorId}-${task.kind}`}>
                {task.sponsorName} — {task.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {thankYouTasks.length > 0 && (
        <div className="notice warn">
          <strong>
            {thankYouTasks.length} sponsor{thankYouTasks.length === 1 ? '' : 's'} not thanked yet.
          </strong>{' '}
          Each card below has the sentence to open with.
        </div>
      )}

      {totals.earnedCents > 0 && (
        <div className="notice ok">
          Sponsors&apos; goods raised {money(totals.earnedCents)} at the auction. That figure belongs
          in their letters — it is the difference between a thank-you they remember and one they do
          not.
        </div>
      )}

      {/* --- Everybody ----------------------------------------------------------- */}

      <h2>Everyone who gave</h2>
      {sponsors.length === 0 && (
        <div className="empty">
          No sponsors recorded yet. Add them as they are agreed, so the pamphlet list writes itself.
        </div>
      )}

      {sponsors.map((sponsor) => {
        const own = totalsFor(sponsor);
        return (
          <div key={sponsor.id} className="card">
            <div className="top">
              <div>
                <div className="teams" style={{ fontSize: 16 }}>{sponsor.name}</div>
                {sponsor.pamphletName && sponsor.pamphletName !== sponsor.name && (
                  <div className="meta">In print: {sponsor.pamphletName}</div>
                )}
                <div className="meta">
                  {own.cashCents > 0 ? `${money(own.cashCents)} cash` : 'no cash'}
                  {own.goodsValueCents > 0 ? ` · ${money(own.goodsValueCents)} in goods` : ''}
                  {own.gaveLabour ? ' · gave labour' : ''}
                  {own.earnedCents > 0 ? ` · raised ${money(own.earnedCents)}` : ''}
                </div>
                {sponsor.promised && <div className="meta">Promised: {sponsor.promised}</div>}
                {own.unvalued && (
                  <div className="meta" style={{ color: 'var(--amber)' }}>
                    Something they gave has no value against it.
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
                <span className={`pill ${sponsor.pamphletConfirmedAt ? 'ok' : 'warn'}`}>
                  {sponsor.pamphletConfirmedAt ? 'In the pamphlet' : 'Pamphlet pending'}
                </span>
                {weekendOver && (
                  <span className={`pill ${sponsor.thankedAt ? 'ok' : 'warn'}`}>
                    {sponsor.thankedAt ? 'Thanked' : 'Not thanked'}
                  </span>
                )}
              </div>
            </div>

            {sponsor.gifts.length > 0 && (
              <p className="hint" style={{ marginTop: 8 }}>
                <strong>For the letter:</strong> {thankYouLine(sponsor)}
              </p>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              <form action={setSponsorFlagAction} style={{ flex: '1 1 45%' }}>
                <input type="hidden" name="id" value={sponsor.id} />
                <input type="hidden" name="flag" value="pamphlet" />
                <input type="hidden" name="done" value={sponsor.pamphletConfirmedAt ? '0' : '1'} />
                <button type="submit" className="wide" style={{ minHeight: 44, fontSize: 14 }}>
                  {sponsor.pamphletConfirmedAt ? 'Not in the pamphlet after all' : 'Sent to the pamphlet'}
                </button>
              </form>
              <form action={setSponsorFlagAction} style={{ flex: '1 1 45%' }}>
                <input type="hidden" name="id" value={sponsor.id} />
                <input type="hidden" name="flag" value="thanked" />
                <input type="hidden" name="done" value={sponsor.thankedAt ? '0' : '1'} />
                <button type="submit" className="wide" style={{ minHeight: 44, fontSize: 14 }}>
                  {sponsor.thankedAt ? 'Not thanked after all' : 'Thanked them'}
                </button>
              </form>
            </div>

            {sponsor.contactEmail ? (
              <p className="hint">
                <a href={`mailto:${sponsor.contactEmail}`}>{sponsor.contactEmail}</a>
                {sponsor.contactName ? ` · ${sponsor.contactName}` : ''}
              </p>
            ) : (
              <p className="hint">No email address. Whoever knows them has it in their phone.</p>
            )}
          </div>
        );
      })}

      {/* --- Adding one ----------------------------------------------------------- */}

      <h2>Add a sponsor</h2>
      <form action={addSponsorAction} className="card">
        <label htmlFor="name">Who they are</label>
        <input id="name" name="name" type="text" required maxLength={160} placeholder="Kanata Home Hardware" />

        <label htmlFor="pamphletName">How the name should be printed</label>
        <input
          id="pamphletName" name="pamphletName" type="text" maxLength={200}
          placeholder="Home Hardware (Kanata) Ltd."
        />
        <p className="hint">
          Leave blank if it is the same. Getting a company&apos;s legal name wrong in print is worse
          than leaving them out, and nobody can check it in July.
        </p>

        <label htmlFor="promised">What we promised them</label>
        <input
          id="promised" name="promised" type="text" maxLength={1000}
          placeholder="Name in the pamphlet, banner at the main field"
        />

        <div className="row">
          <div>
            <label htmlFor="contactName">Contact</label>
            <input id="contactName" name="contactName" type="text" maxLength={160} />
          </div>
          <div>
            <label htmlFor="contactEmail">Email</label>
            <input id="contactEmail" name="contactEmail" type="email" maxLength={200} />
          </div>
        </div>

        <button type="submit" className="primary wide" style={{ minHeight: 48, marginTop: 12 }}>
          Add them
        </button>
      </form>

      <p className="sub">
        Receipts are issued by CHEO&apos;s foundation, not by the tournament — nothing here is or
        resembles one. What this produces is the clean list they need.
      </p>
    </>
  );
}
