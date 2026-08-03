import { redirect } from 'next/navigation';
import { canAccessHq, currentStaff, isDirector } from '@/server/auth';
import { currentTournament, listDivisions } from '@/server/repo';
import { query } from '@/db/client';
import { describeTransport, smsConfig } from '@/server/sms';
import { AutoSaveField } from '../../_components/AutoSave';
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
    query<{
      teams: string; no_phone: string; games: string; shifts: string; diamonds: string;
      queued: string; failed: string;
    }>(
      `SELECT (SELECT count(*) FROM team WHERE tournament_id = $1)::text AS teams,
              (SELECT count(*) FROM team WHERE tournament_id = $1 AND coach_phone IS NULL)::text AS no_phone,
              (SELECT count(*) FROM game WHERE tournament_id = $1 AND cancelled_at IS NULL)::text AS games,
              (SELECT count(*) FROM diamond_shift WHERE tournament_id = $1)::text AS shifts,
              (SELECT count(DISTINCT diamond_id) FROM game WHERE tournament_id = $1)::text AS diamonds,
              (SELECT count(*) FROM notification WHERE tournament_id = $1 AND status = 'queued')::text AS queued,
              (SELECT count(*) FROM notification WHERE tournament_id = $1 AND status = 'failed')::text AS failed`,
      [tournament.id],
    ),
  ]);

  const c = counts[0]!;
  const queued = Number(c.queued);
  const failed = Number(c.failed);
  const transport = smsConfig();
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
      href: '/hq/shifts',
    },
    {
      done: !!process.env.TWILIO_AUTH_TOKEN,
      label: 'Twilio configured for inbound texts',
      detail: process.env.TWILIO_AUTH_TOKEN
        ? 'inbound texts accepted'
        : 'TWILIO_AUTH_TOKEN not set — inbound texts are refused in production',
    },
    {
      // The queue used to grow with nothing draining it, which looks identical
      // to delivery right up until someone asks a volunteer whether they got
      // the text. Now the honest question is whether the transport is real.
      done: transport.transport === 'twilio',
      label: 'Outbound texts are being delivered',
      detail:
        `${describeTransport(transport)}. ` +
        `${queued} queued, ${failed} failed to send.`,
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
              <a className="btn" href={check.href} style={{ minHeight: 40, padding: '8px 14px', fontSize: 15 }}>
                Fix
              </a>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
