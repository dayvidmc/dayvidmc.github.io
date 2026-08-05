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

/**
 * The thirteen divisions the tournament actually runs.
 *
 * Four age groups, and a second axis that is *not* purely a skill tier —
 * Girls sits beside All Star, A and B rather than under them. That is why the
 * age group is its own column and the tier stays part of the name, which is
 * what goes on a scoreboard.
 *
 * Ordered as a director reads a wall chart: youngest first, and within an age
 * group the strongest tier first.
 */
const DIVISIONS: [ageGroup: string, tier: string, groupOrder: number][] = [
  ['Rookie', 'A', 0],
  ['Rookie', 'B', 1],
  ['Minor', 'All Star', 0],
  ['Minor', 'A', 1],
  ['Minor', 'B', 2],
  ['Minor', 'Girls', 3],
  ['Major', 'All Star', 0],
  ['Major', 'A', 1],
  ['Major', 'B', 2],
  ['Major', 'Girls', 3],
  ['Junior', 'A', 0],
  ['Junior', 'B', 1],
  ['Junior', 'Girls', 2],
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
    gameId: 'RK-01', division: 'Rookie A', diamond: 'Tokessy',
    home: 'Kanata Rookie', away: 'Stittsville Rookie',
    offset: -250, intent: 'approved', score: [8, 4],
  },
  {
    gameId: 'RK-02', division: 'Rookie A', diamond: 'Kinsmen',
    home: 'Barrhaven Rookie', away: 'Nepean Rookie',
    offset: -250, intent: 'approved', score: [3, 3],
  },
  {
    gameId: 'RK-03', division: 'Rookie A', diamond: 'Mike Channing',
    home: 'Orleans Rookie', away: 'Gloucester Rookie',
    offset: -190, intent: 'overdue',
  },
  {
    gameId: 'RK-04', division: 'Rookie A', diamond: 'March Central',
    home: 'Manotick Rookie', away: 'Riverside Rookie',
    offset: -160, intent: 'pending', score: [6, 2], text: 'Manotick 6 Riverside 2',
  },
  {
    gameId: 'MN-01', division: 'Minor A', diamond: 'Walter Baker West',
    home: 'Kanata Minor', away: 'Orleans Minor',
    offset: -235, intent: 'disputed', score: [4, 4],
  },
  {
    gameId: 'MN-02', division: 'Minor A', diamond: 'Roland Michener',
    home: 'Nepean Minor', away: 'Stittsville Minor',
    offset: -175, intent: 'pending_low', text: '5-2 i think, ask the other scorekeeper',
  },
  {
    gameId: 'MN-03', division: 'Minor A', diamond: 'Deevy Pines 1',
    home: 'Barrhaven Minor', away: 'Gloucester Minor',
    offset: -25, intent: 'live',
  },
  {
    gameId: 'MN-04', division: 'Minor A', diamond: 'Deevy Pines 2',
    home: 'Manotick Minor', away: 'Riverside Minor',
    offset: 95, intent: 'upcoming',
  },
  {
    gameId: 'MN-05', division: 'Minor A', diamond: 'Tokessy',
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
      `INSERT INTO tournament
         (name, year, starts_on, ends_on,
          ticket_covers, tickets_per_player,
          previous_year_raised_cents, donations_open, donation_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8) RETURNING id`,
      [
        '30th Annual Scott Tokessy Memorial Gold Glove Tournament',
        now.getUTCFullYear(),
        yesterday,
        tomorrow,
        'a bag of chips and a drink, or a hot dog at a field with a barbecue',
        1,
        // Last year's real figure, which is what "more than last year" means.
        4_500_000,
        'Twenty-nine years of this tournament have raised over $536,000 for CHEO Cardiology, ' +
          'and last year alone raised $45,000. Every dollar given here goes there — nothing is ' +
          'taken out for running the weekend. That is what the entry fees and the canteen are for.',
      ],
    );
    const id = inserted.rows[0]!.id;

    for (const [index, [ageGroup, tier, groupOrder]] of DIVISIONS.entries()) {
      await client.query(
        `INSERT INTO division (tournament_id, name, age_group, sort_order, group_order,
                               rules, rules_reviewed)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, false)`,
        [id, `${ageGroup} ${tier}`, ageGroup, index, groupOrder,
          JSON.stringify(MAJOR_2026_RULES)],
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
    rulesByDivision: Object.fromEntries(
      DIVISIONS.map(([ageGroup, tier]) => [`${ageGroup} ${tier}`, MAJOR_2026_RULES]),
    ),
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
  await seedEntries(tournamentId);
  await seedPurchasesAndSponsors(tournamentId);
  await seedVolunteers(tournamentId, base);
  await seedDonations(tournamentId);
  await seedWebsite(tournamentId);

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
  // The crew is a mix of paid and volunteer, which is the real arrangement, and
  // the honorarium report is only readable if the demo shows both — a volunteer
  // on £0 and a paid umpire nobody has set a rate for look identical otherwise.
  const crew: [string, string, number, boolean][] = [
    // name, level, rate in dollars, volunteer
    ['Dana Reyes', 'Level 4', 45, false],
    ['Sam Cote', 'Level 3', 40, false],
    ['Priya Raman', 'Level 3', 40, false],
    ['Marcus Bell', 'Level 2', 35, false],
    ['Jo Tremblay', 'Level 2', 35, false],
    ['Chris Okafor', 'Level 2', 0, true],
    ['Erin Doyle', 'Level 1', 0, true],
    // Paid, but no rate typed in yet. The one state the pay screen chases.
    ['Tom Nadeau', 'Level 3', 0, false],
  ];

  const used = new Set<string>();
  const ids: string[] = [];

  for (const [name, level, rate, volunteer] of crew) {
    const [row] = await query<{ id: string }>(
      `INSERT INTO umpire (tournament_id, name, level, rate_cents, volunteer, phone, access_token)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [
        tournamentId, name, level, rate * 100, volunteer,
        fakePhone(name, used), newAccessToken(),
      ],
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

    // And the tickets from the team packages, coming back across the counter.
    // A ticket sale records the food at what it would have sold for and settles
    // against a tender that is worth nothing — so the stock adds up and the
    // raised figure does not count food that was given away.
    const hotDog = byName.get('Hot dog');
    const pop = byName.get('Pop');
    if (hotDog && pop) {
      const tickets = stand.name === 'Tokessy BBQ' ? 64 : 28;
      const total = (hotDog.price_cents + pop.price_cents) * tickets;
      const [order] = await query<{ id: string }>(
        `INSERT INTO pos_order
           (id, tournament_id, location_id, sold_by, sold_at, subtotal_cents, total_cents, status)
         VALUES (gen_random_uuid(), $1, $2, 'Concession Volunteer', $3::timestamptz, $4, $4, 'complete')
         RETURNING id`,
        [tournamentId, stand.id, toSqlTimestamp(addMinutes(base, -120)), total],
      );

      for (const item of [hotDog, pop]) {
        await query(
          `INSERT INTO pos_order_line (order_id, item_id, name, unit_price_cents, quantity, line_total_cents)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [order!.id, item.id, item.name, item.price_cents, tickets, item.price_cents * tickets],
        );
      }

      await query(
        `INSERT INTO pos_tender (order_id, kind, amount_cents, ticket_count)
         VALUES ($1,'ticket',$2,$3)`,
        [order!.id, total, tickets],
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
 * The volunteer rota, caught mid-Saturday and honestly short.
 *
 * "A mix, and it is a struggle every year" is the tournament's own description,
 * so a demo where every shift is full would show nothing. Here one diamond has
 * nobody on it and games starting, one person has not turned up, two are
 * pencilled in without confirming, and three people on the list have no shift
 * at all — which is the state the coverage board exists to sort out.
 *
 * The diamond shifts matter beyond the rota: whoever is on one can text a score
 * in and have it land on the right game.
 */
async function seedVolunteers(tournamentId: string, base: Date): Promise<void> {
  const diamonds = await query<{ id: string; name: string }>(
    'SELECT id, name FROM diamond WHERE tournament_id = $1 ORDER BY name',
    [tournamentId],
  );
  const stands = await query<{ id: string; name: string }>(
    'SELECT id, name FROM concession_location WHERE tournament_id = $1 ORDER BY name',
    [tournamentId],
  );
  const diamondId = (name: string) => diamonds.find((d) => d.name === name)?.id ?? null;
  const standId = (name: string) => stands.find((l) => l.name === name)?.id ?? null;

  const people: [name: string, phone: string | null, email: string | null, canDo: string | null][] = [
    ['Marion Ellis', '+16135550219', 'marion.ellis@example.com', 'Canteen, both days'],
    // Deliberately the number the demo's texted scores come from. Putting him
    // on a diamond is what makes score intake path 1 work end to end in the
    // demo — until now no posting existed at all and the fastest route a score
    // has into the system could not be shown to anybody.
    ['Ray Deschamps', DIAMOND_VOLUNTEER_PHONE, null, 'Diamonds — has done it for years'],
    ['Priya Raman', '+16135550221', 'priya.raman@example.com', 'Anything'],
    ['Tom Reilly', '+16135550222', null, 'Grill only'],
    ['Jen Okafor', '+16135550223', 'jen.okafor@example.com', 'Gate, Saturday morning'],
    ['Alice Barrett', null, 'alice.barrett@example.com', 'Auction table'],
    ['Chris Lalonde', '+16135550225', null, 'Setup and teardown'],
    ['Dana Whitfield', '+16135550226', 'dana.whitfield@example.com', null],
    ['Noor Haddad', '+16135550227', null, 'Diamonds'],
  ];

  const ids = new Map<string, string>();
  for (const [name, phone, email, canDo] of people) {
    const [row] = await query<{ id: string }>(
      `INSERT INTO volunteer (tournament_id, name, phone, email, can_do, access_token)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [tournamentId, name, phone, email, canDo, newAccessToken()],
    );
    ids.set(name, row!.id);
  }

  // Shifts spanning today, so the board has something live on it.
  const day = formatDate(base);
  const shifts: [
    role: string,
    diamond: string | null,
    stand: string | null,
    site: string | null,
    place: string | null,
    from: string,
    to: string,
    needed: number,
    on: string[],
    confirmed: boolean,
  ][] = [
    // A site supervisor covers every diamond at their site. Deevy Pines has two,
    // so Dana's phone is recognised for a score texted from either — this is the
    // path the signed sheets actually take.
    ['site_supervisor', null, null, 'Deevy Pines', null, '08:00', '14:00', 1, ['Dana Whitfield'], true],
    // Walter Baker has nobody supervising it. That is a site whose results
    // nobody is going to text in, and the coverage board says so out loud.
    ['site_supervisor', null, null, 'Walter Baker', null, '08:00', '14:00', 1, [], false],
    ['diamond', 'Tokessy', null, null, null, '08:30', '13:00', 1, ['Ray Deschamps'], true],
    ['diamond', 'Deevy Pines 1', null, null, null, '08:30', '13:00', 1, ['Noor Haddad'], false],
    // Nobody at all, and games are on. This is the top of the board.
    ['diamond', 'Mike Channing', null, null, null, '08:30', '13:00', 1, [], false],
    // Lining and raking, before anybody arrives. Short, as it is every year.
    ['grounds', null, null, 'Tokessy', null, '06:30', '08:00', 3, ['Chris Lalonde'], true],
    ['canteen', null, 'Tokessy BBQ', null, null, '10:00', '15:00', 3, ['Marion Ellis', 'Priya Raman'], true],
    ['bbq', null, null, null, 'Main field grill', '11:00', '15:00', 2, ['Tom Reilly'], false],
    ['gate', null, null, null, 'Main gate', '08:00', '12:00', 2, ['Jen Okafor'], true],
    ['auction', null, null, null, 'Auction table', '15:00', '20:00', 2, ['Alice Barrett'], true],
    ['setup', null, null, null, 'Main field', '07:00', '09:00', 4, [], true],
  ];

  for (const [role, diamond, stand, site, place, from, to, needed, on, confirmed] of shifts) {
    const [shift] = await query<{ id: string }>(
      `INSERT INTO volunteer_shift
         (tournament_id, role, diamond_id, location_id, site, place, starts_at, ends_at, needed)
       VALUES ($1,$2,$3,$4,$5,$6, ($7 || ' ' || $8)::timestamp, ($7 || ' ' || $9)::timestamp, $10)
       RETURNING id`,
      [tournamentId, role, diamond ? diamondId(diamond) : null, stand ? standId(stand) : null,
        site, place, day, from, to, needed],
    );

    for (const name of on) {
      await query(
        `INSERT INTO volunteer_assignment (shift_id, volunteer_id, assigned_by, confirmed_at)
         VALUES ($1,$2,'Volunteer Coordinator', CASE WHEN $3 THEN now() END)`,
        [shift!.id, ids.get(name), confirmed],
      );
    }
  }

  // Somebody did not turn up to the gate. The shift is short again, which is
  // exactly what has happened to it.
  await query(
    `UPDATE volunteer_assignment a
        SET no_show_at = now(), no_show_by = 'Volunteer Coordinator'
       FROM volunteer_shift s
      WHERE a.shift_id = s.id AND s.tournament_id = $1 AND s.role = 'gate'
        AND a.volunteer_id = $2`,
    [tournamentId, ids.get('Jen Okafor')],
  );
}

/**
 * What the weekend cost, and who we owe.
 *
 * Deliberately mid-weekend and slightly untidy: two shops on the association's
 * card, one a volunteer paid for herself and has not had back, and a freezie
 * marked down on the Sunday because forty of them are left. Each of those is a
 * state a screen exists for, and a demo where the books are square shows none
 * of them.
 */
async function seedPurchasesAndSponsors(tournamentId: string): Promise<void> {
  const stands = await query<{ id: string; name: string }>(
    'SELECT id, name FROM concession_location WHERE tournament_id = $1 ORDER BY name',
    [tournamentId],
  );
  const standId = (name: string) => stands.find((s) => s.name === name)?.id ?? null;

  const shops: [
    description: string,
    supplier: string,
    amount: number,
    daysAgo: number,
    paidBy: string,
    personally: boolean,
    stand: string | null,
  ][] = [
    ['Drinks and snacks for the weekend', 'Costco', 84_350, 3, 'KBA card', false, null],
    ['Buns, condiments, foil trays', 'Costco', 21_180, 3, 'Marion Ellis', true, null],
    ['Ice, three runs', 'Circle K', 4_500, 1, 'Marion Ellis', true, 'Deevy Pines Canteen'],
    ['Coffee and cups', 'Metro', 6_240, 2, 'KBA card', false, 'Tokessy BBQ'],
  ];

  for (const [description, supplier, amount, daysAgo, paidBy, personally, stand] of shops) {
    await query(
      `INSERT INTO concession_purchase
         (tournament_id, location_id, description, supplier, amount_cents, occurred_on,
          paid_by, paid_personally, recorded_by)
       VALUES ($1,$2,$3,$4,$5, current_date - $6::int, $7,$8,'Concession Lead')`,
      [tournamentId, stand ? standId(stand) : null, description, supplier, amount, daysAgo,
        paidBy, personally],
    );
  }

  // One of Marion's two shops has been paid back. The other is the debt the
  // money screen now names her for.
  await query(
    `UPDATE concession_purchase
        SET reimbursed_at = now(), reimbursed_by = 'Tournament Director'
      WHERE tournament_id = $1 AND description = 'Ice, three runs'`,
    [tournamentId],
  );

  // Sunday afternoon, forty freezies left.
  await query(
    `UPDATE concession_item
        SET clearance_price_cents = 50, marked_down_at = now(), marked_down_by = 'Concession Lead'
      WHERE tournament_id = $1 AND name = 'Freezie'`,
    [tournamentId],
  );

  // --- Sponsors --------------------------------------------------------------
  const sponsorRows: [
    name: string,
    pamphlet: string | null,
    contact: string | null,
    email: string | null,
    promised: string | null,
    inPamphlet: boolean,
  ][] = [
    ["Montana's BBQ & Bar", "Montana's BBQ & Bar (Kanata)", 'Dee Fontaine',
      'dee.fontaine@example.com', 'Name in the pamphlet, banner at the main field', true],
    ['Kanata Home Hardware', 'Home Hardware (Kanata) Ltd.', 'Ross Whelan',
      'ross.whelan@example.com', 'Name in the pamphlet', true],
    ['Sens Foundation', null, null, 'community@example.com', 'Name in the pamphlet', false],
    ['The Barrett family', null, 'Alice Barrett', null, 'A mention in the pamphlet', false],
  ];

  for (const [name, pamphlet, contact, email, promised, inPamphlet] of sponsorRows) {
    await query(
      `INSERT INTO sponsor (tournament_id, name, pamphlet_name, contact_name, contact_email,
                            promised, pamphlet_confirmed_at, pamphlet_confirmed_by)
       VALUES ($1,$2,$3,$4,$5,$6,
               CASE WHEN $7 THEN now() END,
               CASE WHEN $7 THEN 'Tournament Director' END)`,
      [tournamentId, name, pamphlet, contact, email, promised, inPamphlet],
    );
  }

  // An auction lot and the gift it came from are the same object described
  // twice — one by the person who took it in, one by the person who put it on
  // a table. Joining them is what lets a letter say "your barbecue raised
  // $320" instead of thanking somebody vaguely for their support.
  await query(
    `UPDATE auction_item i SET gift_id = g.id
       FROM gift_in_kind g
      WHERE g.tournament_id = i.tournament_id
        AND lower(g.donor) = lower(i.donor)
        AND i.gift_id IS NULL
        AND i.tournament_id = $1`,
    [tournamentId],
  );

  // Join the gifts and the cash that already exist to the relationship, so a
  // thank-you letter can say what the gift earned.
  await query(
    `UPDATE gift_in_kind g SET sponsor_id = s.id
       FROM sponsor s
      WHERE s.tournament_id = g.tournament_id AND lower(s.name) LIKE lower(g.donor) || '%'
        AND g.tournament_id = $1`,
    [tournamentId],
  );
  await query(
    `UPDATE revenue_entry r SET sponsor_id = s.id
       FROM sponsor s
      WHERE s.tournament_id = r.tournament_id AND r.stream = 'sponsorship'
        AND lower(r.description) LIKE '%' || lower(s.name) || '%'
        AND r.tournament_id = $1`,
    [tournamentId],
  );
}

/**
 * Entries, caught the morning after they opened.
 *
 * The state worth showing is the awkward one. Entries are open, one division
 * is over its cap, several teams are waiting on a decision, one has paid a
 * deposit by card and one insists they sent an e-transfer nobody can find. A
 * demo where every team has paid and every division has room shows nothing
 * about what these screens are for.
 */
async function seedEntries(tournamentId: string): Promise<void> {
  // Open yesterday evening, closing in a month. So the public page shows the
  // form rather than a countdown, which is the more interesting of the two.
  await query(
    `UPDATE tournament
        SET entries_open_at = (current_date - 1) + time '19:00',
            entries_close_at = (current_date + 30) + time '23:59',
            etransfer_address = 'treasurer@kanatabaseball.com',
            cheque_payable_to = 'Kanata Baseball Association',
            cheque_mail_to = 'PO Box 1247, Kanata ON K2K 0B1',
            balance_due_days = 14,
            default_deposit_cents = 10000,
            default_entry_fee_cents = 70000,
            age_groups = ARRAY['Rookie','Minor','Major','Junior'],
            refund_cutoff_date = current_date + 45,
            refund_policy_note = 'Withdraw after that date and the deposit stays with the '
                                 || 'tournament, because a place was held for you that somebody '
                                 || 'else was turned away from.',
            max_roster_size = 14
      WHERE id = $1`,
    [tournamentId],
  );

  // Real fees for a three-day tournament, and a cap on the division everybody
  // wants.
  await query(
    `UPDATE division SET entry_fee_cents = 70000, deposit_cents = 10000,
                         team_cap = CASE WHEN name = 'Major A' THEN 4 ELSE 8 END
      WHERE tournament_id = $1`,
    [tournamentId],
  );

  const divisions = await query<{ id: string; name: string }>(
    'SELECT id, name FROM division WHERE tournament_id = $1 ORDER BY sort_order, name',
    [tournamentId],
  );
  const divisionId = (name: string) =>
    divisions.find((division) => division.name === name)?.id ?? divisions[0]!.id;

  // The accepted ones name teams that are already in the tournament, and are
  // linked to them, because that is exactly what accepting an entry does.
  const applications: [
    reference: string,
    team: string,
    association: string,
    division: string,
    coach: string,
    email: string,
    phone: string | null,
    ageGroup: string,
    minutesAfterOpen: number,
    status: string,
    notes: string | null,
  ][] = [
    ['TK-3F7K-9QB2', 'Gloucester Major A', 'Gloucester Baseball', 'Major A', 'Dana Whitfield',
      'dana.whitfield@example.com', '+16135550101', 'Major', 1, 'accepted', null],
    ['TK-8HJP-4RT6', 'Orleans Major A', 'Orleans Minor Baseball', 'Major A', 'Marcus Bell',
      'marcus.bell@example.com', '+16135550102', 'Major', 3, 'accepted',
      'We cannot play before noon on the Friday — half the team is at a school trip.'],
    ['TK-2WQD-7NCV', 'Barrhaven Bandits', 'Barrhaven Baseball', 'Major A', 'Priya Raman',
      'priya.raman@example.com', '+16135550103', 'Major', 4, 'submitted', null],
    ['TK-6ZXK-3MPT', 'West Carleton Wolves', 'West Carleton Baseball', 'Major A', 'Tom Reilly',
      'tom.reilly@example.com', null, 'Major', 9, 'submitted',
      'Played in 2019 as West Carleton Red. Same club, new name.'],
    ['TK-9BRT-2KHW', 'Almonte Thunder', 'Mississippi Mills Baseball', 'Major A', 'Jen Okafor',
      'jen.okafor@example.com', '+16135550105', 'Major', 22, 'submitted', null],
    ['TK-4NMC-8VQJ', 'Manotick Minor', 'Rideau Baseball', 'Minor A', 'Ray Deschamps',
      'ray.deschamps@example.com', '+16135550106', 'Minor', 6, 'accepted', null],
    ['TK-7TQV-5DKZ', 'Cumberland Colts', 'Cumberland Baseball', 'Minor A', 'Ellen Novak',
      'ellen.novak@example.com', '+16135550107', 'Minor', 40, 'waitlisted', null],
  ];

  const created = new Map<string, string>();

  for (const [reference, team, association, division, coach, email, phone, ageGroup, minutes,
              status, notes] of applications) {
    const [existing] = await query<{ id: string }>(
      'SELECT id FROM team WHERE tournament_id = $1 AND lower(name) = lower($2)',
      [tournamentId, team],
    );

    const [row] = await query<{ id: string }>(
      `INSERT INTO entry (tournament_id, division_id, team_name, association, coach_name,
                          coach_email, coach_phone, age_group, alternate_name, alternate_contact,
                          notes, reference, submitted_at, status,
                          decided_at, decided_by, balance_due_on, team_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
               (current_date - 1) + time '19:00' + ($13 || ' minutes')::interval,
               $14,
               CASE WHEN $14 <> 'submitted' THEN now() END,
               CASE WHEN $14 <> 'submitted' THEN 'Tournament Director' END,
               CASE WHEN $14 = 'accepted' THEN current_date + 13 END,
               CASE WHEN $14 = 'accepted' THEN $15::uuid END)
       RETURNING id`,
      [tournamentId, divisionId(division), team, association, coach, email, phone, ageGroup,
        // Most entries name a second contact; one deliberately does not, because
        // that is the team HQ cannot reach on the Saturday.
        phone ? 'Chris Lalonde' : null, phone ? '+16135550188' : null,
        notes, reference, String(minutes), status, existing?.id ?? null],
    );
    created.set(reference, row!.id);
  }

  // What has actually arrived. Deliberately uneven: a card deposit, an
  // e-transfer, one team paid in full, and two accepted teams that have not.
  const payments: [reference: string, kind: string, amount: number, method: string, ref: string][] = [
    ['TK-3F7K-9QB2', 'deposit', 20_000, 'card', 'pi_demo_3F7K'],
    ['TK-3F7K-9QB2', 'balance', 50_000, 'etransfer', 'etr-88213'],
    ['TK-8HJP-4RT6', 'deposit', 20_000, 'etransfer', 'etr-88240'],
    ['TK-2WQD-7NCV', 'deposit', 20_000, 'cheque', 'chq-4471'],
    ['TK-4NMC-8VQJ', 'deposit', 20_000, 'card', 'pi_demo_4NMC'],
  ];

  for (const [reference, kind, amount, method, externalRef] of payments) {
    await query(
      `INSERT INTO entry_payment (entry_id, kind, amount_cents, method, external_ref, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [created.get(reference), kind, amount, method,
        externalRef, method === 'card' ? 'stripe webhook' : 'Tournament Director'],
    );
  }

  // One team says they sent an e-transfer that nobody has matched. This is the
  // single most common thing that happens, and the chase list exists for it.
  await query(
    `UPDATE entry SET etransfer_claimed_at = now() - interval '2 days',
                      etransfer_claimed_ref = 'e-transfer sent Tuesday'
      WHERE id = $1`,
    [created.get('TK-6ZXK-3MPT')],
  );

  // And one accepted team is past its balance deadline, which is the state the
  // whole chase list is built around: a place held by money that never came.
  await query(
    `UPDATE entry SET balance_due_on = current_date - 5 WHERE id = $1`,
    [created.get('TK-4NMC-8VQJ')],
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
    ['sponsorship', 'Kanata Home Hardware — pamphlet and banner', 145_000, 0],
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
    // Friday night's takings went home with the treasurer, because the banks
    // are shut and a park is not a safe. It has not been recorded coming back,
    // which is exactly the state the screen exists to make visible.
    ['overnight_out', 'Bev Tokessy', 62_500, 'Tournament Director', 'Concession Lead'],
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

/**
 * A handful of donations, in every state the screens have to cope with.
 *
 * One named and happy to be thanked, one anonymous, one in memory of somebody,
 * one cash in an envelope at the gate — and one that was started on the payment
 * page and never finished, because that row exists in real life and a treasurer
 * matching a provider statement needs to see it counts for nothing.
 */
async function seedDonations(tournamentId: string): Promise<void> {
  interface Gift {
    amount: number;
    name: string | null;
    email: string | null;
    message: string | null;
    show: boolean;
    method: string;
    confirmed: boolean;
    /** CHEO issues the receipts, so a request means an address is needed. */
    receipt?: boolean;
    address?: [line: string, city: string, postal: string];
    sent?: boolean;
  }

  const gifts: Gift[] = [
    {
      amount: 10_000, name: 'The Barrett family', email: 'barretts@example.com',
      message: 'For the cardiology ward. Thank you all.', show: true,
      method: 'card', confirmed: true,
      receipt: true, address: ['118 Weslock Way', 'Kanata', 'K2K 3G4'],
    },
    { amount: 2_500, name: null, email: null, message: null, show: false, method: 'card', confirmed: true },
    {
      amount: 25_000, name: 'Kanata Home Hardware', email: 'giving@example.com',
      message: 'In memory of Scott.', show: true, method: 'card', confirmed: true,
      receipt: true, address: ['499 Terry Fox Drive', 'Kanata', 'K2T 1H7'], sent: true,
    },
    {
      amount: 5_000, name: 'A grandparent at Deevy Pines', email: null, message: null,
      show: true, method: 'cash', confirmed: true,
    },
    // Asked for a receipt on a phone at the gate and did not fill the address
    // in. The receipts screen exists to surface exactly this before the batch
    // goes to CHEO, rather than after.
    {
      amount: 7_500, name: 'Devon Marchand', email: 'devon@example.com', message: null,
      show: false, method: 'etransfer', confirmed: true, receipt: true,
    },
    // Opened the payment page on a phone with one bar and never came back.
    { amount: 5_000, name: 'Someone', email: null, message: null, show: false, method: 'card', confirmed: false },
  ];

  for (const gift of gifts) {
    await query(
      `INSERT INTO donation
         (tournament_id, amount_cents, donor_name, donor_email, message, show_publicly,
          method, external_ref, confirmed_at, recorded_by,
          receipt_requested, address_line, address_city, address_province, address_postal,
          receipt_sent_at, receipt_sent_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $9 THEN now() END, $10,
               $11,$12,$13,$14,$15,
               CASE WHEN $16 THEN now() END, CASE WHEN $16 THEN 'Tournament Treasurer' END)`,
      [
        tournamentId, gift.amount, gift.name, gift.email, gift.message, gift.show, gift.method,
        gift.confirmed && gift.method === 'card'
          ? `demo_${gift.amount}_${gift.name ?? 'anon'}`
          : null,
        gift.confirmed,
        gift.method === 'card' ? 'public donate page' : 'Tournament Director',
        gift.receipt ?? false,
        gift.address?.[0] ?? null,
        gift.address?.[1] ?? null,
        gift.address ? 'Ontario' : null,
        gift.address?.[2] ?? null,
        gift.sent ?? false,
      ],
    );
  }
}

/**
 * The website's own content.
 *
 * The facts here are the tournament's real ones — the year it started, why it
 * exists, the format, the diamonds. The email addresses are deliberately role
 * addresses rather than the real volunteers' personal inboxes: a demo that gets
 * shown around a committee table and pushed to a public repository should not
 * carry somebody's private email, even one that is already on their own site.
 *
 * The honour roll is deliberately thin — three years, not twenty-nine. Making
 * up twenty-six years of champions would fill the page with fiction that looks
 * exactly like a record, and somebody would eventually cite it.
 */
async function seedWebsite(tournamentId: string): Promise<void> {
  await query(
    `UPDATE tournament
        SET tagline = $2, established_year = 1996, total_raised_cents = $3,
            venue_city = 'Kanata, Ontario',
            contact_general = 'tournament@example.com',
            contact_entries = 'entries@example.com',
            contact_sponsors = 'sponsors@example.com',
            contact_volunteers = 'volunteers@example.com'
      WHERE id = $1`,
    [
      tournamentId,
      "Canada's largest Little League charity tournament, run entirely by volunteers.",
      53_600_000,
    ],
  );

  // Addresses for the sites, so a coach driving in has something to type into a
  // phone. Only the ones the demo's diamonds use.
  const addresses: [site: string, address: string][] = [
    ['Tokessy', 'Scott Tokessy Field, Kanata, ON'],
    ['Deevy Pines', 'Deevy Pines Park, Kanata, ON'],
    ['Walter Baker', 'Walter Baker Park, Kanata, ON'],
    ['Mike Channing', 'Mike Channing Park, Kanata, ON'],
  ];
  for (const [site, address] of addresses) {
    await query(
      `UPDATE diamond SET address = $3,
              map_url = COALESCE(map_url, 'https://maps.google.com/?q=' || replace($3, ' ', '+'))
        WHERE tournament_id = $1 AND site = $2`,
      [tournamentId, site, address],
    );
  }

  const pages: [
    slug: string,
    title: string,
    summary: string | null,
    group: string | null,
    order: number,
    published: boolean,
    body: string,
  ][] = [
    [
      'welcome',
      'Welcome',
      null,
      null,
      10,
      true,
      `Run entirely by volunteers since 1996, in memory of Scott Tokessy. Every dollar raised
goes to the Cardiology department at the [Children's Hospital of Eastern Ontario](https://www.cheo.on.ca).

All teams play Friday and Saturday, with playoffs on the Sunday. [Scott's story](/p/scotts-story)
is why any of this happens.`,
    ],
    [
      'scotts-story',
      "Scott's story",
      'Why this tournament exists.',
      'about',
      10,
      true,
      `The tournament was founded in 1996 in memory of Scott, a twelve-year-old boy from Kanata
who died suddenly of an irregular heartbeat after hitting a home run for his house league team,
in May of that year.

Every year since, teams have gathered at Scott Tokessy field to play in his honour. It has grown
into the largest Little League tournament in the region, and every dollar it raises goes directly
to the CHEO Cardiology department — towards the equipment used to find heart conditions in
children, and the research into treating them.

The Tokessy family still help plan the tournament. You will find them at the main field, watching
the games.

> To this day it is run entirely by volunteers. There is no paid staff at all.`,
    ],
    [
      'tournament-info',
      'Tournament information',
      'Format, divisions and what a team gets.',
      'play',
      10,
      true,
      `## The weekend

All teams play **Friday and Saturday**, with playoffs running on **Sunday**. Games are spread
across several diamonds in Kanata — see [contact and directions](/contact) for where.

## Divisions

Rookie, Minor, Major and Junior, each with an A and a B division. Minor and Major also run an
All Star division, and there is a Girls division at Minor, Major and Junior level.

Teams are placed by the division they play in at home. If you are unsure which fits, ask before
you enter rather than after — moving a team after the schedule is drawn affects everybody in
the pool.

## What a team gets

- A guaranteed number of games — see the rules for your division
- Concession tickets for every player in the team package
- Their own live page showing only that team's games, times and diamonds

## Rules

Each division has its own time limit, run rule and pitching restrictions.
[The rules for every division](/p/rules) are published before the weekend, and the umpires
work from the same page you do.`,
    ],
    [
      'rules',
      'Rules',
      'Time limits, run rules and pitching, by division.',
      'play',
      20,
      true,
      `Each division's rules are set before the tournament and checked against that year's
official documents. They are shown on every umpire's own page and on the standings for the
division, so the person calling a game and the person watching it are reading the same thing.

The rules that vary by division:

1. **Time limit** — how long before no new inning starts
2. **Run rule** — the margin at which a game is called, and from which inning
3. **Pitching** — pitch counts and required rest
4. **Tie-breaking** — how a pool is separated when records match

Where a rule is not listed for a division, the governing body's standard rule applies.

If you think a rule has been applied wrongly during the weekend, tell the site supervisor at
that diamond rather than the umpire. Every score has a written trail behind it, and a genuine
mistake can be corrected — but not from memory, three hours later.`,
    ],
    [
      'visiting',
      'Visiting Kanata',
      'Hotels, food and something to do between games.',
      'play',
      30,
      true,
      `Teams travel in from across Ontario and Quebec, and most stay the weekend.

## Staying

Several hotels near the diamonds offer a tournament rate. Ask when booking — the rate is not
always applied automatically.

## Between games

There is usually three or four hours between a team's games. The main field has a canteen and a
barbecue running all weekend, and the silent auction table is worth a look on the Saturday.

## Food

Every canteen is run by volunteers and every dollar it takes goes to the ward. The barbecue at
the main field is supplied by a local restaurant who donate the food outright, which means the
whole of what it sells goes to CHEO.`,
    ],
    [
      'sponsors-intro',
      'About our sponsors',
      null,
      null,
      50,
      true,
      `This tournament runs on donated food, donated prizes, donated printing and donated time.
Every business below gave something, and every dollar it saved went to the ward instead.

Sponsorship here is mostly in kind, and every arrangement is its own conversation. If your
business would like to help, we would be glad to hear from you.`,
    ],
    [
      'volunteer-intro',
      'About volunteering',
      null,
      null,
      50,
      true,
      `Most shifts are two to four hours. You do not need to know baseball, and you do not need
to commit to the whole weekend.

The jobs that are hardest to fill are the early ones — somebody has to line and rake the
diamonds before anybody can play on them — and the site supervisors, who collect the signed
scoresheets and text the results in. Both are more important than they sound and neither needs
any experience.`,
    ],
    [
      'opening-ceremonies',
      'Opening ceremonies',
      'Saturday, 10am, at the main field.',
      'about',
      20,
      true,
      `Opening ceremonies are at **10am on the Saturday** at the main field.

The Gold Glove is drawn there — one player, at random, from every registered roster — and the
cheque for this year's fundraising is presented. Because there are games on the Friday, the
Saturday and the Sunday, the figure on that cheque is an estimate of where the weekend is
heading rather than a final total.

Everybody is welcome, whether your team is playing that morning or not.`,
    ],
  ];

  for (const [slug, title, summary, group, order, published, body] of pages) {
    await query(
      `INSERT INTO site_page
         (tournament_id, slug, title, summary, body, nav_group, nav_order, published, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Tournament Director')`,
      [tournamentId, slug, title, summary, body.trim(), group, order, published],
    );
  }

  // A draft, so the screen shows what one looks like and the public site does
  // not.
  await query(
    `INSERT INTO site_page (tournament_id, slug, title, summary, body, nav_group, nav_order, published, updated_by)
     VALUES ($1, 'next-year', 'Next year', 'Being written.', $2, 'about', 90, false, 'Tournament Director')`,
    [tournamentId, 'Dates for next year will be confirmed in the autumn.'],
  );

  // Three years of the roll. Deliberately not twenty-nine: inventing the rest
  // would fill a page with fiction that looks exactly like a record.
  const years: [year: number, edition: string, teams: number, raised: number][] = [
    [2024, '27th', 68, 3_800_000],
    [2025, '28th', 74, 3_000_000],
    [2026, '29th', 90, 4_500_000],
  ];
  for (const [year, edition, teams, raised] of years) {
    await query(
      `INSERT INTO past_year (tournament_id, year, edition, teams, raised_cents)
       VALUES ($1,$2,$3,$4,$5)`,
      [tournamentId, year, edition, teams, raised],
    );
  }

  const champions: [year: number, division: string, champion: string, runnerUp: string][] = [
    [2026, 'Major A', 'Kanata Major A', 'Nepean Major A'],
    [2026, 'Major B', 'Orleans Major B', 'Gloucester Major B'],
    [2026, 'Minor A', 'West Ottawa Minor A', 'Kanata Minor A'],
    [2026, 'Junior A', 'Perth Junior A', 'Stittsville Junior A'],
    [2025, 'Major A', 'Nepean Major A', 'Kanata Major A'],
    [2025, 'Minor A', 'Kanata Minor A', 'Orleans Minor A'],
    [2024, 'Major A', 'Gloucester Major A', 'West Ottawa Major A'],
  ];
  for (const [index, [year, division, champion, runnerUp]] of champions.entries()) {
    await query(
      `INSERT INTO past_champion
         (tournament_id, year, division_name, champion, runner_up, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [tournamentId, year, division, champion, runnerUp, index],
    );
  }

  // Sponsors who agreed to be named. The others stay hidden, which is the
  // default and is the state worth demonstrating.
  await query(
    `UPDATE sponsor SET show_publicly = true,
            tier = CASE WHEN name ILIKE '%Montana%' THEN 'Food and drink' ELSE NULL END,
            blurb = CASE
              WHEN name ILIKE '%Montana%'
                THEN 'Supplies the barbecue at the main field. The food is given outright, so every dollar it sells for goes to the ward.'
              ELSE NULL END
      WHERE tournament_id = $1 AND name NOT ILIKE '%anonymous%'`,
    [tournamentId],
  );
}
