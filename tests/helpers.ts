import type { CompletedGame, Game, GameType } from "../src/domain/types";

let seq = 0;

export interface GameSpec {
  home: string;
  away: string;
  homeRuns: number;
  awayRuns: number;
  id?: string;
  date?: string;
  startTime?: number;
  diamond?: string;
  division?: string;
  pool?: string | null;
  type?: GameType;
  completedInnings?: number;
  forfeitBy?: CompletedGame["score"]["forfeitBy"];
}

/** Build a completed round robin game with sensible defaults. */
export function game(spec: GameSpec): CompletedGame {
  const id = spec.id ?? `G${++seq}`;
  const g: Game = {
    id,
    tournamentId: "T2027",
    divisionId: spec.division ?? "major-a",
    pool: spec.pool ?? "A",
    date: spec.date ?? "2027-07-23",
    startTime: spec.startTime ?? 10 * 60 + 30,
    diamond: spec.diamond ?? "Deevy Pines 1",
    homeTeamId: spec.home,
    awayTeamId: spec.away,
    type: spec.type ?? "round_robin",
  };
  return {
    game: g,
    score: {
      gameId: id,
      homeRuns: spec.homeRuns,
      awayRuns: spec.awayRuns,
      completedInnings: spec.completedInnings ?? 6,
      forfeitBy: spec.forfeitBy ?? null,
    },
  };
}

/** Shorthand for a batch of games. */
export function games(...specs: GameSpec[]): CompletedGame[] {
  return specs.map(game);
}
