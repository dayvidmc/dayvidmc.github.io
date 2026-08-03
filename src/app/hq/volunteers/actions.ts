'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { canAccessHq, currentStaff } from '@/server/auth';
import {
  addVolunteer,
  assign,
  createShift,
  deleteShift,
  importVolunteers,
  markNoShow,
  saveVolunteerField,
  setVolunteerStatus,
  unassign,
} from '@/server/volunteers';
import type { ShiftRole } from '@/domain/volunteers';
import { localWallClock } from '@/domain/time';
import type { SaveResult } from '../../_components/AutoSave';

const ROLES: ShiftRole[] = ['diamond', 'canteen', 'bbq', 'auction', 'gate', 'setup', 'floating'];

async function requireHq() {
  const staff = await currentStaff();
  if (!canAccessHq(staff) && staff?.role !== 'volunteer_coordinator') redirect('/signin');
  return staff!;
}

function text(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

export async function addVolunteerAction(formData: FormData): Promise<void> {
  const staff = await requireHq();

  const result = await addVolunteer(
    staff.tournamentId,
    {
      name: text(formData, 'name'),
      phone: text(formData, 'phone'),
      email: text(formData, 'email'),
      canDo: text(formData, 'canDo'),
      notes: text(formData, 'notes'),
    },
    staff.name,
    staff.role,
  );

  if (!result.ok) redirect(`/hq/volunteers/people?error=${result.error}`);
  revalidatePath('/hq/volunteers/people');
  redirect('/hq/volunteers/people?saved=1');
}

/**
 * The coordinator's spreadsheet, pasted.
 *
 * She holds the whole list already, so the alternative to this is her not
 * using the system at all. Anything the parser cannot read comes back on the
 * screen rather than being dropped — a hundred-name list that silently imports
 * ninety-four is worse than one that refuses, because nobody counts.
 */
export async function importAction(formData: FormData): Promise<void> {
  const staff = await requireHq();

  const outcome = await importVolunteers(
    staff.tournamentId,
    text(formData, 'people'),
    staff.name,
    staff.role,
  );

  const params = new URLSearchParams({ added: String(outcome.added) });
  if (outcome.alreadyThere.length) params.set('already', outcome.alreadyThere.slice(0, 8).join(', '));
  if (outcome.unreadable.length) params.set('unreadable', String(outcome.unreadable.length));
  if (outcome.duplicates.length) params.set('dupes', outcome.duplicates.slice(0, 6).join(', '));

  revalidatePath('/hq/volunteers/people');
  redirect(`/hq/volunteers/people?${params}`);
}

export async function saveVolunteer(
  volunteerId: string,
  field: string,
  value: string,
): Promise<SaveResult> {
  const staff = await requireHq();
  const result = await saveVolunteerField(staff.tournamentId, volunteerId, field, value);
  if (!result.ok) return { ok: false, error: result.error ?? 'That did not save.' };

  revalidatePath('/hq/volunteers/people');
  return { ok: true };
}

export async function setStatusAction(formData: FormData): Promise<void> {
  const staff = await requireHq();
  const id = text(formData, 'id');
  const status = text(formData, 'status');
  if (!id || !['available', 'unavailable', 'withdrawn'].includes(status)) return;

  await setVolunteerStatus(staff.tournamentId, id, status as never, staff.name, staff.role);
  revalidatePath('/hq/volunteers/people');
  redirect('/hq/volunteers/people?saved=1');
}

export async function createShiftAction(formData: FormData): Promise<void> {
  const staff = await requireHq();

  const role = text(formData, 'role') as ShiftRole;
  if (!ROLES.includes(role)) redirect('/hq/volunteers/shifts?error=bad_role');

  const date = text(formData, 'date');
  const startsAt = localWallClock(date, text(formData, 'startTime') || '09:00');
  const endsAt = localWallClock(date, text(formData, 'endTime') || '13:00');
  if (!startsAt || !endsAt) redirect('/hq/volunteers/shifts?error=bad_time');

  const needed = Number(text(formData, 'needed') || '1');
  if (!Number.isInteger(needed) || needed < 1 || needed > 50) {
    redirect('/hq/volunteers/shifts?error=bad_needed');
  }

  const result = await createShift(
    staff.tournamentId,
    {
      role,
      diamondId: text(formData, 'diamondId') || null,
      locationId: text(formData, 'locationId') || null,
      place: text(formData, 'place'),
      startsAt: startsAt!,
      endsAt: endsAt!,
      needed,
      notes: text(formData, 'notes'),
    },
    staff.name,
    staff.role,
  );

  if (!result.ok) redirect(`/hq/volunteers/shifts?error=${result.error}`);
  revalidatePath('/hq/volunteers/shifts');
  revalidatePath('/hq/volunteers');
  redirect('/hq/volunteers/shifts?saved=1');
}

export async function deleteShiftAction(formData: FormData): Promise<void> {
  const staff = await requireHq();
  const id = text(formData, 'id');
  if (!id) return;

  await deleteShift(staff.tournamentId, id);
  revalidatePath('/hq/volunteers/shifts');
  revalidatePath('/hq/volunteers');
  redirect('/hq/volunteers/shifts?saved=1');
}

export async function assignAction(formData: FormData): Promise<void> {
  const staff = await requireHq();
  const shiftId = text(formData, 'shiftId');
  const volunteerId = text(formData, 'volunteerId');
  if (!shiftId || !volunteerId) return;

  const result = await assign(staff.tournamentId, shiftId, volunteerId, staff.name, staff.role);

  revalidatePath('/hq/volunteers');
  if (!result.ok) {
    const detail = result.clashWith ? `&where=${encodeURIComponent(result.clashWith)}` : '';
    redirect(`/hq/volunteers?error=${result.error}${detail}`);
  }
  redirect('/hq/volunteers?assigned=1');
}

export async function unassignAction(formData: FormData): Promise<void> {
  const staff = await requireHq();
  await unassign(staff.tournamentId, text(formData, 'shiftId'), text(formData, 'volunteerId'));
  revalidatePath('/hq/volunteers');
  redirect('/hq/volunteers?saved=1');
}

export async function noShowAction(formData: FormData): Promise<void> {
  const staff = await requireHq();
  await markNoShow(
    staff.tournamentId,
    text(formData, 'shiftId'),
    text(formData, 'volunteerId'),
    staff.name,
    staff.role,
  );
  revalidatePath('/hq/volunteers');
  redirect('/hq/volunteers?saved=1');
}
