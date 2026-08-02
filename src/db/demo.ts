import { closePool, query, transaction } from './client';
import { MAJOR_2026_RULES } from '@/domain/divisionRules';
import { hashPin } from '@/server/auth';
import { importSchedule } from '@/domain/schedule/import';
import { applySchedule } from '@/server/scheduleStore';
import { approveScore, parkUnmatchedMessage, recordProposal, setDispute } from '@/server/repo';
import { addMinutes, formatDate, formatTime, toWallClock } from '@/domain/time';

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

const STAFF: [string, 'director' | 'hq' | 'volunteer_coordinator' | 'auction_lead', string][] = [
  ['Tournament Director', 'director', '4021'],
  ['HQ Desk 1', 'hq', '5150'],
  ['HQ Desk 2', 'hq', '6274'],
  ['Volunteer Coordinator', 'volunteer_coordinator', '7318'],
  ['Auction Lead', 'auction_lead', '8493'],
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

async function main() {
  const existing = await query('SELECT id FROM tournament');
  if (existing.length > 0) {
    console.log(
      'This database already has a tournament.\n' +
        'The demo needs an empty one, and a tournament with history cannot be\n' +
        'deleted (events are append-only, by design). To reset:\n\n' +
        '  dropdb tokessy && createdb tokessy && npm run migrate && npm run demo\n',
    );
    return;
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
      await client.query(
        'INSERT INTO staff_member (tournament_id, name, role, pin_hash) VALUES ($1, $2, $3, $4)',
        [id, name, role, await hashPin(pin)],
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
    console.error('Demo schedule failed to import:', parsed.issues);
    return;
  }

  const applied = await applySchedule(tournamentId, parsed.games, 'demo', 'system');

  const idOf = async (externalGameId: string) =>
    (
      await query<{ id: string }>('SELECT id FROM game WHERE external_game_id = $1', [externalGameId])
    )[0]!.id;
  const teamId = async (name: string) =>
    (await query<{ id: string }>('SELECT id FROM team WHERE name = $1', [name]))[0]!.id;

  // Coach numbers, so team notifications have somewhere to go and the unmatched
  // screen can tell HQ whose number an orphan text belongs to.
  await query(
    `UPDATE team SET coach_phone = '+1613555' || lpad((row_number)::text, 4, '0')
       FROM (SELECT id, row_number() OVER (ORDER BY name) FROM team) AS numbered
      WHERE team.id = numbered.id`,
  );

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
        reportedBy: '+16135550118',
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
        reportedBy: '+16135550143',
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

  const [division] = await query<{ id: string }>(
    "SELECT id FROM division WHERE name = 'Major A'",
  );
  const [team] = await query<{ access_token: string }>(
    "SELECT access_token FROM team WHERE name = 'Nepean Major A'",
  );

  console.log(`\nDemo ready — ${applied.created} games, ${applied.teamsCreated.length} teams.`);
  console.log(`Dates: ${yesterday} (complete) → ${today} (live) → ${tomorrow}\n`);
  console.log('Staff PINs:');
  for (const [name, , pin] of STAFF) console.log(`  ${name.padEnd(24)} ${pin}`);
  console.log('\nWorth looking at:');
  console.log('  /hq                       the board, mid-Saturday');
  console.log('  /hq/queue                 two scores waiting, one the parser is unsure of');
  console.log('  /hq/unmatched             two texts nobody could place');
  console.log(`  /standings/${division!.id}`);
  console.log('                            a three-way tie broken on runs allowed');
  console.log(`  /team/${team!.access_token}`);
  console.log("                            what a coach's link looks like\n");
}

async function coachPhone(teamName: string): Promise<string> {
  const [row] = await query<{ coach_phone: string }>(
    'SELECT coach_phone FROM team WHERE name = $1',
    [teamName],
  );
  return row?.coach_phone ?? '+16135550000';
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  })
  .finally(() => closePool());
