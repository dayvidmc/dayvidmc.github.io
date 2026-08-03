'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { canAccessHq, currentStaff, isDirector } from '@/server/auth';
import {
  addPlayer,
  addPlayersFromText,
  removePlayer,
  savePlayerField,
  setRegistrationStatus,
  setRosterLock,
} from '@/server/rosters';
import type { RegistrationStatus } from '@/domain/roster';
import type { SaveResult } from '../../_components/AutoSave';

/**
 * Registration and rosters, from HQ.
 *
 * HQ can edit any roster, locked or not — that is the point of locking one: it
 * stops being something a coach changes and becomes something HQ changes on the
 * record. Withdrawing a team is the director's call, because it takes a team
 * out of a division and changes who plays whom.
 */

const STATUSES = new Set<RegistrationStatus>(['invited', 'registered', 'confirmed', 'withdrawn']);

async function requireHq() {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');
  return staff!;
}

export async function setStatusAction(formData: FormData): Promise<void> {
  const staff = await requireHq();

  const teamId = String(formData.get('teamId') ?? '');
  const raw = String(formData.get('status') ?? '');
  const reason = String(formData.get('reason') ?? '').trim() || null;
  if (!teamId || !STATUSES.has(raw as RegistrationStatus)) return;

  const status = raw as RegistrationStatus;

  // Withdrawing pulls a team out of a division that may already be scheduled.
  if (status === 'withdrawn' && !isDirector(staff)) redirect('/hq/registration?error=director_only');

  await setRegistrationStatus(staff.tournamentId, teamId, status, reason, staff.name, staff.role);

  revalidatePath('/hq/registration');
  revalidatePath(`/hq/registration/${teamId}`);
}

export async function toggleLockAction(formData: FormData): Promise<void> {
  const staff = await requireHq();

  const teamId = String(formData.get('teamId') ?? '');
  const locked = formData.get('locked') === 'true';
  if (!teamId) return;

  await setRosterLock(staff.tournamentId, teamId, locked, staff.name, staff.role);

  revalidatePath('/hq/registration');
  revalidatePath(`/hq/registration/${teamId}`);
}

export async function hqAddPlayerAction(formData: FormData): Promise<void> {
  const staff = await requireHq();

  const teamId = String(formData.get('teamId') ?? '');
  const name = String(formData.get('name') ?? '');
  const jersey = String(formData.get('jersey') ?? '');
  if (!teamId || !name.trim()) return;

  await addPlayer(staff.tournamentId, teamId, name, jersey, staff.name, staff.role);
  revalidatePath(`/hq/registration/${teamId}`);
}

export async function hqPasteRosterAction(formData: FormData): Promise<void> {
  const staff = await requireHq();

  const teamId = String(formData.get('teamId') ?? '');
  const text = String(formData.get('roster') ?? '');
  if (!teamId) return;

  const result = await addPlayersFromText(
    staff.tournamentId,
    teamId,
    text,
    staff.name,
    staff.role,
  );

  revalidatePath(`/hq/registration/${teamId}`);
  if (!result.ok) redirect(`/hq/registration/${teamId}?error=unreadable`);
}

export async function hqRemovePlayerAction(formData: FormData): Promise<void> {
  const staff = await requireHq();

  const playerId = String(formData.get('playerId') ?? '');
  const teamId = String(formData.get('teamId') ?? '');
  if (!playerId) return;

  await removePlayer(staff.tournamentId, playerId, staff.name, staff.role);
  revalidatePath(`/hq/registration/${teamId}`);
}

export async function hqSavePlayer(
  playerId: string,
  field: string,
  value: string,
): Promise<SaveResult> {
  const staff = await currentStaff();
  if (!canAccessHq(staff) || !staff) return { ok: false, error: 'Not signed in.' };

  const result = await savePlayerField(staff.tournamentId, playerId, field, value);
  return result.ok ? { ok: true } : { ok: false, error: result.error ?? 'That could not be saved.' };
}
