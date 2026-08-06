import { redirect } from 'next/navigation';
import { canAccessHq, currentStaff } from '@/server/auth';
import { currentTournament } from '@/server/repo';
import { volunteers } from '@/server/volunteers';
import { formatPhone } from '@/domain/contact';
import { AutoSaveField } from '../../../_components/AutoSave';
import { addVolunteerAction, importAction, saveVolunteer, setStatusAction } from '../actions';

export const dynamic = 'force-dynamic';

const ERROR: Record<string, string> = {
  no_name: 'A volunteer needs a name.',
  duplicate: 'Somebody with that name is already on the list.',
};

const STATUS_LABEL: Record<string, string> = {
  available: 'Available',
  unavailable: 'Not this year',
  withdrawn: 'Pulled out',
};

/**
 * The list, and the paste that fills it.
 *
 * The coordinator already has a spreadsheet with everybody on it. The realistic
 * alternative to a paste box is not her typing a hundred rows into a form — it
 * is her not using this at all and carrying on with the spreadsheet, which is a
 * perfectly good outcome for her and a bad one for whoever inherits the job.
 *
 * So the import takes whatever shape her sheet is in — tabs, commas, or a name
 * and a number with nothing but spaces between them — and reports what it could
 * not read instead of quietly importing most of it.
 */
export default async function VolunteerListPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    saved?: string;
    added?: string;
    already?: string;
    unreadable?: string;
    dupes?: string;
  }>;
}) {
  const staff = await currentStaff();
  if (!canAccessHq(staff) && staff?.role !== 'volunteer_coordinator') redirect('/signin');

  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const params = await searchParams;
  const people = await volunteers(tournament.id);

  const withoutPhone = people.filter((person) => !person.phone && person.status === 'available');
  const spare = people.filter((person) => person.status === 'available' && person.shifts === 0);

  return (
    <>
      <h1>The volunteer list</h1>
      <p className="sub">
        {people.length} {people.length === 1 ? 'person' : 'people'} ·{' '}
        {people.filter((p) => p.status === 'available').length} available
      </p>

      <div className="subnav">
        <a className="btn back" href="/hq/volunteers">← Coverage</a>
        <a className="btn" href="/hq/volunteers/shifts">Shifts</a>
      </div>

      {params.error && <div className="notice error">{ERROR[params.error] ?? 'That did not work.'}</div>}
      {params.saved && <div className="notice ok">Saved.</div>}

      {params.added && (
        <div className="notice ok">
          {params.added} added.
          {params.already && ` Already on the list, so left alone: ${params.already}.`}
        </div>
      )}
      {params.unreadable && (
        <div className="notice error">
          {params.unreadable} line{params.unreadable === '1' ? '' : 's'} could not be read and{' '}
          {params.unreadable === '1' ? 'was' : 'were'} <strong>not</strong> added. Look at those
          rows — a list that imports most of itself is worse than one that refuses, because nobody
          counts.
        </div>
      )}
      {params.dupes && (
        <div className="notice warn">
          These names appeared more than once in what you pasted: {params.dupes}. Only the first of
          each was added.
        </div>
      )}

      {spare.length > 0 && (
        <div className="notice info">
          {spare.length} {spare.length === 1 ? 'person is' : 'people are'} available with no shift
          at all: {spare.slice(0, 6).map((person) => person.name).join(', ')}
          {spare.length > 6 ? '…' : ''}.
        </div>
      )}

      {withoutPhone.length > 0 && (
        <div className="notice warn">
          {withoutPhone.length} available {withoutPhone.length === 1 ? 'person has' : 'people have'}{' '}
          no phone number. Nothing can reach them on the day, and somebody at a diamond without one
          cannot text a score in.
        </div>
      )}

      {/* --- The paste ---------------------------------------------------------- */}

      <h2>Paste your list</h2>
      <form action={importAction} className="card">
        <label htmlFor="people">One person per line</label>
        <textarea
          id="people"
          name="people"
          rows={8}
          placeholder={'Marion Ellis\t613-555-0142\tmarion@example.com\tCanteen, Saturday only\nSam Rivera, 613 555 0188, sam@example.com\nJo Tremblay 613 555 0199 back gate only'}
        />
        <p className="hint">
          Straight out of a spreadsheet, an email, or a phone&apos;s notes — tabs, commas or just
          spaces all work, and a header row is ignored. Somebody already on the list is skipped and
          named rather than overwritten, so pasting the same sheet twice is safe.
        </p>
        <button type="submit" className="primary wide" style={{ minHeight: 48, marginTop: 8 }}>
          Add them
        </button>
      </form>

      {/* --- Everybody ----------------------------------------------------------- */}

      <h2>Everybody</h2>
      {people.length === 0 && <div className="empty">Nobody on the list yet.</div>}

      {people.map((person) => {
        const save = saveVolunteer.bind(null, person.id);
        return (
          <div
            key={person.id}
            className="card"
            style={{ opacity: person.status === 'available' ? 1 : 0.6 }}
          >
            <div className="top">
              <div>
                <div className="teams" style={{ fontSize: 16 }}>{person.name}</div>
                <div className="meta">
                  {person.phone ? formatPhone(person.phone) || person.phone : 'no phone'}
                  {person.email ? ` · ${person.email}` : ''}
                  {person.teamName ? ` · ${person.teamName}` : ''}
                </div>
                <div className="meta">
                  {person.shifts === 0
                    ? 'no shifts'
                    : `${person.shifts} shift${person.shifts === 1 ? '' : 's'} · ${person.hours} hours`}
                </div>
                {person.canDo && <div className="meta">Can do: {person.canDo}</div>}
                {person.cannotDo && <div className="meta">Cannot do: {person.cannotDo}</div>}
              </div>
              {person.status !== 'available' && (
                <span className="pill warn">{STATUS_LABEL[person.status]}</span>
              )}
            </div>

            <details style={{ marginTop: 8 }}>
              <summary>Edit</summary>
              <div style={{ marginTop: 10 }}>
                <AutoSaveField save={save} field="name" label="Name" defaultValue={person.name} />
                <AutoSaveField
                  save={save} field="phone" label="Mobile" defaultValue={person.phone ?? ''}
                  hint="How they are reached on the day. A diamond volunteer without one cannot text a score in."
                />
                <AutoSaveField save={save} field="email" label="Email" defaultValue={person.email ?? ''} />
                <AutoSaveField
                  save={save} field="can_do" label="Can do" defaultValue={person.canDo ?? ''}
                  placeholder="e.g. canteen, Saturday only"
                />
                <AutoSaveField
                  save={save} field="cannot_do" label="Cannot do"
                  defaultValue={person.cannotDo ?? ''} placeholder="e.g. no lifting"
                />
                <AutoSaveField
                  save={save} field="notes" label="Notes" defaultValue={person.notes ?? ''}
                />

                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                  {(['available', 'unavailable', 'withdrawn'] as const).map((status) => (
                    <form key={status} action={setStatusAction} style={{ flex: '1 1 30%' }}>
                      <input type="hidden" name="id" value={person.id} />
                      <input type="hidden" name="status" value={status} />
                      <button
                        type="submit"
                        className={person.status === status ? 'primary wide' : 'wide'}
                        style={{ minHeight: 44, fontSize: 14 }}
                      >
                        {STATUS_LABEL[status]}
                      </button>
                    </form>
                  ))}
                </div>

                <p className="hint">
                  Their own page:{' '}
                  <a href={`/volunteer/${person.accessToken}`}>/volunteer/{person.accessToken.slice(0, 8)}…</a>{' '}
                  — shows their shifts and lets them confirm. No password; the link is the
                  credential, same as a team&apos;s.
                </p>
              </div>
            </details>
          </div>
        );
      })}
    </>
  );
}
