import { currentTournament } from '@/server/repo';
import { pageBySlug } from '@/server/site';
import { board } from '@/server/volunteers';
import { ROLE_LABEL, ROLE_ORDER } from '@/domain/volunteers';
import { Prose } from '../_components/Prose';
import { offerToHelpAction } from './actions';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Volunteer',
  description:
    'The Tokessy tournament is run entirely by volunteers. An hour at a diamond or a canteen is worth more than it sounds.',
};

const ERROR: Record<string, string> = {
  no_name: 'We need a name to put on the list.',
  no_contact: 'A phone number or an email address — otherwise nobody can ring you back.',
  closed: 'The tournament is not set up yet. Try again shortly.',
};

/**
 * Offering to help, without knowing anybody.
 *
 * Until now the only way onto the volunteer list was for the coordinator to
 * type somebody in, which means every volunteer had to already know her. That
 * is a real limit on a tournament whose own description of staffing is "a mix,
 * and it is a struggle every year".
 *
 * The page shows what is actually short before it asks. Somebody deciding
 * whether to give up a Saturday morning is better served by "three diamonds
 * have nobody on them" than by a general appeal, and it is also true.
 */
export default async function VolunteerPage({
  searchParams,
}: {
  searchParams: Promise<{ thanks?: string; error?: string }>;
}) {
  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const params = await searchParams;
  const [{ summary }, intro] = await Promise.all([
    board(tournament.id),
    pageBySlug(tournament.id, 'volunteer-intro'),
  ]);

  if (params.thanks) {
    return (
      <>
        <h1>Thank you.</h1>
        <div className="notice ok">
          You are on the list. The volunteer coordinator will be in touch to sort out when — she
          does this by hand, so it may be a few days rather than a few minutes.
        </div>
        <p>
          Nothing else is needed from you now. When you are put on a shift you will get your own
          link showing where to go, when, and who else is on with you.
        </p>
        <a className="btn primary wide" href="/" style={{ minHeight: 48 }}>
          Back to the tournament
        </a>
      </>
    );
  }

  return (
    <>
      <h1>Volunteer</h1>
      <p className="sub">
        This tournament is run entirely by volunteers. There is no paid staff at all.
      </p>

      {params.error && <div className="notice error">{ERROR[params.error] ?? 'That did not work.'}</div>}

      {summary.peopleNeeded > summary.peopleStanding && (
        <div className="notice warn">
          <strong>
            {summary.peopleNeeded - summary.peopleStanding} place
            {summary.peopleNeeded - summary.peopleStanding === 1 ? '' : 's'} still to fill
          </strong>{' '}
          across {summary.shifts} shift{summary.shifts === 1 ? '' : 's'}.
          {summary.emptyShifts > 0 &&
            ` ${summary.emptyShifts} of them have nobody on them at all.`}
        </div>
      )}

      {intro ? (
        <Prose source={intro.body} />
      ) : (
        <p>
          Most shifts are two to four hours. You do not need to know baseball, you do not need to
          commit to the whole weekend, and an hour on a Saturday morning is genuinely useful —
          somebody has to line the diamonds before anybody can play on them.
        </p>
      )}

      <h2>What needs doing</h2>
      <div className="card">
        {ROLE_ORDER.map((role) => (
          <div key={role} className="row-item">
            <span>{ROLE_LABEL[role]}</span>
          </div>
        ))}
      </div>

      <h2>Put your name down</h2>
      <form action={offerToHelpAction} className="card">
        <label htmlFor="name">Your name</label>
        <input id="name" name="name" type="text" maxLength={160} autoComplete="name" required />

        <div className="row">
          <div>
            <label htmlFor="phone">Mobile</label>
            <input id="phone" name="phone" type="tel" autoComplete="tel" placeholder="613 555 0142" />
          </div>
          <div>
            <label htmlFor="email">Email</label>
            <input id="email" name="email" type="email" autoComplete="email" maxLength={200} />
          </div>
        </div>
        <p className="hint">
          One of the two is enough. A mobile is more use on the weekend itself — that is how the
          coordinator reaches somebody when a shift falls through at nine on a Saturday.
        </p>

        <label htmlFor="canDo">What you would rather do</label>
        <input
          id="canDo" name="canDo" type="text" maxLength={300}
          placeholder="e.g. canteen, or anything except the barbecue"
        />

        <label htmlFor="when">When you are free</label>
        <input
          id="when" name="when" type="text" maxLength={300}
          placeholder="e.g. Saturday morning only"
        />

        <label htmlFor="notes">Anything else worth knowing</label>
        <input
          id="notes" name="notes" type="text" maxLength={500}
          placeholder="optional — e.g. my daughter plays in Minor A"
        />

        <button type="submit" className="primary wide" style={{ minHeight: 52, marginTop: 14 }}>
          Put me on the list
        </button>
        <p className="hint">
          This puts you on the coordinator&rsquo;s list. It does not commit you to a shift — she
          will be in touch to work out what suits.
        </p>
      </form>

      {tournament.contact_volunteers && (
        <p className="sub">
          Questions first? Email{' '}
          <a href={`mailto:${tournament.contact_volunteers}`}>{tournament.contact_volunteers}</a>.
        </p>
      )}
    </>
  );
}
