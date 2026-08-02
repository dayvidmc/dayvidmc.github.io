import { randomInt } from 'node:crypto';
import { closePool, query, transaction } from './client';
import { MAJOR_2026_RULES } from '@/domain/divisionRules';
import { hashPin } from '@/server/auth';
import { importSchedule } from '@/domain/schedule/import';
import { applySchedule } from '@/server/scheduleStore';

/**
 * Development seed: a plausible 2027 tournament to click around in.
 *
 * Not production data. The real divisions carry rules from seven separate
 * published PDFs, and every one of them needs a human to enter it — the values
 * here are Major's, copied across, and every division is left
 * `rules_reviewed = false` to say so.
 */

const DIVISIONS = [
  'Rookie',
  'Minor',
  'Minor Girls',
  'Major A',
  'Major B',
  'Major Girls',
  'Junior',
  'Junior Girls',
];

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

const STAFF: [string, 'director' | 'hq' | 'volunteer_coordinator' | 'auction_lead'][] = [
  ['Tournament Director', 'director'],
  ['HQ Desk 1', 'hq'],
  ['HQ Desk 2', 'hq'],
  ['Volunteer Coordinator', 'volunteer_coordinator'],
  ['Auction Lead', 'auction_lead'],
];

/** A four-team pool that exercises the tiebreaker paths worth seeing. */
const SAMPLE_SCHEDULE = `division,pool,game_id,date,start_time,diamond,home_team,away_team,game_type
Major A,Pool 1,MA-01,2027-07-23,09:00,Deevy Pines 1,Kanata Major A,Orleans Major A,round robin
Major A,Pool 1,MA-02,2027-07-23,11:15,Deevy Pines 1,Nepean Major A,Gloucester Major A,round robin
Major A,Pool 1,MA-03,2027-07-23,13:30,Deevy Pines 1,Kanata Major A,Nepean Major A,round robin
Major A,Pool 1,MA-04,2027-07-23,15:45,Deevy Pines 1,Orleans Major A,Gloucester Major A,round robin
Major A,Pool 1,MA-05,2027-07-24,09:00,Deevy Pines 2,Kanata Major A,Gloucester Major A,round robin
Major A,Pool 1,MA-06,2027-07-24,11:15,Deevy Pines 2,Nepean Major A,Orleans Major A,round robin
Major A,Pool 1,MA-07,2027-07-25,10:00,Tokessy,TBD Seed 1,TBD Seed 4,playoff
Major A,Pool 1,MA-08,2027-07-25,12:15,Tokessy,TBD Seed 2,TBD Seed 3,playoff
Rookie,Pool 1,RK-01,2027-07-23,09:00,Tokessy,Kanata Rookie,Stittsville Rookie,round robin
Rookie,Pool 1,RK-02,2027-07-23,11:15,Tokessy,Barrhaven Rookie,Nepean Rookie,round robin
Rookie,Pool 1,RK-03,2027-07-24,09:00,Kinsmen,Kanata Rookie,Barrhaven Rookie,round robin
Rookie,Pool 1,RK-04,2027-07-24,11:15,Kinsmen,Stittsville Rookie,Nepean Rookie,round robin`;

async function main() {
  const existing = await query<{ id: string }>('SELECT id FROM tournament WHERE year = 2027');
  if (existing.length > 0) {
    console.log('2027 tournament already seeded. Nothing to do.');
    return;
  }

  const pins: [string, string][] = [];

  const tournamentId = await transaction(async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO tournament (name, year, starts_on, ends_on)
       VALUES ($1, 2027, '2027-07-23', '2027-07-25') RETURNING id`,
      ['30th Annual Scott Tokessy Memorial Gold Glove Tournament'],
    );
    const id = inserted.rows[0]!.id;

    for (const [index, name] of DIVISIONS.entries()) {
      await client.query(
        `INSERT INTO division (tournament_id, name, sort_order, rules, rules_reviewed)
         VALUES ($1, $2, $3, $4::jsonb, false)`,
        [id, name, index, JSON.stringify(MAJOR_2026_RULES)],
      );
    }

    for (const [name, site] of DIAMONDS) {
      await client.query('INSERT INTO diamond (tournament_id, name, site) VALUES ($1, $2, $3)', [
        id,
        name,
        site,
      ]);
    }

    for (const [name, role] of STAFF) {
      // Random rather than a fixed 1234, so a seeded dev box is never a
      // shortcut into anything that later holds real data.
      const pin = String(randomInt(1000, 10000));
      pins.push([name, pin]);
      await client.query(
        'INSERT INTO staff_member (tournament_id, name, role, pin_hash) VALUES ($1, $2, $3, $4)',
        [id, name, role, await hashPin(pin)],
      );
    }

    return id;
  });

  const parsed = importSchedule(SAMPLE_SCHEDULE, {
    rulesByDivision: Object.fromEntries(DIVISIONS.map((name) => [name, MAJOR_2026_RULES])),
  });

  if (!parsed.importable) {
    console.error('Sample schedule failed to parse:', parsed.issues);
  } else {
    const applied = await applySchedule(tournamentId, parsed.games, 'seed', 'system');
    console.log(
      `Seeded ${applied.created} games, ${applied.teamsCreated.length} teams, ` +
        `${DIVISIONS.length} divisions, ${DIAMONDS.length} diamonds.`,
    );
    if (parsed.warningCount > 0) {
      console.log(`(${parsed.warningCount} schedule warning(s) — expected in sample data.)`);
    }
  }

  console.log('\nStaff PINs — development only:');
  for (const [name, pin] of pins) console.log(`  ${name.padEnd(24)} ${pin}`);
  console.log('\nEvery division is marked rules_reviewed = false. They hold Major\'s numbers.');
  console.log('Enter each division\'s real rules from its published PDF before any live use.\n');
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closePool());
