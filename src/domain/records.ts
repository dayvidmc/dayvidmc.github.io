import {
  POINTS_LOSS,
  POINTS_TIE,
  POINTS_WIN,
  RUN_DIFFERENTIAL_CAP,
  type GameResult,
  type TeamRecord,
} from './types';

/** Clamp a single game's margin to ±10 for tiebreak purposes (§5.5). */
export function cappedMargin(runsFor: number, runsAgainst: number): number {
  const raw = runsFor - runsAgainst;
  if (raw > RUN_DIFFERENTIAL_CAP) return RUN_DIFFERENTIAL_CAP;
  if (raw < -RUN_DIFFERENTIAL_CAP) return -RUN_DIFFERENTIAL_CAP;
  return raw;
}

function emptyRecord(teamId: string): TeamRecord {
  return {
    teamId,
    gamesPlayed: 0,
    wins: 0,
    losses: 0,
    ties: 0,
    points: 0,
    runsFor: 0,
    runsAllowed: 0,
    runDifferentialCapped: 0,
    runDifferentialRaw: 0,
    forfeits: 0,
  };
}

/**
 * Build round robin records for a set of teams.
 *
 * Only `round_robin` games are counted — playoff results never move standings.
 *
 * ASSUMPTION (needs director confirmation, see DECISIONS.md): a forfeited game
 * counts toward wins/losses/points and games played, but its runs are excluded
 * from `runsFor`, `runsAllowed` and both differentials. A forfeit is recorded
 * with a nominal score, and letting a nominal score decide a "fewest runs
 * allowed" tiebreak between two other teams would be indefensible in a
 * dispute. The forfeiting team is separately barred from winning any tiebreak.
 */
export function buildRecords(teamIds: readonly string[], games: readonly GameResult[]): Map<string, TeamRecord> {
  const records = new Map<string, TeamRecord>();
  for (const teamId of teamIds) records.set(teamId, emptyRecord(teamId));

  for (const game of games) {
    if (game.gameType !== 'round_robin') continue;

    const home = records.get(game.homeTeamId);
    const away = records.get(game.awayTeamId);
    // A game referencing a team outside this pool is not this pool's business.
    if (!home || !away) continue;

    const isForfeit = game.resultKind === 'forfeit';

    home.gamesPlayed += 1;
    away.gamesPlayed += 1;

    if (!isForfeit) {
      home.runsFor += game.homeRuns;
      home.runsAllowed += game.awayRuns;
      away.runsFor += game.awayRuns;
      away.runsAllowed += game.homeRuns;

      home.runDifferentialRaw += game.homeRuns - game.awayRuns;
      away.runDifferentialRaw += game.awayRuns - game.homeRuns;

      home.runDifferentialCapped += cappedMargin(game.homeRuns, game.awayRuns);
      away.runDifferentialCapped += cappedMargin(game.awayRuns, game.homeRuns);
    }

    if (isForfeit && game.forfeitedBy) {
      const loser = records.get(game.forfeitedBy);
      if (loser) loser.forfeits += 1;
    }

    if (game.homeRuns > game.awayRuns) {
      home.wins += 1;
      home.points += POINTS_WIN;
      away.losses += 1;
      away.points += POINTS_LOSS;
    } else if (game.awayRuns > game.homeRuns) {
      away.wins += 1;
      away.points += POINTS_WIN;
      home.losses += 1;
      home.points += POINTS_LOSS;
    } else {
      home.ties += 1;
      home.points += POINTS_TIE;
      away.ties += 1;
      away.points += POINTS_TIE;
    }
  }

  return records;
}

/**
 * Per-team completed round robin game counts (§5.8).
 *
 * This is a financial record, not a statistic: the rainout refund tier is
 * decided by how many games a team actually played (0 games / 1 game / 2+).
 * Kept as its own function so the refund calculation in Module E consumes an
 * explicit, exportable number rather than reading it off a standings table.
 *
 * ASSUMPTION: a forfeited game counts as a game played for refund purposes —
 * the team was at the tournament and a result was recorded. Confirm with the
 * treasurer before the policy is applied to real money.
 */
export function completedGameCounts(
  teamIds: readonly string[],
  games: readonly GameResult[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const teamId of teamIds) counts.set(teamId, 0);

  for (const game of games) {
    if (game.gameType !== 'round_robin') continue;
    for (const teamId of [game.homeTeamId, game.awayTeamId]) {
      const current = counts.get(teamId);
      if (current !== undefined) counts.set(teamId, current + 1);
    }
  }

  return counts;
}
