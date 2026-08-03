'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { queryOne } from '@/db/client';
import { recordProposal } from '@/server/repo';
import { umpireByAccessToken } from '@/server/umpires';

/**
 * The umpire reports the score.
 *
 * This is a fourth intake path (§5.2 has three), and probably the best one. The
 * umpire is at the game, is neutral, and has already signed the sheet. Path 1
 * routes around them to a diamond volunteer who may be a parent who arrived in
 * the third inning; path 2 is a coach, who is not neutral; path 3 is a
 * telephone game.
 *
 * It still goes to the approval queue like every other path. The umpire being
 * a better source is not a reason to skip the second pair of eyes — §5.2 is
 * explicit that one person's typo should not decide who plays on Sunday.
 *
 * The token is the authentication. It is not guessable, it is per-umpire, and
 * it is checked against the game before anything is written: an umpire can only
 * report on a game they are actually assigned to.
 */
export async function reportScore(formData: FormData): Promise<void> {
  const token = String(formData.get('token') ?? '');
  const gameId = String(formData.get('gameId') ?? '');

  const umpire = await umpireByAccessToken(token);
  if (!umpire) redirect('/');

  // The assignment is the authorisation. Without this check, anyone holding
  // any umpire's link could file a score against any game in the tournament.
  const assigned = await queryOne<{ game_id: string }>(
    `SELECT gu.game_id FROM game_umpire gu
       JOIN game g ON g.id = gu.game_id
      WHERE gu.game_id = $1 AND gu.umpire_id = $2 AND g.tournament_id = $3`,
    [gameId, umpire.id, umpire.tournament_id],
  );
  if (!assigned) redirect(`/umpire/${token}?error=not_yours`);

  const homeRuns = Number(formData.get('homeRuns'));
  const awayRuns = Number(formData.get('awayRuns'));
  if (!Number.isInteger(homeRuns) || !Number.isInteger(awayRuns) || homeRuns < 0 || awayRuns < 0) {
    redirect(`/umpire/${token}?error=bad_score`);
  }

  await recordProposal({
    tournamentId: umpire.tournament_id,
    gameId,
    source: 'umpire',
    reportedBy: umpire.name,
    rawText: null,
    homeRuns,
    awayRuns,
    // Not a parser guess — a person who was standing there typed it. The queue
    // shows it as filed rather than as something to squint at.
    confidence: 1,
  });

  revalidatePath(`/umpire/${token}`);
  revalidatePath('/hq/queue');
  redirect(`/umpire/${token}?filed=${gameId}`);
}
