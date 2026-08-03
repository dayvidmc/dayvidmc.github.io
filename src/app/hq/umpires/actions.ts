'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { canAccessHq, currentStaff } from '@/server/auth';
import { looksLikeEmail, normalisePhone } from '@/domain/contact';
import {
  addUmpire,
  assignUmpire,
  markNoShow,
  saveUmpireField,
  unassignUmpire,
} from '@/server/umpires';
import type { UmpirePosition } from '@/domain/umpires';
import type { SaveResult } from '../../_components/AutoSave';

/**
 * Umpire roster and crew assignment.
 *
 * The roster fields auto-save, like team contacts, for the same reason: the
 * person entering forty umpires is doing it on a phone between other jobs.
 *
 * Assignment does not auto-save. It is an act of judgement about a person's
 * day, so it stays behind a deliberate tap (`AutoSave.tsx`, rule 2).
 */

const DENIED: SaveResult = { ok: false, error: 'Not signed in.' };

async function requireHq() {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');
  return staff!;
}

const POSITIONS = new Set<UmpirePosition>(['plate', 'base', 'base2', 'base3']);
const asPosition = (raw: FormDataEntryValue | null): UmpirePosition | null => {
  const value = String(raw ?? '');
  return POSITIONS.has(value as UmpirePosition) ? (value as UmpirePosition) : null;
};

export async function addUmpireAction(formData: FormData): Promise<void> {
  const staff = await requireHq();
  const name = String(formData.get('name') ?? '').trim();
  if (!name) return;

  await addUmpire(staff.tournamentId, name, staff.name, staff.role);
  revalidatePath('/hq/umpires');
}

export async function saveUmpire(
  umpireId: string,
  field: string,
  value: string,
): Promise<SaveResult> {
  const staff = await currentStaff();
  if (!canAccessHq(staff) || !staff) return DENIED;

  // Validate before it reaches the database, so the message lands next to the
  // input that caused it rather than as a generic failure.
  if (field === 'phone') {
    const phone = normalisePhone(value);
    if (!phone.ok) return phone;
    const ok = await saveUmpireField(staff.tournamentId, umpireId, 'phone', phone.value ?? '');
    return ok ? { ok: true } : { ok: false, error: 'Umpire not found.' };
  }

  if (field === 'email' && value.trim() && !looksLikeEmail(value.trim())) {
    return { ok: false, error: 'That does not look like an email address.' };
  }

  if (field === 'rate' && value.trim() && !Number.isFinite(Number(value.replace(/[^0-9.]/g, '')))) {
    return { ok: false, error: 'Enter a number, e.g. 40.' };
  }

  const ok = await saveUmpireField(staff.tournamentId, umpireId, field, value);
  if (!ok) return { ok: false, error: 'That could not be saved.' };

  revalidatePath('/hq/umpires');
  return { ok: true };
}

export async function assignUmpireAction(formData: FormData): Promise<void> {
  const staff = await requireHq();

  const gameId = String(formData.get('gameId') ?? '');
  const umpireId = String(formData.get('umpireId') ?? '');
  const position = asPosition(formData.get('position'));
  const back = String(formData.get('back') ?? '');
  if (!gameId || !umpireId || !position) return;

  await assignUmpire(staff.tournamentId, gameId, umpireId, position, staff.name, staff.role);

  revalidatePath(`/hq/game/${gameId}`);
  revalidatePath('/hq/umpires');
  revalidatePath('/hq/umpires/crews');
  if (back) redirect(back);
}

export async function unassignUmpireAction(formData: FormData): Promise<void> {
  const staff = await requireHq();

  const gameId = String(formData.get('gameId') ?? '');
  const position = asPosition(formData.get('position'));
  const back = String(formData.get('back') ?? '');
  if (!gameId || !position) return;

  await unassignUmpire(staff.tournamentId, gameId, position, staff.name, staff.role);

  revalidatePath(`/hq/game/${gameId}`);
  revalidatePath('/hq/umpires/crews');
  if (back) redirect(back);
}

export async function markNoShowAction(formData: FormData): Promise<void> {
  const staff = await requireHq();

  const gameId = String(formData.get('gameId') ?? '');
  const position = asPosition(formData.get('position'));
  const noShow = formData.get('noShow') === 'true';
  const note = String(formData.get('note') ?? '').trim() || null;
  const back = String(formData.get('back') ?? '');
  if (!gameId || !position) return;

  await markNoShow(staff.tournamentId, gameId, position, noShow, note, staff.name, staff.role);

  revalidatePath(`/hq/game/${gameId}`);
  revalidatePath('/hq/umpires');
  if (back) redirect(back);
}
