import { notFound } from 'next/navigation';
import { currentTournament } from '@/server/repo';
import { volunteerByToken } from '@/server/volunteers';
import { ROLE_LABEL } from '@/domain/volunteers';
import { formatDateFriendly, formatTimeFriendly } from '@/domain/time';
import { confirmAction } from './actions';

export const dynamic = 'force-dynamic';

/**
 * A volunteer's own page.
 *
 * Opened once, on a Saturday morning, in a car park, by somebody who has never
 * seen it before and will not see it again. So it answers the only two
 * questions they have — where am I meant to be, and when — before anything
 * else, and it does not ask them to log in to find out.
 *
 * The confirm button is the one thing it asks *of* them, and it exists because
 * a coordinator pencilling somebody in is not the same as that person knowing
 * about it. That gap is what she spends August on the phone about.
 */
export default async function VolunteerPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ confirmed?: string }>;
}) {
  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const { token } = await params;
  const search = await searchParams;

  const person = await volunteerByToken(token);
  if (!person) notFound();

  const unconfirmed = person.bookings.filter((booking) => !booking.confirmed);

  return (
    <>
      <h1>{person.name}</h1>
      <p className="sub">
        {tournament.name} · {person.bookings.length} shift
        {person.bookings.length === 1 ? '' : 's'}
        {person.hours > 0 ? ` · ${person.hours} hours` : ''}
      </p>

      {search.confirmed && (
        <div className="notice ok">Thank you — that is confirmed and the coordinator can see it.</div>
      )}

      <div className="notice ok">
        <strong>Thank you.</strong> The weekend does not happen without about a hundred people doing
        this, and every dollar it raises goes to CHEO Cardiology.
      </div>

      {person.status === 'withdrawn' && (
        <div className="notice warn">
          You are marked as having pulled out. If that is wrong, ring the tournament — this page
          cannot change it.
        </div>
      )}

      {person.clashes.length > 0 && (
        <div className="notice error">
          <strong>Two of these overlap.</strong> Somebody has put you in two places at once, which
          is a mistake at our end rather than yours. Ring the tournament and it will be sorted.
          <ul style={{ margin: '8px 0 0 18px' }}>
            {person.clashes.map((clash, index) => (
              <li key={index}>{clash.message}</li>
            ))}
          </ul>
        </div>
      )}

      {unconfirmed.length > 0 && (
        <div className="notice info">
          {unconfirmed.length === 1
            ? 'One shift below needs a yes from you.'
            : `${unconfirmed.length} shifts below need a yes from you.`}{' '}
          It takes one tap and saves somebody a phone call.
        </div>
      )}

      {/* --- Where to be ---------------------------------------------------------- */}

      <h2>Your shifts</h2>
      {person.bookings.length === 0 ? (
        <div className="empty">
          Nothing yet. You are on the list and somebody will be in touch — there is nothing you need
          to do with this page in the meantime.
        </div>
      ) : (
        person.bookings.map((booking) => (
          <div key={booking.shiftId} className="card">
            <strong style={{ fontSize: 20, display: 'block' }}>{booking.where}</strong>
            <div style={{ fontSize: 17, margin: '4px 0' }}>
              {formatDateFriendly(booking.startsAt)}, {formatTimeFriendly(booking.startsAt)} to{' '}
              {formatTimeFriendly(booking.endsAt)}
            </div>
            <div className="meta">{ROLE_LABEL[booking.role]}</div>

            {booking.withThem.length > 0 && (
              <div className="meta">With you: {booking.withThem.join(', ')}</div>
            )}
            {booking.notes && <p className="hint">{booking.notes}</p>}

            {booking.role === 'diamond' && (
              <div className="notice info" style={{ marginTop: 10, marginBottom: 0 }}>
                <strong>You can text the scores in.</strong> When a game finishes, text the result
                to the tournament number — &ldquo;Kanata 7 Nepean 4&rdquo; is enough. It goes
                straight onto the board and saves somebody driving a sheet back to the main field.
              </div>
            )}

            {booking.role === 'site_supervisor' && (
              <div className="notice info" style={{ marginTop: 10, marginBottom: 0 }}>
                <strong>You can text the scores in, for any diamond at {booking.where}.</strong> As
                each signed sheet reaches you, text the result to the tournament number —
                &ldquo;Kanata 7 Nepean 4&rdquo; is enough, and you do not need to say which diamond.
                It goes straight onto the board. Keep the paper; the text is what makes the standings
                move, and the sheet is what settles an argument later.
              </div>
            )}

            {booking.confirmed ? (
              <p className="hint" style={{ marginTop: 10 }}>Confirmed — thank you.</p>
            ) : (
              <form action={confirmAction} style={{ marginTop: 12 }}>
                <input type="hidden" name="token" value={token} />
                <input type="hidden" name="shiftId" value={booking.shiftId} />
                <button type="submit" className="primary wide" style={{ minHeight: 48 }}>
                  Yes, I can do this one
                </button>
              </form>
            )}
          </div>
        ))
      )}

      <p className="sub">
        Something wrong here? Ring the tournament rather than replying to whoever sent you this — a
        change made on the phone reaches the coverage board straight away.
      </p>

      <div style={{ display: 'flex', gap: 10, margin: '16px 0', flexWrap: 'wrap' }}>
        <a className="btn" href="/schedule" style={{ flex: 1 }}>The schedule</a>
        <a className="btn" href="/" style={{ flex: 1 }}>Tournament</a>
      </div>
    </>
  );
}
