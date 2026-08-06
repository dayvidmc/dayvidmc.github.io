import { randomBytes } from 'node:crypto';
import { query, queryOne } from '@/db/client';
import { recordEvent } from './events';
import { draw, seedFrom, verify, type Candidate } from '@/domain/goldGlove';

/**
 * The Gold Glove, drawn at opening ceremonies.
 *
 * One player from every registered roster, on the Saturday morning, with the
 * Tokessy family there. The prize carries their name, which is why this is
 * recorded rather than done in somebody's head — a draw whose pool size and
 * seed are written down can be shown to have been straight, and one that
 * cannot is one somebody can doubt out loud in front of a family.
 *
 * Draws are append-only. Redrawing until a nicer name comes up is the failure
 * being guarded against, and the defence is that every draw stays on the
 * record rather than a rule nobody can check.
 */

export async function candidates(tournamentId: string): Promise<Candidate[]> {
  return query<Candidate>(
    `SELECT p.id AS "playerId", p.name AS "playerName",
            t.name AS "teamName", d.name AS "divisionName"
       FROM player p
       JOIN team t ON t.id = p.team_id
       JOIN division d ON d.id = t.division_id
      WHERE t.tournament_id = $1
        AND t.registration_status <> 'withdrawn'
        -- An affiliate is called up for the weekend from somebody else's team.
        -- They are playing, so they are in the hat.
      ORDER BY p.id`,
    [tournamentId],
  );
}

export interface DrawRow {
  id: string;
  playerId: string | null;
  playerName: string;
  teamName: string;
  poolSize: number;
  seed: string;
  drawnAt: Date;
  drawnBy: string;
  notes: string | null;
}

export async function draws(tournamentId: string): Promise<DrawRow[]> {
  const rows = await query<{
    id: string;
    player_id: string | null;
    player_name: string;
    team_name: string;
    pool_size: number;
    seed: string;
    drawn_at: Date;
    drawn_by: string;
    notes: string | null;
  }>(
    `SELECT id, player_id, player_name, team_name, pool_size, seed, drawn_at, drawn_by, notes
       FROM gold_glove_draw WHERE tournament_id = $1 ORDER BY drawn_at DESC`,
    [tournamentId],
  );

  return rows.map((row) => ({
    id: row.id,
    playerId: row.player_id,
    playerName: row.player_name,
    teamName: row.team_name,
    poolSize: row.pool_size,
    seed: row.seed,
    drawnAt: row.drawn_at,
    drawnBy: row.drawn_by,
    notes: row.notes,
  }));
}

/**
 * Draw the Gold Glove.
 *
 * **A second draw is refused unless somebody says why.** The record is
 * append-only so a draw cannot be erased, and the screen hides the button once
 * one exists — but neither of those stops a second draw happening. A double-tap
 * on a bad connection, a stale tab, a replayed form post: any of them used to
 * append a second winner, and then the tournament has two names for one trophy
 * and nothing in the system says which is real.
 *
 * There are real reasons to draw again — a winner who declines, a player found
 * to have been ineligible — so this is not forbidden, it is made deliberate.
 * The reason is stored on the row, so the history reads as a decision somebody
 * made rather than a button somebody pressed twice.
 */
export async function runDraw(
  tournamentId: string,
  actor: string,
  actorRole: string,
  /** Required to draw again once a draw exists. */
  redrawReason?: string,
): Promise<{ ok: boolean; error?: string; winner?: string }> {
  const pool = await candidates(tournamentId);
  if (pool.length === 0) return { ok: false, error: 'empty_pool' };

  const reason = (redrawReason ?? '').trim();
  const existing = await query<{ player_name: string }>(
    'SELECT player_name FROM gold_glove_draw WHERE tournament_id = $1 LIMIT 1',
    [tournamentId],
  );
  if (existing.length > 0 && reason.length < 4) {
    return { ok: false, error: 'already_drawn' };
  }

  const result = draw(pool, seedFrom(randomBytes(16)));
  if (!result.ok) return { ok: false, error: result.error };

  await query(
    `INSERT INTO gold_glove_draw
       (tournament_id, player_id, player_name, team_name, pool_size, seed, drawn_by, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      tournamentId,
      result.draw.winner.playerId,
      result.draw.winner.playerName,
      result.draw.winner.teamName,
      result.draw.poolSize,
      result.draw.seed,
      actor,
      existing.length > 0 ? reason.slice(0, 500) : null,
    ],
  );

  await recordEvent({
    tournamentId,
    actor,
    actorRole,
    kind: 'gold_glove.drawn',
    subjectType: 'player',
    subjectId: result.draw.winner.playerId,
    payload: { name: result.draw.winner.playerName, poolSize: result.draw.poolSize },
  });

  return { ok: true, winner: result.draw.winner.playerName };
}

/** Re-run a recorded draw against the rosters as they are now. */
export async function checkDraw(
  tournamentId: string,
  id: string,
): Promise<{ ok: boolean; reason?: string }> {
  const row = await queryOne<{ player_id: string | null; pool_size: number; seed: string }>(
    'SELECT player_id, pool_size, seed FROM gold_glove_draw WHERE id = $1 AND tournament_id = $2',
    [id, tournamentId],
  );
  if (!row) return { ok: false, reason: 'No such draw.' };

  return verify(await candidates(tournamentId), {
    playerId: row.player_id,
    poolSize: row.pool_size,
    seed: row.seed,
  });
}
