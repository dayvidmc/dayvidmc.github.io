import { minutesBetween } from './time';

/**
 * Turning "kanata 12 orleans 5" into a proposed score (§5.2).
 *
 * The spec calls for an LLM here, and there is one — see `src/server/scoreParser.ts`.
 * This module is the deterministic pass that runs *first*, for two reasons:
 *
 *   1. "Fail safe, not broken." If the Anthropic API is slow or down at 6pm on
 *      Saturday, score intake must keep working. Most replies are "12-5" or
 *      "Kanata 12 Orleans 5" and need no model at all.
 *   2. Running costs come out of donation dollars (§11). Not spending a token
 *      on the eighty replies that parse with a regex is free money for CHEO.
 *
 * Anything this pass cannot read confidently falls through to the model, and
 * anything the model cannot read lands in the queue with the raw text showing,
 * for a human at HQ to read. Every path ends at a person.
 */

export interface CandidateGame {
  gameId: string;
  /** The director's game number, e.g. "MA-01" — volunteers often quote it. */
  externalGameId: string;
  homeTeamId: string;
  homeTeamName: string;
  awayTeamId: string;
  awayTeamName: string;
  /** Tournament-local wall clock. */
  scheduledStart: Date;
}

export interface ParsedScore {
  gameId: string | null;
  homeRuns: number | null;
  awayRuns: number | null;
  resultKind: 'played' | 'forfeit';
  forfeitedByTeamId: string | null;
  /** 0..1. Below `AUTO_FILL_CONFIDENCE` the queue shows the raw text instead. */
  confidence: number;
  /** Shown to HQ so a human can see why the machine read it this way. */
  reasoning: string;
}

/** At or above this, the queue pre-fills the score. Below it, a human reads the text. */
export const AUTO_FILL_CONFIDENCE = 0.8;

/**
 * Words that appear in nearly every team name here and therefore identify
 * nobody. What distinguishes a team is its association: Kanata, Orleans,
 * Nepean, Stittsville.
 */
const GENERIC_TEAM_WORDS = new Set([
  'major', 'minor', 'rookie', 'junior', 'girls', 'boys', 'team', 'all', 'star',
  'allstar', 'all-star', 'stars', 'a', 'b', 'aa', 'bb', 'red', 'blue', 'black',
  'white', 'green', 'gold', 'grey', 'gray',
]);

const FORFEIT_PATTERN = /\b(forfeit(?:ed|s)?|ff|no[\s-]?show|defaulted?)\b/i;

function normalise(text: string): string {
  return text.toLowerCase().replace(/[’']/g, '');
}

/** Tokens that actually identify this team, longest first. */
function distinctiveTokens(teamName: string): string[] {
  return normalise(teamName)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !GENERIC_TEAM_WORDS.has(token))
    .sort((a, b) => b.length - a.length);
}

/** Earliest position at which this team is named, or -1. */
function mentionIndex(haystack: string, teamName: string): number {
  let best = -1;
  for (const token of distinctiveTokens(teamName)) {
    const index = haystack.indexOf(token);
    if (index >= 0 && (best === -1 || index < best)) best = index;
  }
  return best;
}

interface NumberToken {
  value: number;
  index: number;
}

/**
 * Pull the run totals out, after removing things that look like numbers but
 * are not scores: clock times, dates, and the director's game numbers.
 */
function extractNumbers(text: string, externalGameIds: readonly string[]): NumberToken[] {
  let masked = text;

  // Game numbers first — "MA-01" would otherwise contribute a 1.
  for (const id of externalGameIds) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    masked = masked.replace(new RegExp(escaped, 'gi'), (match) => ' '.repeat(match.length));
  }

  // Clock times: 10:30, 2:30pm, 1030am.
  masked = masked.replace(/\b\d{1,2}:\d{2}\s*(?:am|pm)?\b/gi, (m) => ' '.repeat(m.length));
  masked = masked.replace(/\b\d{3,4}\s*(?:am|pm)\b/gi, (m) => ' '.repeat(m.length));
  // Dates: 2027-07-24, 07/24.
  masked = masked.replace(/\b\d{4}-\d{2}-\d{2}\b/g, (m) => ' '.repeat(m.length));
  masked = masked.replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, (m) => ' '.repeat(m.length));

  const numbers: NumberToken[] = [];
  // Two digits is plenty: nobody scores 100 runs, and a longer run of digits is
  // a phone number or a typo, not a score.
  const pattern = /\b(\d{1,2})\b/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(masked)) !== null) {
    numbers.push({ value: Number(match[1]), index: match.index });
  }
  return numbers;
}

/**
 * Pick the game a message is about.
 *
 * Preference order: an explicit game number, then a team named in the text,
 * then the game on that diamond whose scheduled start is nearest to now.
 */
export function matchGame(
  text: string,
  candidates: readonly CandidateGame[],
  now: Date,
): { game: CandidateGame; confidence: number; reason: string } | null {
  if (candidates.length === 0) return null;

  const haystack = normalise(text);

  const byGameId = candidates.find((c) =>
    haystack.includes(normalise(c.externalGameId)),
  );
  if (byGameId) {
    return { game: byGameId, confidence: 1, reason: `quoted game ${byGameId.externalGameId}` };
  }

  const namedMatches = candidates.filter(
    (c) => mentionIndex(haystack, c.homeTeamName) >= 0 || mentionIndex(haystack, c.awayTeamName) >= 0,
  );
  if (namedMatches.length === 1) {
    const game = namedMatches[0]!;
    return { game, confidence: 0.95, reason: 'a team in the message plays in this game' };
  }
  if (namedMatches.length > 1) {
    // Two candidate games mention a named team — prefer the one where both
    // teams are named, otherwise fall through to timing.
    const bothNamed = namedMatches.filter(
      (c) => mentionIndex(haystack, c.homeTeamName) >= 0 && mentionIndex(haystack, c.awayTeamName) >= 0,
    );
    if (bothNamed.length === 1) {
      return { game: bothNamed[0]!, confidence: 0.95, reason: 'both teams named in the message' };
    }
  }

  const pool = namedMatches.length > 0 ? namedMatches : candidates;
  const nearest = [...pool].sort(
    (a, b) =>
      Math.abs(minutesBetween(a.scheduledStart, now)) - Math.abs(minutesBetween(b.scheduledStart, now)),
  )[0]!;

  // One unambiguous game on this diamond is a safe read; several is a guess.
  const confidence = pool.length === 1 ? 0.9 : 0.5;
  return {
    game: nearest,
    confidence,
    reason:
      pool.length === 1
        ? 'the only game in scope'
        : `nearest scheduled start (${pool.length} games in scope, so this is a guess)`,
  };
}

/**
 * Read a score out of a text message.
 *
 * Returns `null` only when there is nothing score-shaped in the message at all.
 * Everything else comes back with a confidence, because a low-confidence
 * proposal a human glances at is far better than a dropped message.
 */
export function parseScoreText(
  text: string,
  candidates: readonly CandidateGame[],
  now: Date,
): ParsedScore | null {
  const matched = matchGame(text, candidates, now);
  if (!matched) return null;

  const { game } = matched;
  const haystack = normalise(text);
  const notes: string[] = [matched.reason];

  const forfeit = FORFEIT_PATTERN.test(text);
  const numbers = extractNumbers(haystack, candidates.map((c) => c.externalGameId));

  if (forfeit) {
    // Which side forfeited is exactly the sort of thing to hand to a person:
    // it changes who advances and cannot be undone by a standings recalc.
    const homeIndex = mentionIndex(haystack, game.homeTeamName);
    const awayIndex = mentionIndex(haystack, game.awayTeamName);
    const forfeitIndex = haystack.search(FORFEIT_PATTERN);

    let forfeitedByTeamId: string | null = null;
    if (homeIndex >= 0 && awayIndex < 0) forfeitedByTeamId = game.homeTeamId;
    else if (awayIndex >= 0 && homeIndex < 0) forfeitedByTeamId = game.awayTeamId;
    else if (homeIndex >= 0 && awayIndex >= 0 && forfeitIndex >= 0) {
      // Whichever team is named closest before the word "forfeit".
      const homeDistance = forfeitIndex - homeIndex;
      const awayDistance = forfeitIndex - awayIndex;
      const homeCloser =
        homeDistance >= 0 && (awayDistance < 0 || homeDistance < awayDistance);
      forfeitedByTeamId = homeCloser ? game.homeTeamId : game.awayTeamId;
    }

    notes.push(
      forfeitedByTeamId
        ? 'read as a forfeit'
        : 'read as a forfeit, but the message does not say which team forfeited',
    );

    return {
      gameId: game.gameId,
      homeRuns: null,
      awayRuns: null,
      resultKind: 'forfeit',
      forfeitedByTeamId,
      // Never auto-fill a forfeit. A director signs off on these.
      confidence: Math.min(matched.confidence, forfeitedByTeamId ? 0.6 : 0.3),
      reasoning: notes.join('; '),
    };
  }

  if (numbers.length < 2) {
    return {
      gameId: game.gameId,
      homeRuns: null,
      awayRuns: null,
      resultKind: 'played',
      forfeitedByTeamId: null,
      confidence: 0.2,
      reasoning: `${notes.join('; ')}; could not find two run totals in the message`,
    };
  }

  const homeIndex = mentionIndex(haystack, game.homeTeamName);
  const awayIndex = mentionIndex(haystack, game.awayTeamName);

  let homeRuns: number;
  let awayRuns: number;
  let scoreConfidence: number;

  if (homeIndex >= 0 && awayIndex >= 0) {
    // Both named: each team's score is the number nearest after its name.
    const homeNumber = nearestNumberAfter(numbers, homeIndex) ?? numbers[0]!;
    const awayNumber = nearestNumberAfter(numbers, awayIndex) ?? numbers[1]!;

    if (homeNumber.index === awayNumber.index) {
      // Both teams resolved to the same number — fall back to text order.
      const ordered = homeIndex < awayIndex;
      homeRuns = (ordered ? numbers[0] : numbers[1])!.value;
      awayRuns = (ordered ? numbers[1] : numbers[0])!.value;
      scoreConfidence = 0.7;
      notes.push('both teams named; scores assigned by the order they appear');
    } else {
      homeRuns = homeNumber.value;
      awayRuns = awayNumber.value;
      scoreConfidence = 0.95;
      notes.push('both teams named, each with its own number');
    }
  } else if (homeIndex >= 0 || awayIndex >= 0) {
    const namedIsHome = homeIndex >= 0;
    const nameIndex = namedIsHome ? homeIndex : awayIndex;
    const first = nearestNumberAfter(numbers, nameIndex) ?? numbers[0]!;
    const other = numbers.find((n) => n.index !== first.index) ?? numbers[1]!;

    homeRuns = namedIsHome ? first.value : other.value;
    awayRuns = namedIsHome ? other.value : first.value;
    scoreConfidence = 0.8;
    notes.push(
      `only ${namedIsHome ? game.homeTeamName : game.awayTeamName} is named; ` +
        `their score read as ${first.value}`,
    );
  } else {
    // Bare "12-5". The request text asks for the home team first, so that is
    // the reading — but it is a convention, not a statement, so it stays below
    // the auto-fill threshold and a human confirms.
    homeRuns = numbers[0]!.value;
    awayRuns = numbers[1]!.value;
    scoreConfidence = 0.5;
    notes.push('no team named; assumed home team first, as the request asks');
  }

  if (numbers.length > 2) {
    scoreConfidence = Math.min(scoreConfidence, 0.6);
    notes.push(`${numbers.length} numbers in the message, so the reading is uncertain`);
  }

  return {
    gameId: game.gameId,
    homeRuns,
    awayRuns,
    resultKind: 'played',
    forfeitedByTeamId: null,
    confidence: Math.min(matched.confidence, scoreConfidence),
    reasoning: notes.join('; '),
  };
}

function nearestNumberAfter(numbers: readonly NumberToken[], index: number): NumberToken | undefined {
  return numbers.find((n) => n.index > index);
}
