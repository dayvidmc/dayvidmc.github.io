import { query, transaction } from './client';
import { MAJOR_2026_RULES } from '@/domain/divisionRules';
import { hashPin } from '@/server/auth';
import { importSchedule } from '@/domain/schedule/import';
import { applySchedule } from '@/server/scheduleStore';
import { approveScore, parkUnmatchedMessage, recordProposal, setDispute } from '@/server/repo';
import { materialiseBracket } from '@/server/brackets';
import { addMinutes, formatDate, formatTime, toSqlTimestamp, toWallClock } from '@/domain/time';

/**
 * A tournament mid-Saturday, for showing someone what this looks like.
 *
 * Built for the Phase 0 debrief: it is much easier to ask a director "is this
 * the board you want?" than to describe one. Everything is dated relative to
 * *now*, so the HQ board shows live statuses — games reported, one waiting on
 * approval, one overdue and going red, one disputed — rather than a page of
 * grey rows dated next July.
 *
 * Yesterday's round robin is complete and produces a genuine circular
 * three-way tie, so the standings screen shows the tiebreaker explaining
 * itself rather than a tidy table nobody has to trust.
 *
 * Run against an empty database:
 *   dropdb tokessy && createdb tokessy && npm run migrate && npm run demo
 */

/** A diamond volunteer's number — not a coach's, so the queue shows both routes. */
const DIAMOND_VOLUNTEER_PHONE = '+16135554417';

const DIAMONDS: [string, string][] = [
  ['Tokessy', 'Tokessy'],
  ['Deevy Pines 1', 'Deevy Pines'],
  ['Deevy Pines 2', 'Deevy Pines'],
  ['Mike Channing', 'Mike Channing'],
  ['Walter Baker West', 'Walter Baker'],
  ['Roland Michener', 'Roland Michener'],
  ['Kinsmen', 'Kinsmen'],
  ['March Central', 'March Central'],
];

type Role =
  | 'director' | 'hq' | 'volunteer_coordinator' | 'auction_lead'
  | 'concession_lead' | 'concession_volunteer';

const STAFF: [string, Role, string][] = [
  ['Tournament Director', 'director', '4021'],
  ['HQ Desk 1', 'hq', '5150'],
  ['HQ Desk 2', 'hq', '6274'],
  ['Volunteer Coordinator', 'volunteer_coordinator', '7318'],
  ['Auction Lead', 'auction_lead', '8493'],
  ['Concession Lead', 'concession_lead', '2260'],
  ['Concession Volunteer', 'concession_volunteer', '9074'],
];

/** Stands, and what each sells. Prices are what the customer pays, all in. */
const STANDS = ['Tokessy BBQ', 'Deevy Pines Canteen', 'Mike Channing Canteen'];

const MENU: [string, string, number][] = [
  // name, group, price in cents
  ['Hot dog', 'Hot food', 300],
  ['Hamburger', 'Hot food', 500],
  ['Sausage', 'Hot food', 550],
  ['Fries', 'Hot food', 400],
  ['Water', 'Drinks', 200],
  ['Pop', 'Drinks', 200],
  ['Gatorade', 'Drinks', 300],
  ['Coffee', 'Drinks', 175],
  ['Chips', 'Snacks', 150],
  ['Chocolate bar', 'Snacks', 200],
  ['Freezie', 'Snacks', 100],
];

/**
 * Yesterday's completed Major A round robin.
 *
 * Chosen so that Kanata, Orleans and Nepean all finish 2-1 on 4 points with
 * equal wins, and the head-to-head among them is a perfect circle — neither of
 * the first two criteria separates anyone. Runs allowed then splits all three
 * (Nepean 6, Kanata 7, Orleans 8), which is the case worth showing a director.
 */
const YESTERDAY: [string, string, string, string, number, number][] = [
  // gameId, diamond, home, away, homeRuns, awayRuns
  ['MA-01', 'Deevy Pines 1', 'Kanata Major A', 'Orleans Major A', 5, 3],
  ['MA-02', 'Deevy Pines 2', 'Nepean Major A', 'Gloucester Major A', 7, 2],
  ['MA-03', 'Deevy Pines 1', 'Kanata Major A', 'Nepean Major A', 1, 4],
  ['MA-04', 'Deevy Pines 2', 'Orleans Major A', 'Gloucester Major A', 6, 1],
  ['MA-05', 'Deevy Pines 1', 'Kanata Major A', 'Gloucester Major A', 9, 0],
  ['MA-06', 'Deevy Pines 2', 'Nepean Major A', 'Orleans Major A', 2, 3],
];

type Intent = 'approved' | 'pending' | 'pending_low' | 'overdue' | 'disputed' | 'live' | 'upcoming';

/** Today, offset in minutes from now, so the board is genuinely live. */
const TODAY: {
  gameId: string;
  division: string;
  diamond: string;
  home: string;
  away: string;
  offset: number;
  intent: Intent;
  score?: [number, number];
  text?: string;
}[] = [
  {
    gameId: 'RK-01', division: 'Rookie', diamond: 'Tokessy',
    home: 'Kanata Rookie', away: 'Stittsville Rookie',
    offset: -250, intent: 'approved', score: [8, 4],
  },
  {
    gameId: 'RK-02', division: 'Rookie', diamond: 'Kinsmen',
    home: 'Barrhaven Rookie', away: 'Nepean Rookie',
    offset: -250, intent: 'approved', score: [3, 3],
  },
  {
    gameId: 'RK-03', division: 'Rookie', diamond: 'Mike Channing',
    home: 'Orleans Rookie', away: 'Gloucester Rookie',
    offset: -190, intent: 'overdue',
  },
  {
    gameId: 'RK-04', division: 'Rookie', diamond: 'March Central',
    home: 'Manotick Rookie', away: 'Riverside Rookie',
    offset: -160, intent: 'pending', score: [6, 2], text: 'Manotick 6 Riverside 2',
  },
  {
    gameId: 'MN-01', division: 'Minor', diamond: 'Walter Baker West',
    home: 'Kanata Minor', away: 'Orleans Minor',
    offset: -235, intent: 'disputed', score: [4, 4],
  },
  {
    gameId: 'MN-02', division: 'Minor', diamond: 'Roland Michener',
    home: 'Nepean Minor', away: 'Stittsville Minor',
    offset: -175, intent: 'pending_low', text: '5-2 i think, ask the other scorekeeper',
  },
  {
    gameId: 'MN-03', division: 'Minor', diamond: 'Deevy Pines 1',
    home: 'Barrhaven Minor', away: 'Gloucester Minor',
    offset: -25, intent: 'live',
  },
  {
    gameId: 'MN-04', division: 'Minor', diamond: 'Deevy Pines 2',
    home: 'Manotick Minor', away: 'Riverside Minor',
    offset: 95, intent: 'upcoming',
  },
  {
    gameId: 'MN-05', division: 'Minor', diamond: 'Tokessy',
    home: 'Kanata Minor B', away: 'Orleans Minor B',
    offset: 160, intent: 'upcoming',
  },
];

export interface DemoResult {
  created: boolean;
  message: string;
  games: number;
  teams: number;
  staff: [string, string][];
  standingsPath: string | null;
  teamPath: string | null;
}

/**
 * Build the demo tournament.
 *
 * Extracted from the CLI script so the same code can run from a button in the
 * app. A tablet has no terminal, and "install the CLI first" is not a
 * reasonable ask of someone who just wants to look at the thing.
 */
export async function seedDemo(): Promise<DemoResult> {
  const existing = await query('SELECT id FROM tournament');
  if (existing.length > 0) {
    return {
      created: false,
      message:
        'This database already has a tournament. The demo needs an empty one, and ' +
        'a tournament with history cannot be deleted — the event log is append-only ' +
        'by design. To start over, delete and re-add the Postgres service.',
      games: 0,
      teams: 0,
      staff: [],
      standingsPath: null,
      teamPath: null,
    };
  }

  const now = toWallClock(new Date());
  // Round down to the previous quarter hour so times read like a real schedule.
  const base = addMinutes(now, -(now.getUTCMinutes() % 15));
  const today = formatDate(now);
  const yesterday = formatDate(addMinutes(now, -24 * 60));
  const tomorrow = formatDate(addMinutes(now, 24 * 60));

  const tournamentId = await transaction(async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO tournament (name, year, starts_on, ends_on)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [
        '30th Annual Scott Tokessy Memorial Gold Glove Tournament',
        now.getUTCFullYear(),
        yesterday,
        tomorrow,
      ],
    );
    const id = inserted.rows[0]!.id;

    for (const [index, name] of ['Rookie', 'Minor', 'Major A'].entries()) {
      await client.query(
        `INSERT INTO division (tournament_id, name, sort_order, rules, rules_reviewed)
         VALUES ($1, $2, $3, $4::jsonb, false)`,
        [id, name, index, JSON.stringify(MAJOR_2026_RULES)],
      );
    }
    for (const [name, site] of DIAMONDS) {
      await client.query('INSERT INTO diamond (tournament_id, name, site) VALUES ($1, $2, $3)', [
        id, name, site,
      ]);
    }
    for (const [name, role, pin] of STAFF) {
      // demo_pin is shown on the sign-in screen when DEMO_MODE=true, so someone
      // trying this for the first time does not need a PIN read out to them.
      // Real setup never writes this column.
      await client.query(
        `INSERT INTO staff_member (tournament_id, name, role, pin_hash, demo_pin)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, name, role, await hashPin(pin), pin],
      );
    }

    for (const stand of STANDS) {
      await client.query(
        'INSERT INTO concession_location (tournament_id, name, site) VALUES ($1, $2, $2)',
        [id, stand],
      );
    }

    // Sold everywhere (location_id NULL), ordered so the busiest sellers sit at
    // the top of the till grid.
    for (const [index, [name, category, priceCents]] of MENU.entries()) {
      await client.query(
        `INSERT INTO concession_item (tournament_id, name, category, price_cents, sort_order)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, name, category, priceCents, index],
      );
    }

    return id;
  });

  // --- Build the schedule and run it through the real importer -------------

  const rows = ['division,pool,game_id,date,start_time,diamond,home_team,away_team,game_type'];

  // Yesterday's Major A round robin: two diamonds, staggered so nothing clashes.
  YESTERDAY.forEach(([gameId, diamond, home, away], index) => {
    const start = 9 * 60 + Math.floor(index / 2) * 135; // 09:00, 11:15, 13:30
    const time = `${String(Math.floor(start / 60)).padStart(2, '0')}:${String(start % 60).padStart(2, '0')}`;
    rows.push(`Major A,Pool 1,${gameId},${yesterday},${time},${diamond},${home},${away},round robin`);
  });

  for (const game of TODAY) {
    const start = addMinutes(base, game.offset);
    rows.push(
      `${game.division},Pool 1,${game.gameId},${formatDate(start)},${formatTime(start)},` +
        `${game.diamond},${game.home},${game.away},round robin`,
    );
  }

  const parsed = importSchedule(rows.join('\n'), {
    rulesByDivision: { Rookie: MAJOR_2026_RULES, Minor: MAJOR_2026_RULES, 'Major A': MAJOR_2026_RULES },
  });

  if (!parsed.importable) {
    const problems = parsed.issues.map((issue) => issue.message).join('; ');
    throw new Error(`Demo schedule failed to import: ${problems}`);
  }

  const applied = await applySchedule(tournamentId, parsed.games, 'demo', 'system');

  const idOf = async (externalGameId: string) =>
    (
      await query<{ id: string }>('SELECT id FROM game WHERE external_game_id = $1', [externalGameId])
    )[0]!.id;

  // Coach numbers, so team notifications have somewhere to go and the unmatched
  // screen can tell HQ whose number an orphan text belongs to.
  const teams = await query<{ id: string; name: string }>('SELECT id, name FROM team ORDER BY name');
  const used = new Set<string>();
  for (const t of teams) {
    await query('UPDATE team SET coach_phone = $2 WHERE id = $1', [t.id, fakePhone(t.name, used)]);
  }

  // --- Yesterday: every game approved --------------------------------------

  for (const [gameId, , , , homeRuns, awayRuns] of YESTERDAY) {
    await approveScore({
      tournamentId,
      gameId: await idOf(gameId),
      scoreReportId: null,
      homeRuns,
      awayRuns,
      approvedBy: 'HQ Desk 1',
      approverRole: 'hq',
    });
  }

  // --- Today: a board with something on every status -----------------------

  for (const game of TODAY) {
    const id = await idOf(game.gameId);

    if (game.intent === 'approved' || game.intent === 'disputed') {
      await approveScore({
        tournamentId,
        gameId: id,
        scoreReportId: null,
        homeRuns: game.score![0],
        awayRuns: game.score![1],
        approvedBy: 'HQ Desk 2',
        approverRole: 'hq',
      });
    }

    if (game.intent === 'disputed') {
      await setDispute(
        tournamentId,
        id,
        true,
        'Orleans coach says the 4th inning run was scored after the time limit. Signed sheets disagree.',
        'Tournament Director',
        'director',
      );
    }

    if (game.intent === 'pending') {
      await recordProposal({
        tournamentId,
        gameId: id,
        source: 'diamond_volunteer',
        reportedBy: DIAMOND_VOLUNTEER_PHONE,
        rawText: game.text!,
        homeRuns: game.score![0],
        awayRuns: game.score![1],
        confidence: 0.95,
      });
    }

    // Below the auto-fill threshold, so the queue shows the raw text and tells
    // whoever is on the desk to read it themselves.
    if (game.intent === 'pending_low') {
      await recordProposal({
        tournamentId,
        gameId: id,
        source: 'coach_sms',
        // A real coach's number, so the queue shows a name a director recognises.
        reportedBy: await coachPhone('Nepean Minor'),
        rawText: game.text!,
        homeRuns: 5,
        awayRuns: 2,
        confidence: 0.45,
      });
    }
  }

  // --- Two texts nobody could place ----------------------------------------

  await parkUnmatchedMessage({
    tournamentId,
    fromPhone: await coachPhone('Kanata Rookie'),
    body: 'we finished ages ago, does someone need the sheet?',
    photoKey: null,
    reason: 'unreadable',
  });

  await parkUnmatchedMessage({
    tournamentId,
    fromPhone: '+16135557788',
    body: null,
    photoKey: 'https://example.invalid/media/signed-sheet.jpg',
    reason: 'no_candidate_games',
  });

  // --- Sunday's bracket, drawn before any of it is played -----------------
  //
  // Two semis seeded from the Major A pool, feeding a final, plus a bronze
  // game off the losing semifinalists. Nothing is played yet, so the whole map
  // renders as promises: "1st in Pool 1", "Winner of Semifinal 1".
  await seedBracket(tournamentId, base);

  const [division] = await query<{ id: string }>(
    "SELECT id FROM division WHERE name = 'Major A'",
  );
  const [team] = await query<{ access_token: string }>(
    "SELECT access_token FROM team WHERE name = 'Nepean Major A'",
  );

  return {
    created: true,
    message: `Demo ready — ${applied.created} games across ${yesterday} (complete), ${today} (live) and ${tomorrow}.`,
    games: applied.created,
    teams: applied.teamsCreated.length,
    staff: STAFF.map(([name, , pin]) => [name, pin] as [string, string]),
    standingsPath: division ? `/standings/${division.id}` : null,
    teamPath: team ? `/team/${team.access_token}` : null,
  };
}

/**
 * A believable-looking but unmistakably fictional number.
 *
 * The 555 exchange is reserved for fiction, which is the point — a demo shown
 * around a committee table must not contain a number that rings a real phone.
 * Derived from the team name rather than a counter so the list does not read as
 * 0001, 0002, 0003 and give the whole thing away as machine output, and so the
 * same team keeps the same number between runs.
 */
function fakePhone(seed: string, used: Set<string>): string {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const line = String((hash + attempt * 137) % 10000).padStart(4, '0');
    const phone = `+1613555${line}`;
    if (!used.has(phone)) {
      used.add(phone);
      return phone;
    }
  }
  throw new Error(`could not allocate a demo number for ${seed}`);
}

async function coachPhone(teamName: string): Promise<string> {
  const [row] = await query<{ coach_phone: string }>(
    'SELECT coach_phone FROM team WHERE name = $1',
    [teamName],
  );
  return row?.coach_phone ?? '+16135550000';
}

/**
 * Draw the Major A playoff bracket.
 *
 * Deliberately left entirely unplayed: the point of the demo is to show that
 * the whole Sunday map exists before a single playoff game, with every empty
 * spot saying what will fill it.
 */
export async function seedBracket(tournamentId: string, base: Date): Promise<void> {
  const [division] = await query<{ id: string }>(
    "SELECT id FROM division WHERE tournament_id = $1 AND name = 'Major A'",
    [tournamentId],
  );
  const [pool] = await query<{ id: string }>(
    'SELECT id FROM pool WHERE division_id = $1 LIMIT 1',
    [division!.id],
  );
  const [diamond] = await query<{ id: string }>(
    "SELECT id FROM diamond WHERE tournament_id = $1 AND name = 'Tokessy'",
    [tournamentId],
  );
  if (!division || !pool || !diamond) return;

  // Tomorrow, in the afternoon.
  const day = addMinutes(base, 24 * 60);
  const slot = (hour: number, minute: number) => {
    const d = new Date(day.getTime());
    d.setUTCHours(hour, minute, 0, 0);
    return toSqlTimestamp(d);
  };

  // Both sides start empty on purpose. The seeds get filled in by
  // `materialiseBracket` from the finished round robin; the bronze and the
  // championship stay empty, because on Saturday night nobody knows who is in
  // them — which is exactly what the map should say.
  const games: [string, string, number, number, string][] = [
    // externalId, label, round, position, startTime
    ['MA-SF1', 'Semifinal 1', 1, 0, slot(10, 0)],
    ['MA-SF2', 'Semifinal 2', 1, 1, slot(12, 15)],
    ['MA-BRZ', 'Bronze', 2, 0, slot(14, 30)],
    ['MA-FIN', 'Championship', 2, 1, slot(16, 45)],
  ];

  const ids: Record<string, string> = {};
  for (const [externalId, label, round, position, startsAt] of games) {
    const [row] = await query<{ id: string }>(
      `INSERT INTO game (tournament_id, division_id, pool_id, external_game_id, scheduled_start,
                         diamond_id, game_type,
                         bracket_round, bracket_position, bracket_label, is_championship_final)
       VALUES ($1,$2,$3,$4,$5::timestamp,$6,'playoff',$7,$8,$9,$10)
       RETURNING id`,
      [
        tournamentId, division.id, pool.id, externalId, startsAt, diamond.id,
        round, position, label, externalId === 'MA-FIN',
      ],
    );
    ids[externalId] = row!.id;
  }

  const slots: [string, 'home' | 'away', string, string | null, number | null][] = [
    // game, side, kind, sourceExternalId, seedRank
    ['MA-SF1', 'home', 'seed', null, 1],
    ['MA-SF1', 'away', 'seed', null, 4],
    ['MA-SF2', 'home', 'seed', null, 2],
    ['MA-SF2', 'away', 'seed', null, 3],
    ['MA-BRZ', 'home', 'loser', 'MA-SF1', null],
    ['MA-BRZ', 'away', 'loser', 'MA-SF2', null],
    ['MA-FIN', 'home', 'winner', 'MA-SF1', null],
    ['MA-FIN', 'away', 'winner', 'MA-SF2', null],
  ];

  for (const [gameKey, side, kind, sourceKey, rank] of slots) {
    await query(
      `INSERT INTO bracket_slot (game_id, side, kind, pool_id, seed_rank, source_game_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        ids[gameKey],
        side,
        kind,
        kind === 'seed' ? pool.id : null,
        kind === 'seed' ? rank : null,
        sourceKey ? ids[sourceKey] : null,
      ],
    );
  }

  // The round robin is complete, so the seeds resolve immediately. Writing them
  // onto the games keeps the stored matchup and the drawn bracket identical —
  // two sources of truth here is how the wrong team ends up advancing.
  await materialiseBracket(tournamentId, division.id);
}
