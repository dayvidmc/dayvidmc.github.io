'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { transaction } from '@/db/client';
import { currentStaff, isDirector } from '@/server/auth';
import { materialiseBracket, publishBracket } from '@/server/brackets';
import { recordEventIn } from '@/server/events';

/**
 * Bracket overrides (§5.6): "manual override on every slot — the director gets
 * final say."
 *
 * Pinning writes the team onto the game *and* marks the slot overridden, so
 * winner propagation and re-seeding both skip it afterwards. Without that flag
 * the next approved score would quietly undo the director's decision, which is
 * worse than having no automation at all.
 */

async function requireDirector() {
  const staff = await currentStaff();
  if (!staff) redirect('/signin');
  if (!isDirector(staff)) redirect('/hq?error=director_only');
  return staff;
}

export async function pinSlot(formData: FormData): Promise<void> {
  const staff = await requireDirector();

  const divisionId = String(formData.get('divisionId') ?? '');
  const gameId = String(formData.get('gameId') ?? '');
  const side = formData.get('side') === 'away' ? 'away' : 'home';
  const teamId = String(formData.get('teamId') ?? '');
  if (!divisionId || !gameId || !teamId) return;

  await transaction(async (client) => {
    // Guard on the tournament so a crafted form cannot reach another year.
    const game = await client.query(
      'SELECT id FROM game WHERE id = $1 AND tournament_id = $2',
      [gameId, staff.tournamentId],
    );
    if (game.rowCount === 0) return;

    // The slot's rule (seed, winner-of, loser-of) is left exactly as it was.
    // Only the pin is added on top. That is what makes unpinning able to give
    // the slot back to the bracket instead of leaving a hole.
    await client.query(
      `INSERT INTO bracket_slot (game_id, side, kind, team_id, overridden, overridden_by, overridden_at)
       VALUES ($1, $2, 'team', $3, true, $4, now())
       ON CONFLICT (game_id, side) DO UPDATE SET
         team_id = EXCLUDED.team_id,
         overridden = true, overridden_by = EXCLUDED.overridden_by, overridden_at = now()`,
      [gameId, side, teamId, staff.name],
    );

    // Clearing the slot label too: the team is on the row now, so there is
    // nothing left for a screen to say about where they came from.
    await client.query(
      `UPDATE game
          SET ${side === 'home' ? 'home_team_id' : 'away_team_id'} = $2,
              ${side === 'home' ? 'home_slot_label' : 'away_slot_label'} = NULL,
              updated_at = now()
        WHERE id = $1`,
      [gameId, teamId],
    );

    await recordEventIn(client, {
      tournamentId: staff.tournamentId,
      actor: staff.name,
      actorRole: staff.role,
      kind: 'schedule.game_updated',
      subjectType: 'game',
      subjectId: gameId,
      payload: { bracketSlotPinned: side, teamId },
    });
  });

  await materialiseBracket(staff.tournamentId, divisionId);
  revalidatePath(`/hq/bracket/${divisionId}`);
  revalidatePath(`/bracket/${divisionId}`);
}

/**
 * Release a slot back to whatever it was derived from.
 *
 * Because pinning left the underlying rule in place, this really does hand the
 * slot back: a seed slot goes back to reading the standings, a winner slot goes
 * back to waiting on its semifinal. A slot that had no rule to begin with —
 * pinned into an empty side — falls back to "To be decided", which is honest.
 */
export async function unpinSlot(formData: FormData): Promise<void> {
  const staff = await requireDirector();

  const divisionId = String(formData.get('divisionId') ?? '');
  const gameId = String(formData.get('gameId') ?? '');
  const side = formData.get('side') === 'away' ? 'away' : 'home';
  if (!divisionId || !gameId) return;

  await transaction(async (client) => {
    const updated = await client.query(
      `UPDATE bracket_slot
          SET overridden = false, overridden_by = NULL, overridden_at = NULL,
              -- A rule-bearing slot keeps its rule and drops the pinned team;
              -- a plain 'team' slot has nothing else to fall back on.
              team_id = CASE WHEN kind = 'team' THEN team_id ELSE NULL END
        WHERE game_id = $1 AND side = $2
          AND EXISTS (SELECT 1 FROM game WHERE id = $1 AND tournament_id = $3)`,
      [gameId, side, staff.tournamentId],
    );
    if (updated.rowCount === 0) return;

    await recordEventIn(client, {
      tournamentId: staff.tournamentId,
      actor: staff.name,
      actorRole: staff.role,
      kind: 'schedule.game_updated',
      subjectType: 'game',
      subjectId: gameId,
      payload: { bracketSlotUnpinned: side },
    });
  });

  // Hand the game row back to the bracket: whatever the rule now resolves to
  // (a seed, a winner, or nothing yet) replaces the team the director had put
  // there by hand.
  await materialiseBracket(staff.tournamentId, divisionId);
  revalidatePath(`/hq/bracket/${divisionId}`);
  revalidatePath(`/bracket/${divisionId}`);
}

export async function publishBracketAction(formData: FormData): Promise<void> {
  const staff = await requireDirector();
  const divisionId = String(formData.get('divisionId') ?? '');
  if (!divisionId) return;

  await publishBracket(staff.tournamentId, divisionId, staff.name, staff.role);

  revalidatePath(`/hq/bracket/${divisionId}`);
  revalidatePath(`/bracket/${divisionId}`);
  revalidatePath('/bracket');
}
