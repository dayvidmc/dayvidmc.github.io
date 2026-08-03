import { describe, expect, it } from 'vitest';
import { buildRecords, cappedMargin, completedGameCounts } from './records';
import { computeStandings, coinFlipKey, distinctReasoning, poolBalance } from './tiebreak';
import type { GameResult } from './types';

const NAMES: Record<string, string> = {
  A: 'Kanata Major A',
  B: 'Orleans Major A',
  C: 'Nepean Major A',
  D: 'Gloucester Major A',
  E: 'Barrhaven Major A',
};
const name = (id: string) => NAMES[id] ?? id;

let seq = 0;
function g(
  home: string,
  away: string,
  homeRuns: number,
  awayRuns: number,
  extra: Partial<GameResult> = {},
): GameResult {
  seq += 1;
  return {
    gameId: `g${seq}`,
    divisionId: 'major-a',
    poolId: 'pool-1',
    gameType: 'round_robin',
    homeTeamId: home,
    awayTeamId: away,
    homeRuns,
    awayRuns,
    resultKind: 'played',
    forfeitedBy: null,
    ...extra,
  };
}

function standings(teams: string[], games: GameResult[], coinFlips?: Record<string, string[]>) {
  return computeStandings(buildRecords(teams, games), games, name, coinFlips);
}

const order = (rows: ReturnType<typeof standings>) => rows.map((r) => r.record.teamId);

describe('records', () => {
  it('awards 2 for a win, 1 for a tie, 0 for a loss', () => {
    const games = [g('A', 'B', 5, 3), g('A', 'C', 4, 4), g('B', 'C', 1, 7)];
    const records = buildRecords(['A', 'B', 'C'], games);

    expect(records.get('A')).toMatchObject({ wins: 1, ties: 1, losses: 0, points: 3 });
    expect(records.get('B')).toMatchObject({ wins: 0, ties: 0, losses: 2, points: 0 });
    expect(records.get('C')).toMatchObject({ wins: 1, ties: 1, losses: 0, points: 3 });
  });

  it('ignores playoff games', () => {
    const games = [g('A', 'B', 5, 3), g('A', 'B', 9, 0, { gameType: 'playoff' })];
    const records = buildRecords(['A', 'B'], games);
    expect(records.get('A')!.gamesPlayed).toBe(1);
    expect(records.get('A')!.runsFor).toBe(5);
  });

  it('caps each game margin at 10 runs for the tiebreak differential', () => {
    expect(cappedMargin(25, 0)).toBe(10);
    expect(cappedMargin(0, 25)).toBe(-10);
    expect(cappedMargin(5, 3)).toBe(2);

    const records = buildRecords(['A', 'B'], [g('A', 'B', 30, 2)]);
    expect(records.get('A')!.runDifferentialRaw).toBe(28);
    expect(records.get('A')!.runDifferentialCapped).toBe(10);
    expect(records.get('B')!.runDifferentialCapped).toBe(-10);
  });

  it('counts a forfeit for the win but excludes its runs from tiebreak figures', () => {
    const games = [g('A', 'B', 7, 0, { resultKind: 'forfeit', forfeitedBy: 'B' })];
    const records = buildRecords(['A', 'B'], games);

    expect(records.get('A')).toMatchObject({ wins: 1, points: 2, runsFor: 0, runsAllowed: 0 });
    expect(records.get('B')).toMatchObject({ losses: 1, points: 0, forfeits: 1, runsAllowed: 0 });
    // Still a game played — this feeds the refund tier.
    expect(records.get('A')!.gamesPlayed).toBe(1);
  });

  it('tracks completed game counts for the refund tiers', () => {
    const games = [g('A', 'B', 5, 3), g('A', 'C', 2, 1), g('B', 'C', 0, 0)];
    const counts = completedGameCounts(['A', 'B', 'C', 'D'], games);

    expect(counts.get('A')).toBe(2);
    expect(counts.get('B')).toBe(2);
    expect(counts.get('C')).toBe(2);
    expect(counts.get('D')).toBe(0); // rained out entirely — full refund tier
  });
});

describe('standings — no tie', () => {
  it('orders by points and records no tiebreak reasoning', () => {
    const games = [g('A', 'B', 5, 3), g('A', 'C', 4, 2), g('B', 'C', 6, 1)];
    const rows = standings(['A', 'B', 'C'], games);

    expect(order(rows)).toEqual(['A', 'B', 'C']);
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(rows.every((r) => r.tiebreak.length === 0)).toBe(true);
  });
});

describe('two teams tied (§5.5)', () => {
  it('breaks on head-to-head', () => {
    // C finishes clear on 4 points and D on 0, so the tie group is exactly {A, B}.
    const games = [g('A', 'B', 4, 1), g('C', 'A', 5, 0), g('B', 'D', 3, 0), g('C', 'D', 6, 0)];
    const rows = standings(['A', 'B', 'C', 'D'], games);

    expect(order(rows)).toEqual(['C', 'A', 'B', 'D']);

    const winner = rows[1]!;
    expect(winner.record.teamId).toBe('A');
    expect(winner.tiebreak.map((s) => s.rule)).toEqual(['head_to_head']);
    expect(winner.tiebreak[0]!.reasoning).toContain('Kanata Major A advances on head-to-head');
  });

  it('falls through to runs allowed when the teams never met', () => {
    // A and B never play each other; both beat C, both lose to D.
    const games = [
      g('A', 'C', 5, 0),
      g('D', 'A', 3, 1),
      g('B', 'C', 5, 4),
      g('D', 'B', 3, 1),
    ];
    const rows = standings(['A', 'B', 'C', 'D'], games);
    const tied = rows.filter((r) => ['A', 'B'].includes(r.record.teamId));

    // A allowed 0+3 = 3; B allowed 4+3 = 7.
    expect(tied.map((r) => r.record.teamId)).toEqual(['A', 'B']);
    expect(tied[0]!.tiebreak.at(-1)!.rule).toBe('runs_allowed');
    expect(tied[0]!.tiebreak.at(-1)!.reasoning).toBe(
      'Kanata Major A advances on runs allowed: 3 vs 7.',
    );
  });

  it('uses the 10-run cap, which can reverse the raw differential', () => {
    // A: 30-2 over C, 0-10 to D  -> raw +18, capped  0, allowed 12
    // B:  7-2 over C, 8-10 to D  -> raw  +3, capped +3, allowed 12
    // Raw differential favours A; the capped differential the rules call for favours B.
    const games = [
      g('A', 'C', 30, 2),
      g('D', 'A', 10, 0),
      g('B', 'C', 7, 2),
      g('D', 'B', 10, 8),
    ];
    const records = buildRecords(['A', 'B', 'C', 'D'], games);

    expect(records.get('A')!.runDifferentialRaw).toBe(18);
    expect(records.get('B')!.runDifferentialRaw).toBe(3);
    expect(records.get('A')!.runsAllowed).toBe(12);
    expect(records.get('B')!.runsAllowed).toBe(12);

    const rows = computeStandings(records, games, name);
    const tied = rows.filter((r) => ['A', 'B'].includes(r.record.teamId));

    expect(tied.map((r) => r.record.teamId)).toEqual(['B', 'A']);
    expect(tied[0]!.tiebreak.at(-1)!.rule).toBe('run_differential_capped');
  });
});

describe('three teams tied (§5.5)', () => {
  it('breaks on head-to-head when all three have played each other', () => {
    // A, B and C all finish 2-2 with 4 points; the mini-league is A > B > C.
    const games = [
      g('A', 'B', 3, 1),
      g('A', 'C', 3, 1),
      g('B', 'C', 2, 1),
      g('B', 'D', 6, 0),
      g('C', 'D', 5, 0),
      g('C', 'E', 5, 0),
      g('D', 'A', 4, 0),
      g('E', 'A', 4, 0),
    ];
    const records = buildRecords(['A', 'B', 'C', 'D', 'E'], games);
    for (const id of ['A', 'B', 'C']) {
      expect(records.get(id)).toMatchObject({ points: 4, wins: 2 });
    }

    const rows = computeStandings(records, games, name);
    expect(order(rows).slice(0, 3)).toEqual(['A', 'B', 'C']);
    expect(rows[0]!.tiebreak[0]!.rule).toBe('head_to_head');
  });

  it('advances one team on runs allowed, then splits the remaining pair on head-to-head', () => {
    // The exact shape the spec describes: a circular 1-1-1 three-way tie.
    // Wins are equal and the mini-league is a perfect circle, so neither of the
    // first two criteria separates anyone.
    //   runs allowed: A 6, C 6, B 7  -> B is isolated last
    //   remaining pair {A, C}        -> C beat A head-to-head
    const games = [g('A', 'B', 3, 2), g('C', 'A', 4, 1), g('B', 'C', 5, 4)];
    const records = buildRecords(['A', 'B', 'C'], games);

    expect(records.get('A')!.runsAllowed).toBe(6);
    expect(records.get('B')!.runsAllowed).toBe(7);
    expect(records.get('C')!.runsAllowed).toBe(6);

    const rows = computeStandings(records, games, name);
    expect(order(rows)).toEqual(['C', 'A', 'B']);

    // C's placement shows both steps: the group split, then the pair split.
    expect(rows[0]!.tiebreak.map((s) => s.rule)).toEqual(['runs_allowed', 'head_to_head']);
    expect(rows[0]!.tiebreak[1]!.reasoning).toContain('Nepean Major A advances on head-to-head');
  });

  it('skips head-to-head when the three have not all played each other', () => {
    // A-B and A-C were played, B-C was not. Without a complete mini-league the
    // criterion is inapplicable rather than partially applied, so the group
    // falls through to runs allowed: A 6, C 7, B 11.
    const games = [
      g('A', 'B', 5, 4),
      g('C', 'A', 2, 1),
      g('E', 'B', 6, 1),
      g('E', 'C', 6, 1),
      g('B', 'D', 9, 0),
    ];
    const records = buildRecords(['A', 'B', 'C', 'D', 'E'], games);
    for (const id of ['A', 'B', 'C']) {
      expect(records.get(id)).toMatchObject({ points: 2, wins: 1 });
    }
    expect(records.get('A')!.runsAllowed).toBe(6);
    expect(records.get('C')!.runsAllowed).toBe(7);
    expect(records.get('B')!.runsAllowed).toBe(11);

    const rows = computeStandings(records, games, name);
    const tied = rows.filter((r) => ['A', 'B', 'C'].includes(r.record.teamId));

    expect(tied.map((r) => r.record.teamId)).toEqual(['A', 'C', 'B']);
    // No step anywhere in the group may claim a head-to-head result.
    for (const row of tied) {
      expect(row.tiebreak.map((s) => s.rule)).toEqual(['runs_allowed']);
    }
  });
});

describe('forfeit rule (§5.5)', () => {
  it('places a forfeiting team below every clean team, even when it won head-to-head', () => {
    // A beat B 10-0 and would win any head-to-head, but A forfeited to C.
    const games = [
      g('A', 'B', 10, 0),
      g('C', 'A', 7, 0, { resultKind: 'forfeit', forfeitedBy: 'A' }),
      g('B', 'C', 3, 1),
    ];
    const records = buildRecords(['A', 'B', 'C'], games);
    for (const id of ['A', 'B', 'C']) expect(records.get(id)!.points).toBe(2);
    expect(records.get('A')!.forfeits).toBe(1);

    const rows = computeStandings(records, games, name);
    expect(order(rows).at(-1)).toBe('A');
    expect(rows.at(-1)!.tiebreak[0]!.rule).toBe('forfeit_disqualification');
    expect(rows.at(-1)!.tiebreak[0]!.reasoning).toContain('cannot win a tiebreaker');
  });
});

describe('teams that have not played yet', () => {
  it('does not demand a coin flip before the tournament starts', () => {
    const rows = standings(['A', 'B', 'C'], []);

    expect(rows.every((r) => r.awaitingCoinFlip)).toBe(false);
    expect(rows[0]!.tiebreak[0]!.rule).toBe('no_games_played');
    // Alphabetical by team name — Kanata, Nepean, Orleans — and honest about why.
    expect(order(rows)).toEqual(['A', 'C', 'B']);
    expect(rows[0]!.tiebreak[0]!.reasoning).toContain('have not played yet');
  });

  it('ranks a team that lost above a team that has not played', () => {
    // Without this rule, C leads the 0-point group on "fewest runs allowed"
    // purely by never taking the field: 0 allowed beats B's 9.
    const games = [g('A', 'B', 9, 0)];
    const records = buildRecords(['A', 'B', 'C'], games);

    expect(records.get('B')!.runsAllowed).toBe(9);
    expect(records.get('C')!.runsAllowed).toBe(0);
    expect(records.get('B')!.points).toBe(0);
    expect(records.get('C')!.points).toBe(0);

    const rows = computeStandings(records, games, name);
    expect(order(rows)).toEqual(['A', 'B', 'C']);
    expect(rows[2]!.tiebreak[0]!.rule).toBe('no_games_played');
    expect(rows.every((r) => r.awaitingCoinFlip)).toBe(false);
  });
});

describe('coin flip (§5.5)', () => {
  const games = [g('A', 'C', 5, 0), g('B', 'C', 5, 0)];

  it('never invents the result — it reports that a flip is required', () => {
    const rows = standings(['A', 'B', 'C'], games);
    const tied = rows.filter((r) => ['A', 'B'].includes(r.record.teamId));

    expect(tied.every((r) => r.awaitingCoinFlip)).toBe(true);
    expect(tied[0]!.tiebreak[0]!.rule).toBe('coin_flip_required');
    expect(tied[0]!.tiebreak[0]!.reasoning).toContain('provisional');
  });

  it('applies a flip once a director has recorded it', () => {
    const rows = standings(['A', 'B', 'C'], games, { [coinFlipKey(['A', 'B'])]: ['B', 'A'] });
    const tied = rows.filter((r) => ['A', 'B'].includes(r.record.teamId));

    expect(tied.map((r) => r.record.teamId)).toEqual(['B', 'A']);
    expect(tied.every((r) => r.awaitingCoinFlip)).toBe(false);
    expect(tied[0]!.tiebreak[0]!.reasoning).toContain('Coin flip recorded by the director');
  });
});

describe('distinctReasoning — what the standings screen actually prints', () => {
  it('says each sentence once, on the first row it applies to', () => {
    // The circular three-way tie, which finishes C, A, B. Runs allowed isolated
    // B, then head-to-head split C from A — so C's placement needed both steps
    // and the top row carries the whole chain. Every sentence names all the
    // teams it separated, so the rows below add nothing a reader needs.
    const games = [g('A', 'B', 3, 2), g('C', 'A', 4, 1), g('B', 'C', 5, 4)];
    const rows = standings(['A', 'B', 'C'], games);

    expect(order(rows)).toEqual(['C', 'A', 'B']);
    // Without deduplication this would print five lines across three rows.
    expect(rows.reduce((n, r) => n + r.tiebreak.length, 0)).toBe(5);

    expect(distinctReasoning(rows).map((s) => s.reasoning.map((step) => step.rule))).toEqual([
      ['runs_allowed', 'head_to_head'],
      [],
      [],
    ]);
  });

  it('never drops a sentence entirely', () => {
    const games = [g('A', 'B', 3, 2), g('C', 'A', 4, 1), g('B', 'C', 5, 4)];
    const rows = standings(['A', 'B', 'C'], games);

    const everySentence = new Set(rows.flatMap((r) => r.tiebreak.map((s) => s.reasoning)));
    const printed = new Set(
      distinctReasoning(rows).flatMap((s) => s.reasoning.map((step) => step.reasoning)),
    );
    expect(printed).toEqual(everySentence);
  });

  it('leaves the full per-team chain intact for exports and the audit trail', () => {
    const games = [g('A', 'B', 3, 2), g('C', 'A', 4, 1), g('B', 'C', 5, 4)];
    const rows = standings(['A', 'B', 'C'], games);
    const before = rows.map((r) => r.tiebreak.length);

    distinctReasoning(rows);

    expect(rows.map((r) => r.tiebreak.length)).toEqual(before);
  });

  it('prints nothing when nobody was tied', () => {
    const games = [g('A', 'B', 5, 3), g('A', 'C', 4, 2), g('B', 'C', 6, 1)];
    const shown = distinctReasoning(standings(['A', 'B', 'C'], games));
    expect(shown.every((s) => s.reasoning.length === 0)).toBe(true);
  });
});

describe('reasoning is always present when a tiebreak happened', () => {
  it('gives every tied team at least one readable sentence', () => {
    const games = [g('A', 'B', 3, 2), g('C', 'A', 4, 1), g('B', 'C', 5, 4)];
    const rows = standings(['A', 'B', 'C'], games);

    for (const row of rows) {
      expect(row.tiebreak.length).toBeGreaterThan(0);
      for (const step of row.tiebreak) {
        expect(step.reasoning.length).toBeGreaterThan(10);
        expect(step.reasoning.endsWith('.')).toBe(true);
      }
    }
  });
});


describe('a pool where rain took some games away', () => {
  const games = (list: [string, string, number, number][]): GameResult[] =>
    list.map(([home, away, homeRuns, awayRuns], i) => ({
      gameId: `G${i}`,
      divisionId: 'div',
      poolId: null,
      gameType: 'round_robin',
      resultKind: 'played' as const,
      homeTeamId: home,
      awayTeamId: away,
      homeRuns,
      awayRuns,
      forfeitedBy: null,
    }));

  it('says nothing when everybody played the same number', () => {
    const records = buildRecords(['a', 'b', 'c'], games([
      ['a', 'b', 5, 3], ['b', 'c', 4, 2], ['c', 'a', 1, 0],
    ]));
    expect(poolBalance(records).uneven).toBe(false);
  });

  it('flags the pool and names who is short', () => {
    // 'c' lost a game to the weather.
    const records = buildRecords(['a', 'b', 'c'], games([
      ['a', 'b', 5, 3], ['a', 'c', 4, 2], ['b', 'c', 1, 0],
    ]).slice(0, 2));
    const balance = poolBalance(records);
    expect(balance.uneven).toBe(true);
    expect(balance.most).toBe(2);
    expect(balance.fewest).toBe(1);
    expect(balance.shortOfGames.map((s) => s.teamId).sort()).toEqual(['b', 'c']);
  });

  it('orders the short teams by how short they are', () => {
    const records = buildRecords(['a', 'b', 'c'], games([
      ['a', 'b', 5, 3], ['a', 'c', 4, 2], ['b', 'c', 1, 0], ['a', 'b', 2, 1],
    ]));
    // a: 3, b: 3, c: 2 — only c is short.
    const balance = poolBalance(records);
    expect(balance.shortOfGames.map((s) => s.teamId)).toEqual(['c']);
  });

  it('does not pick a winner or switch to points per game', () => {
    // The tournament decides on the day. This function reports, it does not
    // rule — anything else would quietly reseed a pool nobody looked at.
    const records = buildRecords(['a', 'b'], games([['a', 'b', 5, 3]]).slice(0, 1));
    const balance = poolBalance(records);
    expect(Object.keys(balance).sort()).toEqual(['fewest', 'most', 'shortOfGames', 'uneven']);
  });

  it('handles an empty pool without dividing by anything', () => {
    expect(poolBalance(new Map()).uneven).toBe(false);
  });
});
