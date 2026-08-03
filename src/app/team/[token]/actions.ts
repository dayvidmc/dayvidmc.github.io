'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { teamByAccessToken } from '@/server/auth';
import { teamRegistration } from '@/server/rosters';
import {
  addPlayer,
  addPlayersFromText,
  removePlayer,
  savePlayerField,
} from '@/server/rosters';
import { queryOne } from '@/db/client';
import type { SaveResult } from '../../_components/AutoSave';

/**
 * A coach editing their own roster, through their magic link.
 *
 * The link is the authentication, as it is everywhere else in §5.7. What is
 * different here is that this is the first place a link *writes* something
 * about the team rather than reading it, so two guards matter:
 *
 *   1. Every action re-resolves the token and works only on that team. A player
 *      id from another team is simply not found.
 *   2. A locked roster is read-only to the coach. Locking happens at the
 *      coaches' meeting and is what turns a roster into evidence; after it,
 *      changes go through HQ and are recorded against a name.
 *
 * Before the lock the coach edits freely. Making them phone HQ to fix a typo
 * is how you end up with no rosters at all.
 */

async function openRoster(token: string) {
  const team = await teamByAccessToken(token);
  if (!team) return null;

  const registration = await teamRegistration(team.id);
  if (!registration || registration.roster_locked_at) return null;

  return { team, registration };
}

/** Confirms the player belongs to this team before anything touches them. */
async function playerOnTeam(teamId: string, playerId: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    'SELECT id FROM player WHERE id = $1 AND team_id = $2',
    [playerId, teamId],
  );
  return row !== null;
}

export async function addPlayerAction(formData: FormData): Promise<void> {
  const token = String(formData.get('token') ?? '');
  const open = await openRoster(token);
  if (!open) redirect(`/team/${token}?error=locked`);

  const name = String(formData.get('name') ?? '');
  const jersey = String(formData.get('jersey') ?? '');
  if (!name.trim()) redirect(`/team/${token}#roster`);

  const result = await addPlayer(
    open.team.tournament_id,
    open.team.id,
    name,
    jersey,
    `${open.team.name} (coach link)`,
    'coach',
  );

  revalidatePath(`/team/${token}`);
  redirect(result.ok ? `/team/${token}#roster` : `/team/${token}?error=jersey_taken#roster`);
}

export async function pasteRosterAction(formData: FormData): Promise<void> {
  const token = String(formData.get('token') ?? '');
  const open = await openRoster(token);
  if (!open) redirect(`/team/${token}?error=locked`);

  const text = String(formData.get('roster') ?? '');
  const result = await addPlayersFromText(
    open.team.tournament_id,
    open.team.id,
    text,
    `${open.team.name} (coach link)`,
    'coach',
  );

  revalidatePath(`/team/${token}`);
  redirect(
    result.ok
      ? `/team/${token}?added=${result.added}#roster`
      : `/team/${token}?error=unreadable#roster`,
  );
}

export async function removePlayerAction(formData: FormData): Promise<void> {
  const token = String(formData.get('token') ?? '');
  const playerId = String(formData.get('playerId') ?? '');
  const open = await openRoster(token);
  if (!open) redirect(`/team/${token}?error=locked`);

  if (await playerOnTeam(open.team.id, playerId)) {
    await removePlayer(
      open.team.tournament_id,
      playerId,
      `${open.team.name} (coach link)`,
      'coach',
    );
  }

  revalidatePath(`/team/${token}`);
  redirect(`/team/${token}#roster`);
}

/** Bound to a token and a player id by the page, for the auto-saving fields. */
export async function savePlayer(
  token: string,
  playerId: string,
  field: string,
  value: string,
): Promise<SaveResult> {
  const open = await openRoster(token);
  if (!open) return { ok: false, error: 'This roster is locked. HQ can still change it.' };
  if (!(await playerOnTeam(open.team.id, playerId))) {
    return { ok: false, error: 'Not one of your players.' };
  }

  const result = await savePlayerField(open.team.tournament_id, playerId, field, value);
  if (!result.ok) return { ok: false, error: result.error ?? 'That could not be saved.' };

  revalidatePath(`/team/${token}`);
  return { ok: true };
}
