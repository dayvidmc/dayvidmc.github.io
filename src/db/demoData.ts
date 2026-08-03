import { query, transaction } from './client';
import { MAJOR_2026_RULES } from '@/domain/divisionRules';
import { hashPin, newAccessToken } from '@/server/auth';
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

/**
 * The menu, with what each thing costs the tournament.
 *
 * Montana's donate the food and the labour for the BBQ at the main field and
 * tell the committee to charge whatever they like, so those lines cost nothing
 * and the money screen credits the gift with what it earned. One item is left
 * with no cost recorded on purpose, so the "this total is a ceiling" warning
 * has something real to fire on.
 */
const MENU: [name: string, group: string, priceCents: number, costCents: number | null, donatedBy: string | null][] = [
  ['Hamburger', 'Hot food', 500, 0, "Montana's"],
  ['Hot dog', 'Hot food', 300, 0, "Montana's"],
  ['Pulled pork', 'Hot food', 700, 0, "Montana's"],
  ['Sausage', 'Hot food', 550, 180, null],
  ['Fries', 'Hot food', 400, 95, null],
  ['Water', 'Drinks', 200, 40, null],
  ['Pop', 'Drinks', 200, 55, null],
  ['Gatorade', 'Drinks', 300, 110, null],
  ['Coffee', 'Drinks', 175, 30, null],
  ['Chips', 'Snacks', 150, 60, null],
  // Nobody has priced these up yet, which is normal and worth showing.
  ['Chocolate bar', 'Snacks', 200, null, null],
  ['Freezie', 'Snacks', 100, 22, null],
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
    for (const [index, [name, category, priceCents, costCents, donatedBy]] of MENU.entries()) {
      await client.query(
        `INSERT INTO concession_item
           (tournament_id, name, category, price_cents, sort_order, cost_cents, donated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, name, category, priceCents, index, costCents, donatedBy],
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

  // --- The crew -------------------------------------------------------------
  //
  // The demo turns umpire score entry on so the capability can be looked at.
  // The default is off, and stays off for a real tournament until a director
  // decides otherwise.
  await query('UPDATE tournament SET umpire_score_entry = true WHERE id = $1', [tournamentId]);
  await seedUmpires(tournamentId);

  // --- Registration and rosters --------------------------------------------
  await seedRosters(tournamentId);

  // --- The money side -------------------------------------------------------
  await seedConcessionSales(tournamentId, base);
  await seedFundraising(tournamentId);
  await seedAuction(tournamentId);

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
 * Umpires, with a crew on every game that has happened or is happening.
 *
 * Deliberately includes one deliberate mess: an umpire double-booked across two
 * diamonds at the same time. The crew screen is only worth anything if it
 * catches that, and a demo where everything is tidy proves nothing.
 */
async function seedUmpires(tournamentId: string): Promise<void> {
  const crew: [string, string, number][] = [
    // name, level, rate in dollars
    ['Dana Reyes', 'Level 4', 45],
    ['Sam Cote', 'Level 3', 40],
    ['Priya Raman', 'Level 3', 40],
    ['Marcus Bell', 'Level 2', 35],
    ['Jo Tremblay', 'Level 2', 35],
  ];

  const used = new Set<string>();
  const ids: string[] = [];

  for (const [name, level, rate] of crew) {
    const [row] = await query<{ id: string }>(
      `INSERT INTO umpire (tournament_id, name, level, rate_cents, phone, access_token)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [tournamentId, name, level, rate * 100, fakePhone(name, used), newAccessToken()],
    );
    ids.push(row!.id);
  }

  // Two umpires per game, walked through the roster so the days look worked
  // rather than generated.
  const games = await query<{ id: string }>(
    `SELECT id FROM game WHERE tournament_id = $1 AND cancelled_at IS NULL
      ORDER BY scheduled_start, external_game_id`,
    [tournamentId],
  );

  for (const [index, game] of games.entries()) {
    const plate = ids[index % ids.length]!;
    const base = ids[(index + 2) % ids.length]!;
    await query(
      `INSERT INTO game_umpire (game_id, umpire_id, position, assigned_by)
       VALUES ($1,$2,'plate','Volunteer Coordinator'), ($1,$3,'base','Volunteer Coordinator')
       ON CONFLICT DO NOTHING`,
      [game.id, plate, base],
    );
  }

  // Now break it on purpose. Two games start at the same time; put the first
  // one's plate umpire on the second as well, so the crew screen has a real
  // double-booking to catch. A demo where everything is tidy proves nothing.
  const [concurrent] = await query<{ first_id: string; second_id: string }>(
    `SELECT a.id AS first_id, b.id AS second_id
       FROM game a
       JOIN game b ON b.scheduled_start = a.scheduled_start AND b.id > a.id
      WHERE a.tournament_id = $1 AND a.cancelled_at IS NULL AND b.cancelled_at IS NULL
      ORDER BY a.scheduled_start
      LIMIT 1`,
    [tournamentId],
  );

  if (concurrent) {
    const [plate] = await query<{ umpire_id: string }>(
      "SELECT umpire_id FROM game_umpire WHERE game_id = $1 AND position = 'plate'",
      [concurrent.first_id],
    );
    if (plate) {
      await query(
        `INSERT INTO game_umpire (game_id, umpire_id, position, assigned_by)
         VALUES ($1, $2, 'base3', 'Volunteer Coordinator')
         ON CONFLICT DO NOTHING`,
        [concurrent.second_id, plate.umpire_id],
      );
    }
  }
}

const FIRST_NAMES = [
  'Sam', 'Alex', 'Jordan', 'Riley', 'Casey', 'Avery', 'Quinn', 'Rowan', 'Emerson', 'Finley',
  'Harper', 'Kai', 'Logan', 'Micah', 'Noor', 'Parker', 'Reese', 'Sage', 'Tatum', 'Wren',
];
const LAST_NAMES = [
  'Rivera', 'Nakamura', 'Okafor', 'Tremblay', 'Singh', 'Bell', 'Cote', 'Raman', 'Lefebvre',
  'Mensah', 'Novak', 'Ivanov', 'Dubois', 'Haddad', 'Kowalski', 'Moreau', 'Silva', 'Chan',
];

/**
 * Rosters, and registration states worth looking at.
 *
 * Not every team is tidy on purpose. One is short of nine players so the
 * blocking case is visible, one has no roster at all because that is normal
 * before the coaches' meeting, one is locked, and the states run across
 * invited, registered and confirmed. A demo where everything is green shows
 * nothing about what the screen is for.
 */
async function seedRosters(tournamentId: string): Promise<void> {
  const teams = await query<{ id: string; name: string }>(
    'SELECT id, name FROM team WHERE tournament_id = $1 ORDER BY name',
    [tournamentId],
  );

  for (const [index, team] of teams.entries()) {
    // Every fifth team has no roster yet; every seventh is short.
    if (index % 5 === 4) continue;
    const size = index % 7 === 3 ? 7 : 11 + (index % 4);

    for (let n = 0; n < size; n += 1) {
      const first = FIRST_NAMES[(index * 3 + n * 7) % FIRST_NAMES.length]!;
      const last = LAST_NAMES[(index * 5 + n * 3) % LAST_NAMES.length]!;
      await query(
        `INSERT INTO player (tournament_id, team_id, name, jersey)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [tournamentId, team.id, `${first} ${last}`, String(n + 2)],
      );
    }

    const status = index % 5 === 0 ? 'registered' : index % 11 === 7 ? 'invited' : 'confirmed';
    await query(
      `UPDATE team SET registration_status = $2,
              registered_at = CASE WHEN $2 <> 'invited' THEN now() ELSE NULL END
        WHERE id = $1`,
      [team.id, status],
    );

    // One locked roster, so the read-only coach view is reachable.
    if (index === 1) {
      await query(
        "UPDATE team SET roster_locked_at = now(), roster_locked_by = 'Tournament Director' WHERE id = $1",
        [team.id],
      );
    }
  }
}

/**
 * A weekend's worth of canteen sales.
 *
 * Without these the till has never rung anything and both the concessions and
 * the money screens sit at zero, which shows nothing about what either is for.
 * The mix matters more than the volume: the main field sells the donated
 * Montana's food, the other two sell bought-in stock, and one line is a
 * chocolate bar nobody has costed — so the money screen has a real reason to
 * report its total as a ceiling.
 */
async function seedConcessionSales(tournamentId: string, base: Date): Promise<void> {
  const stands = await query<{ id: string; name: string }>(
    'SELECT id, name FROM concession_location WHERE tournament_id = $1 ORDER BY name',
    [tournamentId],
  );
  const items = await query<{ id: string; name: string; price_cents: number; donated_by: string | null }>(
    'SELECT id, name, price_cents, donated_by FROM concession_item WHERE tournament_id = $1',
    [tournamentId],
  );
  if (stands.length === 0 || items.length === 0) return;

  const byName = new Map(items.map((item) => [item.name, item]));

  // What each stand actually shifts over a day. The main field is the BBQ.
  const plan: Record<string, [name: string, units: number][]> = {
    "Tokessy BBQ": [
      ['Hamburger', 140], ['Hot dog', 210], ['Pulled pork', 95],
      ['Pop', 180], ['Water', 160], ['Chips', 70], ['Chocolate bar', 45],
    ],
    'Deevy Pines Canteen': [
      ['Hot dog', 120], ['Sausage', 60], ['Fries', 90],
      ['Pop', 150], ['Water', 130], ['Coffee', 95], ['Freezie', 110], ['Chocolate bar', 40],
    ],
    'Mike Channing Canteen': [
      ['Hot dog', 80], ['Fries', 55], ['Pop', 95], ['Water', 85],
      ['Gatorade', 40], ['Coffee', 60], ['Freezie', 75],
    ],
  };

  for (const stand of stands) {
    const lines = plan[stand.name];
    if (!lines) continue;

    // One order per item line rather than one per customer: the totals are the
    // point here, and four hundred rows of two-item baskets would slow the
    // demo seed down for no gain.
    for (const [index, [name, units]] of lines.entries()) {
      const item = byName.get(name);
      if (!item) continue;

      const total = item.price_cents * units;
      const soldAt = toSqlTimestamp(addMinutes(base, -300 + index * 25));
      const [order] = await query<{ id: string }>(
        `INSERT INTO pos_order
           (id, tournament_id, location_id, sold_by, sold_at, subtotal_cents, total_cents, status)
         VALUES (gen_random_uuid(), $1, $2, 'Concession Volunteer', $3::timestamptz, $4, $4, 'complete')
         RETURNING id`,
        [tournamentId, stand.id, soldAt, total],
      );

      await query(
        `INSERT INTO pos_order_line (order_id, item_id, name, unit_price_cents, quantity, line_total_cents)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [order!.id, item.id, item.name, item.price_cents, units, total],
      );

      // Roughly two thirds cash at a ballpark canteen. A cash tender has to
      // record what was handed over and what came back — the schema insists,
      // and rightly: a drawer count is meaningless without it.
      const card = index % 3 === 2;
      const tendered = card ? null : Math.ceil(total / 500) * 500;
      await query(
        `INSERT INTO pos_tender (order_id, kind, amount_cents, tendered_cents, change_cents)
         VALUES ($1,$2,$3,$4,$5)`,
        [order!.id, card ? 'card' : 'cash', total, tendered, tendered === null ? null : tendered - total],
      );
    }
  }
}

/**
 * The silent auction, caught mid-close.
 *
 * Some lots are shut and paid for, some are shut and the winner still owes,
 * some are still taking bids, and one had no interest at all. That is what the
 * table looks like at 8:30 on the Saturday, and it is the only state in which
 * the screens are worth looking at.
 */
async function seedAuction(tournamentId: string): Promise<void> {
  const lots: [title: string, donor: string, value: number | null, min: number, status: string][] = [
    ['Signed Senators jersey', 'Sens Foundation', 45_000, 20_000, 'closed'],
    ['Weekend at a Mont-Tremblant chalet', 'The Barrett family', 120_000, 60_000, 'closed'],
    ['Case of Montana\'s gift cards', "Montana's", 25_000, 10_000, 'closed'],
    ['Kanata Home Hardware barbecue', 'Kanata Home Hardware', 60_000, 30_000, 'closed'],
    ['Two Redblacks tickets', 'Anonymous', 20_000, 8_000, 'open'],
    ['Baseball clinic with a coach', 'Kanata Minor Baseball', 15_000, 6_000, 'open'],
    ['Hand-knitted team blanket', 'Marion Ellis', null, 4_000, 'open'],
    ['Signed team photo, 1998 champions', 'The Tokessy family', 5_000, 2_000, 'unsold'],
  ];

  const bids: Record<number, [name: string, phone: string | null, amount: number][]> = {
    1: [['Sam Rivera', '+16135551188', 22_000], ['Devi Anand', '+16135552244', 26_500], ['Sam Rivera', '+16135551188', 31_000]],
    2: [['Marlo Fitzgerald', '+16135553311', 65_000], ['Jordan Blake', null, 82_000]],
    3: [['Alex Kim', '+16135554455', 11_000], ['Noor Haddad', '+16135556677', 14_500]],
    4: [['Riley Novak', null, 32_000]],
    5: [['Casey Moreau', '+16135557788', 9_500]],
    6: [['Quinn Silva', '+16135558899', 7_000], ['Avery Chan', null, 8_500]],
  };

  for (const [index, [title, donor, value, min, status]] of lots.entries()) {
    const lot = index + 1;
    const [row] = await query<{ id: string }>(
      `INSERT INTO auction_item
         (tournament_id, lot_number, title, donor, fair_market_value_cents,
          minimum_bid_cents, bid_increment_cents, status, closed_at, closed_by)
       VALUES ($1,$2,$3,$4,$5,$6,500,$7,
               CASE WHEN $7 IN ('closed','unsold') THEN now() END,
               CASE WHEN $7 IN ('closed','unsold') THEN 'Auction Lead' END)
       RETURNING id`,
      [tournamentId, lot, title, donor, value, min, status],
    );

    for (const [name, phone, amount] of bids[lot] ?? []) {
      await query(
        `INSERT INTO auction_bid (item_id, bidder_name, bidder_phone, amount_cents, source, recorded_by)
         VALUES ($1,$2,$3,$4,'paper','Auction Lead')`,
        [row!.id, name, phone, amount],
      );
    }
  }

  // Two of the four closed lots have been paid for; the other two are the
  // queue at the table.
  await query(
    `UPDATE auction_item SET paid_at = now(), paid_by = 'Auction Lead', payment_method = 'cash'
      WHERE tournament_id = $1 AND lot_number IN (1, 3)`,
    [tournamentId],
  );
}

/**
 * The money the weekend raises that does not come through a till.
 *
 * Left deliberately mid-weekend: the auction has taken money and has not
 * closed, one stand's float is still out, and one count went in with a single
 * name on it. A demo where the books balance shows nothing about what the
 * screens are for.
 */
async function seedFundraising(tournamentId: string): Promise<void> {
  const today = formatDate(toWallClock(new Date()));

  const revenue: [stream: string, description: string, amount: number, cost: number][] = [
    ['sponsorship', 'Diamond sponsor signs, 12 at $250', 300_000, 42_000],
    ['sponsorship', 'Program advertising', 145_000, 0],
    ['raffle', '50-50, Saturday draw', 96_500, 8_000],
    ['donation', 'Cash donations at the gate', 34_000, 0],
  ];

  for (const [stream, description, amount, cost] of revenue) {
    await query(
      `INSERT INTO revenue_entry
         (tournament_id, stream, description, amount_cents, cost_cents, occurred_on, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6::date,'Tournament Director')`,
      [tournamentId, stream, description, amount, cost, today],
    );
  }

  const gifts: [donor: string, what: string, kind: string, value: number | null, destination: string, receipt: boolean][] = [
    ["Montana's", 'Burgers, hot dogs and pulled pork for the main field', 'goods', 240_000, 'Tokessy BBQ', true],
    // Their staff cook all day. Recorded because the thank-you should say so,
    // and flagged because a receipt for donated time cannot be issued.
    ["Montana's", 'Two cooks on the grill, both days', 'services', 90_000, 'Tokessy BBQ', true],
    ['Kanata Home Hardware', 'Barbecue and propane', 'goods', 60_000, 'Tokessy BBQ', false],
    ['Sens Foundation', 'Signed jersey', 'goods', 45_000, 'Silent auction table', true],
    ['Bayshore Print', 'Raffle ticket books', 'goods', null, 'Raffle sellers', false],
  ];

  for (const [donor, what, kind, value, destination, receipt] of gifts) {
    await query(
      `INSERT INTO gift_in_kind
         (tournament_id, donor, what, kind, fair_market_value_cents, destination,
          receipt_requested, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'Tournament Director')`,
      [tournamentId, donor, what, kind, value, destination, receipt],
    );
  }

  const cash: [kind: string, source: string, amount: number, by: string, witness: string | null][] = [
    ['float_out', 'Silent auction table', 30_000, 'Tournament Director', null],
    ['float_out', 'Raffle sellers', 20_000, 'Volunteer Coordinator', null],
    ['takings_in', 'Raffle sellers', 116_500, 'Volunteer Coordinator', 'Tournament Director'],
    // One count with a single name on it, which the screen calls out.
    ['takings_in', 'Gate donations box', 34_000, 'HQ Desk 1', null],
    ['bank_deposit', 'Bank', 100_000, 'Tournament Director', 'Concession Lead'],
  ];

  for (const [kind, source, amount, by, witness] of cash) {
    await query(
      `INSERT INTO cash_movement (tournament_id, kind, source, amount_cents, counted_by, witnessed_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [tournamentId, kind, source, amount, by, witness],
    );
  }
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
