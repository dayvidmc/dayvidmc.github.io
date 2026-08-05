import { redirect } from 'next/navigation';
import { canAccessHq, currentStaff, isDirector } from '@/server/auth';
import { currentTournament, listDivisions } from '@/server/repo';
import { query } from '@/db/client';
import { outboundStatus } from '@/server/sms/drain';
import { AutoSaveField, AutoSaveToggle } from '../../_components/AutoSave';
import { saveTournamentField } from '../editActions';

export const dynamic = 'force-dynamic';

/**
 * Tournament settings, and a place to see what still needs doing.
 *
 * The readiness list at the bottom is the point of this screen. Each item is
 * something that is quietly fine in February and expensive in July: a division
 * whose rules nobody checked, teams with no phone number, no diamond volunteers
 * on shift. All of them are invisible until someone goes looking.
 */
export default async function SettingsPage() {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');

  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const editable = isDirector(staff);

  const [divisions, counts] = await Promise.all([
    listDivisions(tournament.id),
    query<{ teams: string; no_phone: string; games: string; shifts: string; diamonds: string; queued: string }>(
      `SELECT (SELECT count(*) FROM team WHERE tournament_id = $1)::text AS teams,
              (SELECT count(*) FROM team WHERE tournament_id = $1 AND coach_phone IS NULL)::text AS no_phone,
              (SELECT count(*) FROM game WHERE tournament_id = $1 AND cancelled_at IS NULL)::text AS games,
              (SELECT count(*) FROM diamond_posting WHERE tournament_id = $1)::text AS shifts,
              (SELECT count(DISTINCT diamond_id) FROM game WHERE tournament_id = $1)::text AS diamonds,
              (SELECT count(*) FROM notification WHERE tournament_id = $1 AND status = 'queued')::text AS queued`,
      [tournament.id],
    ),
  ]);

  const outbound = await outboundStatus(tournament.id);
  const c = counts[0]!;
  const queued = Number(c.queued);
  const unreviewed = divisions.filter((d) => !d.rules_reviewed);

  const checks: { done: boolean; label: string; detail: string; href?: string }[] = [
    {
      done: Number(c.games) > 0,
      label: 'Schedule imported',
      detail: `${c.games} games`,
      href: '/hq/import',
    },
    {
      done: unreviewed.length === 0 && divisions.length > 0,
      label: 'Division rules checked against this year\'s PDFs',
      detail:
        divisions.length === 0
          ? 'no divisions yet'
          : unreviewed.length === 0
            ? `all ${divisions.length} checked`
            : `${unreviewed.length} still unchecked: ${unreviewed.map((d) => d.name).join(', ')}`,
      href: '/hq/rules',
    },
    {
      done: Number(c.no_phone) === 0 && Number(c.teams) > 0,
      label: 'Every team has a coach mobile',
      detail:
        Number(c.teams) === 0
          ? 'no teams yet'
          : Number(c.no_phone) === 0
            ? `all ${c.teams} teams`
            : `${c.no_phone} of ${c.teams} missing — those coaches cannot be texted`,
      href: '/hq/teams',
    },
    {
      done: Number(c.shifts) > 0,
      label: 'Diamond volunteers on shift',
      detail:
        Number(c.shifts) === 0
          ? 'none yet — without these, nobody gets asked for a score'
          : `${c.shifts} shifts across ${c.diamonds} diamonds`,
    },
    {
      done: !!process.env.TWILIO_AUTH_TOKEN,
      label: 'Twilio configured for inbound texts',
      detail: process.env.TWILIO_AUTH_TOKEN
        ? 'inbound texts accepted'
        : 'TWILIO_AUTH_TOKEN not set — inbound texts are refused in production',
    },
    {
      // The sender exists now, but "a sender exists" and "texts are reaching
      // phones" are different claims, and only the second one matters on
      // Saturday. So this reports which of the two is true.
      done: outbound.provider !== 'console' && outbound.blocked === null,
      label:
        outbound.blocked !== null
          ? 'Texts cannot be sent'
          : outbound.provider === 'console'
            ? 'Texts are in dry-run — nobody is being texted'
            : 'Texts are going out',
      detail:
        outbound.blocked !== null
          ? `${outbound.blocked} ${queued} message${queued === 1 ? '' : 's'} waiting.`
          : outbound.provider === 'console'
            ? `Messages are written to the server log and marked sent. ${queued} waiting. ` +
              `Set SMS_PROVIDER=twilio with its credentials before the weekend.`
            : `Through ${outbound.provider}. ${queued} waiting, ${outbound.sent} sent` +
              `${outbound.stuck > 0 ? `, ${outbound.stuck} given up on` : ''}.`,
      href: '/hq/messages',
    },
    {
      // A queue that is due and not moving means nothing is calling the drain,
      // which looks identical to "everything is fine" from every other screen.
      done: outbound.oldestWaitingMinutes === null || outbound.oldestWaitingMinutes <= 15,
      label: 'Something is calling the sender',
      detail:
        outbound.oldestWaitingMinutes === null
          ? 'Nothing is waiting.'
          : `Oldest message has waited ${outbound.oldestWaitingMinutes} minutes. Either the cron ` +
            `is not running or the sender cannot send.`,
      href: '/hq/messages',
    },
  ];

  return (
    <>
      <h1>Settings</h1>
      <p className="sub">
        {editable ? 'Changes save as you go.' : 'Read only — only the director can change these.'}
      </p>

      <a className="btn" href="/hq" style={{ marginBottom: 16 }}>
        ← Back to board
      </a>

      <fieldset disabled={!editable}>
        <legend>Tournament</legend>
        <AutoSaveField
          save={saveTournamentField} field="name" label="Name" defaultValue={tournament.name}
        />
        <AutoSaveField
          save={saveTournamentField} field="starts_on" label="First day" type="date"
          defaultValue={tournament.starts_on}
        />
        <AutoSaveField
          save={saveTournamentField} field="ends_on" label="Last day" type="date"
          defaultValue={tournament.ends_on}
        />
      </fieldset>

      <fieldset disabled={!editable}>
        <legend>Playing hours</legend>
        <AutoSaveField
          save={saveTournamentField} field="day_start_time" label="Play starts" type="time"
          defaultValue={tournament.day_start_time.slice(0, 5)}
          hint="Schedule import warns about games outside these hours. It is a warning, not a rule — you can always override it."
        />
        <AutoSaveField
          save={saveTournamentField} field="day_end_time" label="Play ends" type="time"
          defaultValue={tournament.day_end_time.slice(0, 5)}
        />
      </fieldset>

      <fieldset disabled={!editable}>
        <legend>How scores come in</legend>
        <AutoSaveToggle
          save={saveTournamentField}
          field="umpire_score_entry"
          label="Umpires can report scores"
          defaultChecked={tournament.umpire_score_entry}
          hint="Off by default. Umpires always get their own link with their games and the division rules; this decides whether it also carries a score box. Some associations are explicit that their umpires officiate and do not administer — this is that decision, not a technical one."
        />
      </fieldset>

      <fieldset disabled={!editable}>
        <legend>What the public site says</legend>
        <AutoSaveField
          save={saveTournamentField} field="tagline" label="One line under the name"
          defaultValue={tournament.tagline ?? ''}
          hint="The first thing a stranger reads. e.g. “Canada’s largest Little League charity tournament.”"
        />
        <AutoSaveField
          save={saveTournamentField} field="venue_city" label="Where it is"
          defaultValue={tournament.venue_city ?? ''}
          hint="e.g. Kanata, Ontario. Shown beside the dates and in the footer."
        />
        <AutoSaveField
          save={saveTournamentField} field="established_year" label="First held" type="number"
          defaultValue={tournament.established_year ? String(tournament.established_year) : ''}
          hint="1996. The site works out “29 years and counting” from this, so nobody has to edit a number every July."
        />
        <AutoSaveField
          save={saveTournamentField} field="total_raised_cents" label="Raised since the beginning"
          defaultValue={(tournament.total_raised_cents / 100).toFixed(2)}
          hint="In dollars, every year added up. The single most persuasive figure on the site, and the only one this database cannot work out for itself."
        />
      </fieldset>

      <fieldset disabled={!editable}>
        <legend>Who to email</legend>
        <p className="hint" style={{ marginTop: 0 }}>
          Role addresses rather than people, so a page does not need editing when a volunteer
          changes — and so nobody&rsquo;s personal inbox ends up on a public website.
        </p>
        <AutoSaveField
          save={saveTournamentField} field="contact_general" label="Anything at all"
          defaultValue={tournament.contact_general ?? ''}
        />
        <AutoSaveField
          save={saveTournamentField} field="contact_entries" label="Entering a team"
          defaultValue={tournament.contact_entries ?? ''}
        />
        <AutoSaveField
          save={saveTournamentField} field="contact_sponsors" label="Sponsorship"
          defaultValue={tournament.contact_sponsors ?? ''}
        />
        <AutoSaveField
          save={saveTournamentField} field="contact_volunteers" label="Volunteering"
          defaultValue={tournament.contact_volunteers ?? ''}
        />
      </fieldset>

      <fieldset disabled={!editable}>
        <legend>Concession tickets</legend>
        <AutoSaveField
          save={saveTournamentField} field="ticket_covers" label="One ticket covers"
          defaultValue={tournament.ticket_covers ?? ''}
          hint="In the words you would use at the counter — e.g. “a bag of chips and a drink, or a hot dog”. Shown on the till when a volunteer takes a ticket, so a fourteen-year-old does not have to guess."
        />
        <AutoSaveField
          save={saveTournamentField} field="tickets_per_player" label="Tickets per player"
          type="number"
          defaultValue={String(tournament.tickets_per_player)}
          hint="One each is the usual answer. A team of nine then gets nine and a team of fifteen gets fifteen — the number comes off the roster rather than a flat figure that is wrong for every team but the average one. Zero to turn tickets off."
        />
      </fieldset>

      <fieldset disabled={!editable}>
        <legend>Donations</legend>
        <AutoSaveField
          save={saveTournamentField} field="previous_year_raised_cents" label="Raised last year"
          defaultValue={(tournament.previous_year_raised_cents / 100).toFixed(2)}
          hint="In dollars. Shown publicly as the figure this year is measured against — the thing that makes a running total mean something to somebody scrolling a bracket."
        />
        <AutoSaveToggle
          save={saveTournamentField}
          field="donations_open"
          label="Ask for donations on the public pages"
          defaultChecked={tournament.donations_open}
          hint="Off by default, on purpose. Asking families who have already paid an entry fee is the committee's decision, not a default to inherit. When it is on, the schedule, standings and bracket pages carry a donate button and a running total."
        />
        <AutoSaveField
          save={saveTournamentField} field="donation_message" label="What the donate page says"
          defaultValue={tournament.donation_message ?? ''}
          hint="Optional. A sentence in your own words about where the money goes. Left blank, the page says what it knows: every dollar goes to CHEO Cardiology."
        />
      </fieldset>

      <h2>Before the weekend</h2>
      <div className="card">
        {checks.map((check) => (
          <div key={check.label} className="row-item" style={{ alignItems: 'flex-start' }}>
            <div>
              <div style={{ fontWeight: 600 }}>
                {check.done ? '✅' : '⬜'} {check.label}
              </div>
              <div className="meta">{check.detail}</div>
            </div>
            {check.href && !check.done && (
              <a className="btn" href={check.href} style={{ minHeight: 44, padding: '8px 14px', fontSize: 15 }}>
                Fix
              </a>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
