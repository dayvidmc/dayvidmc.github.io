import { notFound, redirect } from 'next/navigation';
import { canAccessHq, currentStaff, isDirector } from '@/server/auth';
import { currentTournament } from '@/server/repo';
import { rosterFor, teamRegistration } from '@/server/rosters';
import { REGISTRATION_LABEL, rosterIssues, type RegistrationStatus } from '@/domain/roster';
import { formatPhone } from '@/domain/contact';
import { formatDateFriendly, toWallClock } from '@/domain/time';
import { AutoSaveField } from '../../../_components/AutoSave';
import { CopyLink } from '../../../_components/CopyLink';
import {
  hqAddPlayerAction,
  hqPasteRosterAction,
  hqRemovePlayerAction,
  hqSavePlayer,
  setStatusAction,
  toggleLockAction,
} from '../actions';

export const dynamic = 'force-dynamic';

/**
 * One team's registration and roster, from HQ.
 *
 * HQ edits here whether or not the roster is locked. That is what locking
 * means: it stops being something the coach changes and becomes something HQ
 * changes on the record.
 */
export default async function TeamRegistrationPage({
  params,
  searchParams,
}: {
  params: Promise<{ teamId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');

  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const { teamId } = await params;
  const search = await searchParams;

  const team = await teamRegistration(teamId);
  if (!team || team.division_id === null) notFound();

  const roster = await rosterFor(team.id);
  const issues = rosterIssues(roster);
  const locked = team.roster_locked_at != null;
  const director = isDirector(staff);

  return (
    <>
      <h1>{team.name}</h1>
      <p className="sub">
        {team.division_name} · {REGISTRATION_LABEL[team.registration_status]}
        {team.registered_at
          ? ` since ${formatDateFriendly(toWallClock(team.registered_at))}`
          : ''}
      </p>

      <div className="subnav">
        <a className="btn back" href="/hq/registration">← Registration</a>
        <a className="btn" href="/hq/teams">Contacts</a>
      </div>

      {search.error === 'unreadable' && (
        <div className="notice warn">Nothing readable in that paste. One player per line.</div>
      )}

      {team.registration_status === 'withdrawn' && (
        <div className="notice error">
          Withdrawn{team.withdrawn_reason ? ` — ${team.withdrawn_reason}` : ''}. Their games are
          still on the schedule; somebody has to decide what happens to them.
        </div>
      )}

      {/* --- Where they are in the process ---------------------------------- */}

      <h2>Status</h2>
      <div className="card">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {(['invited', 'registered', 'confirmed'] as RegistrationStatus[]).map((status) => (
            <form key={status} action={setStatusAction} style={{ flex: '1 1 30%' }}>
              <input type="hidden" name="teamId" value={team.id} />
              <input type="hidden" name="status" value={status} />
              <button
                type="submit"
                className={team.registration_status === status ? 'primary wide' : 'wide'}
                style={{ minHeight: 44 }}
              >
                {REGISTRATION_LABEL[status]}
              </button>
            </form>
          ))}
        </div>

        {director && team.registration_status !== 'withdrawn' && (
          <form action={setStatusAction} style={{ marginTop: 12 }}>
            <input type="hidden" name="teamId" value={team.id} />
            <input type="hidden" name="status" value="withdrawn" />
            <label htmlFor="reason">Withdrawing? Why</label>
            <input id="reason" name="reason" type="text" placeholder="e.g. could not field a team" />
            <button type="submit" className="wide" style={{ marginTop: 8, minHeight: 44 }}>
              Withdraw this team
            </button>
            <p className="hint">
              Takes them out of the division. Their scheduled games stay put — pulling a team out
              mid-schedule is a decision about the whole division, not one team.
            </p>
          </form>
        )}
      </div>

      {/* --- Contact -------------------------------------------------------- */}

      <h2>Contact</h2>
      <div className="card">
        <div className="meta">
          {team.coach_name ?? 'No coach name'}
          {team.coach_phone ? ` · ${formatPhone(team.coach_phone)}` : ' · no mobile'}
          {team.coach_email ? ` · ${team.coach_email}` : ''}
        </div>
        <a className="btn" href="/hq/teams" style={{ marginTop: 10 }}>
          Edit contact details
        </a>
        <CopyLink path={`/team/${team.access_token}`} label="Their link — roster, games, standing" />
      </div>

      {/* --- Roster --------------------------------------------------------- */}

      <h2>Roster</h2>
      <p className="sub">
        {roster.length} player{roster.length === 1 ? '' : 's'} · you can edit this whether or not it
        is locked
      </p>

      {issues.map((issue, index) => (
        <div key={index} className={`notice ${issue.severity === 'blocking' ? 'error' : 'info'}`}>
          {issue.message}
        </div>
      ))}

      <form action={toggleLockAction} className="card">
        <input type="hidden" name="teamId" value={team.id} />
        <input type="hidden" name="locked" value={locked ? 'false' : 'true'} />
        <button type="submit" className="wide" style={{ minHeight: 44 }}>
          {locked ? 'Unlock so the coach can edit' : 'Lock this roster'}
        </button>
        <p className="hint">
          {locked
            ? `Locked${team.roster_locked_by ? ` by ${team.roster_locked_by}` : ''}. The coach's link shows it read-only.`
            : 'Locking is what turns a roster into the roster of record. Do it at the coaches’ meeting.'}
        </p>
      </form>

      {roster.length > 0 && (
        <div className="card">
          {roster.map((player) => {
            const save = hqSavePlayer.bind(null, player.id);
            return (
              <div key={player.id} className="row-item" style={{ alignItems: 'flex-start' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="row" style={{ alignItems: 'center' }}>
                    <div style={{ flex: '0 0 68px' }}>
                      <AutoSaveField
                        save={save} field="jersey" label={`Number for ${player.name}`}
                        labelHidden defaultValue={player.jersey ?? ''} placeholder="#"
                      />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <AutoSaveField
                        save={save} field="name" label="Player name" labelHidden
                        defaultValue={player.name}
                      />
                    </div>
                  </div>
                </div>
                <form action={hqRemovePlayerAction}>
                  <input type="hidden" name="playerId" value={player.id} />
                  <input type="hidden" name="teamId" value={team.id} />
                  <button type="submit" style={{ minHeight: 44, padding: '8px 12px', fontSize: 14 }}>
                    Remove
                  </button>
                </form>
              </div>
            );
          })}
        </div>
      )}

      <form action={hqAddPlayerAction} className="card">
        <input type="hidden" name="teamId" value={team.id} />
        <div className="row">
          <div style={{ flex: '0 0 90px' }}>
            <label htmlFor="jersey">Number</label>
            <input id="jersey" name="jersey" type="text" inputMode="numeric" placeholder="12" />
          </div>
          <div style={{ flex: 1 }}>
            <label htmlFor="playerName">Name</label>
            <input id="playerName" name="name" type="text" placeholder="Sam Rivera" required />
          </div>
        </div>
        <button type="submit" className="wide" style={{ marginTop: 12, minHeight: 44 }}>
          Add one player
        </button>
      </form>

      <details className="card">
        <summary style={{ cursor: 'pointer', fontWeight: 600, padding: '4px 0' }}>
          Paste a whole roster
        </summary>
        <form action={hqPasteRosterAction}>
          <input type="hidden" name="teamId" value={team.id} />
          <label htmlFor="rosterPaste">One player per line</label>
          <textarea id="rosterPaste" name="roster" rows={8} placeholder={'12 Sam Rivera\n3 Alex Kim'} />
          <button type="submit" className="primary wide" style={{ marginTop: 8, minHeight: 44 }}>
            Add these players
          </button>
        </form>
      </details>
    </>
  );
}
