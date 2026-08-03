import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { cookies } from 'next/headers';
import { query, queryOne } from '@/db/client';

/**
 * Access model (§10): tile + PIN for staff, magic links for everyone else, no
 * passwords anywhere.
 *
 * A PIN is a weak secret by design — it is typed one-handed on a phone in the
 * sun. It is protected by being (a) scrypt-hashed rather than stored, (b) rate
 * limited per staff member, and (c) worth very little: the blast radius of a
 * compromised HQ PIN is a wrong score that the append-only event log makes
 * obvious and a director can correct in one tap.
 */

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const SESSION_COOKIE = 'tokessy_staff';
const SESSION_HOURS = 18; // a long tournament day, then sign in again

export type StaffRole =
  | 'director'
  | 'hq'
  | 'volunteer_coordinator'
  | 'auction_lead'
  | 'concession_lead'
  | 'concession_volunteer';

export interface StaffSession {
  staffId: string;
  name: string;
  role: StaffRole;
  tournamentId: string;
  expiresAt: number;
}

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value) throw new Error('SESSION_SECRET is not set.');
  return value;
}

// --- PINs -------------------------------------------------------------------

export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(pin, salt, 32);
  return `scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

/** Wrong PINs allowed before the account rests. */
export const MAX_PIN_ATTEMPTS = 5;
/** How long it rests for. */
export const LOCKOUT_MINUTES = 15;

export interface PinAttemptResult {
  ok: boolean;
  /** Set when the account is locked; minutes remaining, rounded up. */
  lockedForMinutes?: number;
  /** Set on a wrong PIN that did not trigger a lockout. */
  attemptsLeft?: number;
}

/**
 * Check a PIN, counting failures.
 *
 * The lockout is per account rather than per IP: an attacker rotating through
 * IPs still cannot get more than five guesses at any one person, and a
 * volunteer sharing a stadium's wifi is never punished for someone else's
 * mistyping.
 *
 * A locked account is told how long it has left rather than being refused
 * silently. Hiding it would just mean the volunteer keeps trying, and the
 * information is worth less to an attacker than a confused person at HQ costs.
 */
export async function checkPinAttempt(
  staff: { id: string; tournament_id: string; pin_hash: string; failed_attempts: number; locked_until: Date | null },
  pin: string,
  remoteHint: string | null,
): Promise<PinAttemptResult> {
  const now = Date.now();

  if (staff.locked_until && staff.locked_until.getTime() > now) {
    const minutes = Math.ceil((staff.locked_until.getTime() - now) / 60_000);
    await recordAttempt(staff, false, remoteHint);
    return { ok: false, lockedForMinutes: minutes };
  }

  const correct = await verifyPin(pin, staff.pin_hash);
  await recordAttempt(staff, correct, remoteHint);

  if (correct) {
    await query(
      `UPDATE staff_member
          SET failed_attempts = 0, locked_until = NULL, last_signed_in = now()
        WHERE id = $1`,
      [staff.id],
    );
    return { ok: true };
  }

  // A lockout that has expired starts the count again from this failure.
  const expired = staff.locked_until !== null && staff.locked_until.getTime() <= now;
  const attempts = (expired ? 0 : staff.failed_attempts) + 1;

  if (attempts >= MAX_PIN_ATTEMPTS) {
    await query(
      `UPDATE staff_member
          SET failed_attempts = $2, locked_until = now() + ($3 || ' minutes')::interval
        WHERE id = $1`,
      [staff.id, attempts, String(LOCKOUT_MINUTES)],
    );
    return { ok: false, lockedForMinutes: LOCKOUT_MINUTES };
  }

  await query('UPDATE staff_member SET failed_attempts = $2, locked_until = NULL WHERE id = $1', [
    staff.id,
    attempts,
  ]);
  return { ok: false, attemptsLeft: MAX_PIN_ATTEMPTS - attempts };
}

async function recordAttempt(
  staff: { id: string; tournament_id: string },
  succeeded: boolean,
  remoteHint: string | null,
): Promise<void> {
  await query(
    `INSERT INTO sign_in_attempt (tournament_id, staff_id, succeeded, remote_hint)
     VALUES ($1, $2, $3, $4)`,
    [staff.tournament_id, staff.id, succeeded, remoteHint],
  );
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const [scheme, saltPart, hashPart] = stored.split('$');
  if (scheme !== 'scrypt' || !saltPart || !hashPart) return false;

  const expected = Buffer.from(hashPart, 'base64url');
  const derived = await scrypt(pin, Buffer.from(saltPart, 'base64url'), expected.length);
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

// --- Sessions ---------------------------------------------------------------

function sign(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url');
}

export function encodeSession(session: StaffSession): string {
  const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function decodeSession(token: string | undefined): StaffSession | null {
  if (!token) return null;

  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;

  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString()) as StaffSession;
    if (typeof session.expiresAt !== 'number' || session.expiresAt < Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}

export function newSession(
  staff: { id: string; name: string; role: StaffRole; tournament_id: string },
): StaffSession {
  return {
    staffId: staff.id,
    name: staff.name,
    role: staff.role,
    tournamentId: staff.tournament_id,
    expiresAt: Date.now() + SESSION_HOURS * 3_600_000,
  };
}

export const sessionCookie = {
  name: SESSION_COOKIE,
  options: {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_HOURS * 3600,
  },
};

/** Current staff session, or null. */
export async function currentStaff(): Promise<StaffSession | null> {
  const store = await cookies();
  return decodeSession(store.get(SESSION_COOKIE)?.value);
}

/** Roles allowed into the HQ screens. */
export function canAccessHq(session: StaffSession | null): boolean {
  return session?.role === 'director' || session?.role === 'hq';
}

/** Only the director overrides a score that is already approved, or a bracket. */
export function isDirector(session: StaffSession | null): boolean {
  return session?.role === 'director';
}

/**
 * Concession permissions (§8).
 *
 * The split that matters: anyone on a shift can ring up a sale, but only a lead
 * can hand money back or change what things cost. Refunds and price edits are
 * the two ways a till leaks, and they are the two things a fifteen-year-old on
 * their first shift should not be able to do by tapping the wrong button.
 */
export function canSellConcessions(session: StaffSession | null): boolean {
  return (
    session?.role === 'concession_volunteer' ||
    session?.role === 'concession_lead' ||
    session?.role === 'hq' ||
    session?.role === 'director'
  );
}

export function canRefund(session: StaffSession | null): boolean {
  return session?.role === 'concession_lead' || session?.role === 'director';
}

export function canEditMenu(session: StaffSession | null): boolean {
  return session?.role === 'concession_lead' || session?.role === 'director';
}

/** Closing a drawer is a lead's job — it is the moment cash is counted. */
export function canCloseRegister(session: StaffSession | null): boolean {
  return session?.role === 'concession_lead' || session?.role === 'director';
}

// --- Magic links ------------------------------------------------------------

/**
 * One link per team, forwarded to parents once, live all weekend (§5.7). The
 * token is the credential, so it is long and random rather than derived from
 * anything guessable like a team name.
 */
export function newAccessToken(): string {
  return randomBytes(24).toString('base64url');
}

export interface TeamAccess {
  id: string;
  name: string;
  division_id: string;
  division_name: string;
  pool_id: string | null;
  tournament_id: string;
}

export async function teamByAccessToken(token: string): Promise<TeamAccess | null> {
  return queryOne<TeamAccess>(
    `SELECT t.id, t.name, t.division_id, d.name AS division_name, t.pool_id, t.tournament_id
       FROM team t
       JOIN division d ON d.id = t.division_id
      WHERE t.access_token = $1`,
    [token],
  );
}
