import { describe, expect, it } from 'vitest';
import {
  bracketProgress,
  resolveBracket,
  roundName,
  slotsToFill,
  type BracketGameInput,
  type ResolveContext,
  type SlotDefinition,
} from './bracket';
import { localWallClock } from './time';

const NAMES: Record<string, string> = {
  kanata: 'Kanata Major A',
  orleans: 'Orleans Major A',
  nepean: 'Nepean Major A',
  gloucester: 'Gloucester Major A',
};

const ctx = (standings: Record<string, string[]> = {}): ResolveContext => ({
  teamName: (id) => NAMES[id] ?? id,
  poolName: (id) => (id === 'pool-1' ? 'Pool 1' : 'Pool 2'),
  standings,
});

const at = (time: string) => localWallClock('2027-07-25', time)!;

function game(
  gameId: string,
  round: number,
  position: number,
  result: BracketGameInput['result'] = null,
): BracketGameInput {
  return {
    gameId,
    externalGameId: gameId.toUpperCase(),
    round,
    position,
    label: null,
    scheduledStart: at('10:00'),
    diamondName: 'Tokessy',
    result,
  };
}

function slot(
  gameId: string,
  side: 'home' | 'away',
  over: Partial<SlotDefinition>,
): SlotDefinition {
  return {
    gameId,
    side,
    kind: 'team',
    teamId: null,
    poolId: null,
    seedRank: null,
    sourceGameId: null,
    overridden: false,
    ...over,
  };
}

/** Two semis feeding a final — the shape almost every division uses. */
const SEMIS_AND_FINAL = {
  games: [game('sf1', 1, 0), game('sf2', 1, 1), game('final', 2, 0)],
  slots: [
    slot('sf1', 'home', { kind: 'seed', poolId: 'pool-1', seedRank: 1 }),
    slot('sf1', 'away', { kind: 'seed', poolId: 'pool-1', seedRank: 4 }),
    slot('sf2', 'home', { kind: 'seed', poolId: 'pool-1', seedRank: 2 }),
    slot('sf2', 'away', { kind: 'seed', poolId: 'pool-1', seedRank: 3 }),
    slot('final', 'home', { kind: 'winner', sourceGameId: 'sf1' }),
    slot('final', 'away', { kind: 'winner', sourceGameId: 'sf2' }),
  ],
};

describe('round naming', () => {
  it('names rounds by distance from the end, not by number', () => {
    expect(roundName(3, 3)).toBe('Final');
    expect(roundName(2, 3)).toBe('Semifinals');
    expect(roundName(1, 3)).toBe('Quarterfinals');
    // A one-round playoff is still a final.
    expect(roundName(1, 1)).toBe('Final');
  });
});

describe('an empty bracket still draws', () => {
  it('describes every slot before a single game is played', () => {
    const rounds = resolveBracket(SEMIS_AND_FINAL.games, SEMIS_AND_FINAL.slots, ctx());

    expect(rounds.map((r) => r.name)).toEqual(['Semifinals', 'Final']);

    const sf1 = rounds[0]!.games[0]!;
    expect(sf1.label).toBe('Semifinal 1');
    expect(sf1.home).toEqual({ state: 'waiting', describes: '1st in Pool 1' });
    expect(sf1.away).toEqual({ state: 'waiting', describes: '4th in Pool 1' });
    expect(sf1.ready).toBe(false);

    // The final names the games that will fill it, by their labels.
    const final = rounds[1]!.games[0]!;
    expect(final.home).toEqual({ state: 'waiting', describes: 'Winner of Semifinal 1' });
    expect(final.away).toEqual({ state: 'waiting', describes: 'Winner of Semifinal 2' });
  });
});

describe('slots fill as the weekend goes on', () => {
  it('seeds fill from standings', () => {
    const standings = { 'pool-1': ['kanata', 'orleans', 'nepean', 'gloucester'] };
    const rounds = resolveBracket(SEMIS_AND_FINAL.games, SEMIS_AND_FINAL.slots, ctx(standings));

    const sf1 = rounds[0]!.games[0]!;
    expect(sf1.home).toMatchObject({ state: 'filled', teamName: 'Kanata Major A' });
    expect(sf1.away).toMatchObject({ state: 'filled', teamName: 'Gloucester Major A' });
    expect(sf1.ready).toBe(true);
    // It still says where the team came from.
    expect(sf1.home).toMatchObject({ source: '1st in Pool 1' });

    // The final is still waiting — the semis have not been played.
    expect(rounds[1]!.games[0]!.home.state).toBe('waiting');
  });

  it('a played semi fills the final', () => {
    const standings = { 'pool-1': ['kanata', 'orleans', 'nepean', 'gloucester'] };
    const games = [
      game('sf1', 1, 0, { homeTeamId: 'kanata', awayTeamId: 'gloucester', homeRuns: 7, awayRuns: 2 }),
      game('sf2', 1, 1),
      game('final', 2, 0),
    ];

    const rounds = resolveBracket(games, SEMIS_AND_FINAL.slots, ctx(standings));
    const final = rounds[1]!.games[0]!;

    expect(final.home).toMatchObject({ state: 'filled', teamName: 'Kanata Major A' });
    expect(final.away).toEqual({ state: 'waiting', describes: 'Winner of Semifinal 2' });
    // Half-filled is not playable, and the map should say so.
    expect(final.ready).toBe(false);

    expect(rounds[0]!.games[0]!.winner).toBe('home');
  });

  it('partial standings fill only the seeds that are decided', () => {
    // Only the top two places have been settled.
    const rounds = resolveBracket(
      SEMIS_AND_FINAL.games,
      SEMIS_AND_FINAL.slots,
      ctx({ 'pool-1': ['kanata', 'orleans'] }),
    );

    expect(rounds[0]!.games[0]!.home.state).toBe('filled'); // 1st
    expect(rounds[0]!.games[0]!.away).toEqual({ state: 'waiting', describes: '4th in Pool 1' });
    expect(rounds[0]!.games[1]!.home.state).toBe('filled'); // 2nd
    expect(rounds[0]!.games[1]!.away).toEqual({ state: 'waiting', describes: '3rd in Pool 1' });
  });
});

describe('round naming in the page', () => {
  it('pluralises a last round that holds more than one game', () => {
    const games = [game('sf1', 1, 0), game('sf2', 1, 1), game('bronze', 2, 0), game('final', 2, 1)];
    const rounds = resolveBracket(games, SEMIS_AND_FINAL.slots, ctx());
    expect(rounds.map((r) => r.name)).toEqual(['Semifinals', 'Finals']);
  });

  it('keeps the singular when the last round is one game', () => {
    const rounds = resolveBracket(SEMIS_AND_FINAL.games, SEMIS_AND_FINAL.slots, ctx());
    expect(rounds.map((r) => r.name)).toEqual(['Semifinals', 'Final']);
  });
});

describe('bronze games', () => {
  it('a loser slot names the game it is waiting on', () => {
    const games = [game('sf1', 1, 0), game('sf2', 1, 1), game('bronze', 2, 0), game('final', 2, 1)];
    const slots = [
      ...SEMIS_AND_FINAL.slots,
      slot('bronze', 'home', { kind: 'loser', sourceGameId: 'sf1' }),
      slot('bronze', 'away', { kind: 'loser', sourceGameId: 'sf2' }),
    ];

    const rounds = resolveBracket(games, slots, ctx());
    const bronze = rounds[1]!.games[0]!;
    expect(bronze.home).toEqual({ state: 'waiting', describes: 'Loser of Semifinal 1' });
  });

  it('fills a bronze game from the losing side', () => {
    const games = [
      game('sf1', 1, 0, { homeTeamId: 'kanata', awayTeamId: 'gloucester', homeRuns: 7, awayRuns: 2 }),
      game('sf2', 1, 1),
      game('bronze', 2, 0),
      game('final', 2, 1),
    ];
    const slots = [
      ...SEMIS_AND_FINAL.slots,
      slot('bronze', 'home', { kind: 'loser', sourceGameId: 'sf1' }),
      slot('bronze', 'away', { kind: 'loser', sourceGameId: 'sf2' }),
    ];

    const bronze = resolveBracket(games, slots, ctx())[1]!.games[0]!;
    expect(bronze.home).toMatchObject({ state: 'filled', teamName: 'Gloucester Major A' });
  });
});

describe('propagating a result forward', () => {
  const result = { homeTeamId: 'kanata', awayTeamId: 'gloucester', homeRuns: 7, awayRuns: 2 };

  it('names the slots a finished game fills', () => {
    const slots = [
      ...SEMIS_AND_FINAL.slots,
      slot('bronze', 'home', { kind: 'loser', sourceGameId: 'sf1' }),
    ];

    expect(slotsToFill('sf1', result, slots)).toEqual([
      { gameId: 'final', side: 'home', teamId: 'kanata' },
      { gameId: 'bronze', side: 'home', teamId: 'gloucester' },
    ]);
  });

  it('never touches a slot a director pinned by hand', () => {
    const slots = SEMIS_AND_FINAL.slots.map((s) =>
      s.gameId === 'final' && s.side === 'home' ? { ...s, overridden: true } : s,
    );
    expect(slotsToFill('sf1', result, slots)).toEqual([]);
  });

  it('advances nobody on a tie rather than guessing', () => {
    const tied = { ...result, homeRuns: 4, awayRuns: 4 };
    expect(slotsToFill('sf1', tied, SEMIS_AND_FINAL.slots)).toEqual([]);

    const games = [game('sf1', 1, 0, tied), game('sf2', 1, 1), game('final', 2, 0)];
    const final = resolveBracket(games, SEMIS_AND_FINAL.slots, ctx())[1]!.games[0]!;
    expect(final.home.state).toBe('waiting');
  });
});

describe('progress and champion', () => {
  it('counts what has been played', () => {
    const games = [
      game('sf1', 1, 0, { homeTeamId: 'kanata', awayTeamId: 'gloucester', homeRuns: 7, awayRuns: 2 }),
      game('sf2', 1, 1),
      game('final', 2, 0),
    ];
    const progress = bracketProgress(resolveBracket(games, SEMIS_AND_FINAL.slots, ctx()));
    expect(progress).toMatchObject({ played: 1, total: 3, champion: null });
  });

  it('crowns a champion once the final is done', () => {
    const games = [
      game('sf1', 1, 0, { homeTeamId: 'kanata', awayTeamId: 'gloucester', homeRuns: 7, awayRuns: 2 }),
      game('sf2', 1, 1, { homeTeamId: 'orleans', awayTeamId: 'nepean', homeRuns: 3, awayRuns: 5 }),
      game('final', 2, 0, { homeTeamId: 'kanata', awayTeamId: 'nepean', homeRuns: 6, awayRuns: 1 }),
    ];
    const progress = bracketProgress(resolveBracket(games, SEMIS_AND_FINAL.slots, ctx()));
    expect(progress).toMatchObject({ played: 3, total: 3, champion: 'Kanata Major A' });
  });

  it('crowns nobody when the last round also holds a bronze game', () => {
    // Two games in the last round means no single decider.
    const games = [
      game('sf1', 1, 0),
      game('sf2', 1, 1),
      game('bronze', 2, 0, { homeTeamId: 'orleans', awayTeamId: 'gloucester', homeRuns: 4, awayRuns: 1 }),
      game('final', 2, 1, { homeTeamId: 'kanata', awayTeamId: 'nepean', homeRuns: 6, awayRuns: 1 }),
    ];
    expect(bracketProgress(resolveBracket(games, SEMIS_AND_FINAL.slots, ctx())).champion).toBeNull();
  });
});

describe('a director pinning a slot by hand', () => {
  const standings = { 'pool-1': ['kanata', 'orleans', 'nepean', 'gloucester'] };

  it('wins over the rule underneath it', () => {
    const slots = SEMIS_AND_FINAL.slots.map((s) =>
      s.gameId === 'sf1' && s.side === 'home'
        ? { ...s, teamId: 'nepean', overridden: true }
        : s,
    );
    const sf1 = resolveBracket(SEMIS_AND_FINAL.games, slots, ctx(standings))[0]!.games[0]!;

    // 1st in Pool 1 is Kanata, but the director said Nepean.
    expect(sf1.home).toMatchObject({ state: 'filled', teamName: 'Nepean Major A' });
    expect(sf1.home).toMatchObject({ source: 'set by the director' });
  });

  it('leaves the rule intact, so unpinning gives the slot back', () => {
    // Same slot with the pin lifted: the seed rule is still there and takes over.
    const slots = SEMIS_AND_FINAL.slots.map((s) =>
      s.gameId === 'sf1' && s.side === 'home' ? { ...s, teamId: null, overridden: false } : s,
    );
    const sf1 = resolveBracket(SEMIS_AND_FINAL.games, slots, ctx(standings))[0]!.games[0]!;
    expect(sf1.home).toMatchObject({ state: 'filled', teamName: 'Kanata Major A' });
  });
});

describe('a bracket edited into a loop does not hang', () => {
  it('stops rather than recursing forever', () => {
    const games = [game('a', 1, 0), game('b', 2, 0)];
    const slots = [
      slot('a', 'home', { kind: 'winner', sourceGameId: 'b' }),
      slot('b', 'home', { kind: 'winner', sourceGameId: 'a' }),
    ];
    const rounds = resolveBracket(games, slots, ctx());
    expect(rounds[0]!.games[0]!.home.state).toBe('waiting');
    expect(rounds[1]!.games[0]!.home.state).toBe('waiting');
  });
});
