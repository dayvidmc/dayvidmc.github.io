'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { cookies, headers } from 'next/headers';
import { queryOne } from '@/db/client';
import { homeFor } from '@/domain/navigation';
import {
  canAccessHq,
  checkPinAttempt,
  currentStaff,
  encodeSession,
  isDirector,
  newSession,
  sessionCookie,
  type StaffRole,
} from '@/server/auth';
import {
  approveScore,
  assignUnmatchedMessage,
  currentTournament,
  dismissUnmatchedMessage,
  recordProposal,
  setDispute,
} from '@/server/repo';
import { recordEvent } from '@/server/events';
import { importSchedule } from '@/domain/schedule/import';
import { applySchedule } from '@/server/scheduleStore';
import { parseDivisionRules } from '@/domain/divisionRules';
import { listDivisions } from '@/server/repo';

/**
 * Server actions for the HQ screens.
 *
 * These are plain form posts rather than client-side fetches on purpose: they
 * work with no JavaScript, on a bad connection, on a five-year-old phone at a
 * diamond with one bar. "Fail safe, not broken" applies to the browser too.
 */

async function requireHq() {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');
  return staff!;
}

// --- Sign in ----------------------------------------------------------------

export async function signIn(formData: FormData): Promise<void> {
  const staffId = String(formData.get('staffId') ?? '');
  const pin = String(formData.get('pin') ?? '');

  const staff = await queryOne<{
    id: string;
    name: string;
    role: StaffRole;
    tournament_id: string;
    pin_hash: string;
    failed_attempts: number;
    locked_until: Date | null;
  }>(
    `SELECT id, name, role, tournament_id, pin_hash, failed_attempts, locked_until
       FROM staff_member WHERE id = $1 AND active`,
    [staffId],
  );

  // An unknown id gets the same generic answer as a wrong PIN, so the form
  // cannot be used to enumerate which tiles are real.
  if (!staff) redirect('/signin?error=1');

  const headerBag = await headers();
  const remoteHint =
    headerBag.get('x-forwarded-for')?.split(',')[0]?.trim() ?? headerBag.get('x-real-ip') ?? null;

  const attempt = await checkPinAttempt(staff, pin, remoteHint);

  if (!attempt.ok) {
    const params = new URLSearchParams({ staff: staffId, error: '1' });
    if (attempt.lockedForMinutes) params.set('locked', String(attempt.lockedForMinutes));
    else if (attempt.attemptsLeft !== undefined) params.set('left', String(attempt.attemptsLeft));
    redirect(`/signin?${params.toString()}`);
  }

  const store = await cookies();
  store.set(sessionCookie.name, encodeSession(newSession(staff)), sessionCookie.options);

  await recordEvent({
    tournamentId: staff.tournament_id,
    actor: staff.name,
    actorRole: staff.role,
    kind: 'staff.signed_in',
    subjectType: 'staff_member',
    subjectId: staff.id,
  });

  // The first screen of their actual job. Four of the seven roles used to land
  // on the public home page — signed in, with nothing to show for it and no
  // link to anything they were allowed to open.
  redirect(homeFor(staff.role));
}

export async function signOut(): Promise<void> {
  const store = await cookies();
  store.delete(sessionCookie.name);
  redirect('/signin');
}

// --- Score approval (§5.3) --------------------------------------------------

export async function approve(formData: FormData): Promise<void> {
  const staff = await requireHq();

  const gameId = String(formData.get('gameId') ?? '');
  const scoreReportId = String(formData.get('scoreReportId') ?? '') || null;
  const homeRuns = Number(formData.get('homeRuns'));
  const awayRuns = Number(formData.get('awayRuns'));
  const resultKind = formData.get('resultKind') === 'forfeit' ? 'forfeit' : 'played';
  const forfeitedByTeamId = String(formData.get('forfeitedByTeamId') ?? '') || null;

  if (!gameId) return;

  if (resultKind === 'played' && (!Number.isInteger(homeRuns) || !Number.isInteger(awayRuns) || homeRuns < 0 || awayRuns < 0)) {
    // The form would have to be tampered with to get here; do nothing rather
    // than write a nonsense standing.
    return;
  }

  if (resultKind === 'forfeit' && !forfeitedByTeamId) return;

  await approveScore({
    tournamentId: staff.tournamentId,
    gameId,
    scoreReportId,
    homeRuns: resultKind === 'forfeit' ? Number(formData.get('homeRuns') ?? 0) || 0 : homeRuns,
    awayRuns: resultKind === 'forfeit' ? Number(formData.get('awayRuns') ?? 0) || 0 : awayRuns,
    resultKind,
    forfeitedByTeamId,
    approvedBy: staff.name,
    approverRole: staff.role,
  });

  revalidatePath('/hq');
  revalidatePath('/hq/queue');
}

/** Path 3: a human at HQ types in a score that was phoned in (§5.2). */
export async function enterScoreByPhone(formData: FormData): Promise<void> {
  const staff = await requireHq();

  const gameId = String(formData.get('gameId') ?? '');
  const homeRuns = Number(formData.get('homeRuns'));
  const awayRuns = Number(formData.get('awayRuns'));
  const calledInBy = String(formData.get('calledInBy') ?? '').trim();

  if (!gameId || !Number.isInteger(homeRuns) || !Number.isInteger(awayRuns)) return;
  if (homeRuns < 0 || awayRuns < 0) return;

  await recordProposal({
    tournamentId: staff.tournamentId,
    gameId,
    source: 'hq_phone',
    reportedBy: calledInBy || staff.name,
    rawText: null,
    homeRuns,
    awayRuns,
    // Typed by a person who heard it on the phone: no parsing uncertainty.
    confidence: 1,
  });

  revalidatePath('/hq/queue');
  revalidatePath('/hq');
}

// --- Texts nobody could place (§5.2, fallback chain) ------------------------

/**
 * Attach a stray text to a game. This creates a proposal in the normal queue
 * rather than approving anything — a score becomes real in exactly one place.
 */
export async function assignUnmatched(formData: FormData): Promise<void> {
  const staff = await requireHq();

  const messageId = String(formData.get('messageId') ?? '');
  const gameId = String(formData.get('gameId') ?? '');
  const homeRuns = Number(formData.get('homeRuns'));
  const awayRuns = Number(formData.get('awayRuns'));

  if (!messageId || !gameId) return;
  if (!Number.isInteger(homeRuns) || !Number.isInteger(awayRuns)) return;
  if (homeRuns < 0 || awayRuns < 0 || homeRuns > 99 || awayRuns > 99) return;

  await assignUnmatchedMessage({
    tournamentId: staff.tournamentId,
    messageId,
    gameId,
    homeRuns,
    awayRuns,
    assignedBy: staff.name,
    assignerRole: staff.role,
  });

  revalidatePath('/hq/unmatched');
  revalidatePath('/hq/queue');
  revalidatePath('/hq');
}

export async function dismissUnmatched(formData: FormData): Promise<void> {
  const staff = await requireHq();

  const messageId = String(formData.get('messageId') ?? '');
  const reason = String(formData.get('reason') ?? '').trim() || null;
  if (!messageId) return;

  await dismissUnmatchedMessage({
    tournamentId: staff.tournamentId,
    messageId,
    reason,
    dismissedBy: staff.name,
    dismisserRole: staff.role,
  });

  revalidatePath('/hq/unmatched');
  revalidatePath('/hq');
}

export async function flagDispute(formData: FormData): Promise<void> {
  const staff = await requireHq();
  const gameId = String(formData.get('gameId') ?? '');
  const note = String(formData.get('note') ?? '').trim() || null;
  const clearing = formData.get('clear') === '1';

  if (!gameId) return;

  await setDispute(staff.tournamentId, gameId, !clearing, note, staff.name, staff.role);
  revalidatePath('/hq');
}

// --- Schedule import (§5.1) -------------------------------------------------

export interface ImportPreview {
  ok: boolean;
  message: string;
  issues: { severity: string; message: string }[];
  gameCount: number;
}

export async function importScheduleAction(formData: FormData): Promise<void> {
  const staff = await requireHq();
  if (!isDirector(staff)) {
    // HQ staff read the board; only the director reshapes the schedule.
    redirect('/hq?error=director_only');
  }

  const csv = String(formData.get('csv') ?? '');
  const cancelMissing = formData.get('cancelMissing') === '1';

  const tournament = await currentTournament();
  if (!tournament || csv.trim() === '') redirect('/hq/import?error=empty');

  const divisions = await listDivisions(tournament.id);
  const rulesByDivision = Object.fromEntries(
    divisions.map((d) => [d.name, parseDivisionRules(d.rules).rules]),
  );

  const result = importSchedule(csv, {
    rulesByDivision,
    tournamentHours: {
      start: tournament.day_start_time.slice(0, 5),
      end: tournament.day_end_time.slice(0, 5),
    },
  });

  if (!result.importable) {
    const encoded = encodeURIComponent(
      JSON.stringify(result.issues.slice(0, 20).map((i) => ({ s: i.severity, m: i.message }))),
    );
    redirect(`/hq/import?issues=${encoded}`);
  }

  const applied = await applySchedule(tournament.id, result.games, staff.name, staff.role, {
    cancelMissing,
  });

  revalidatePath('/hq');
  revalidatePath('/');
  redirect(
    `/hq/import?ok=${applied.created}&updated=${applied.updated}&cancelled=${applied.cancelled}` +
      `&warnings=${result.warningCount}`,
  );
}
