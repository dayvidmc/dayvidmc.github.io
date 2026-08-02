import {
  AUTO_FILL_CONFIDENCE,
  parseScoreText,
  type CandidateGame,
  type ParsedScore,
} from '@/domain/scoreParsing';
import { formatTimeFriendly } from '@/domain/time';

/**
 * Score parsing, server side only (§11).
 *
 * The order here is deliberate and is the "fail safe, not broken" principle in
 * code:
 *
 *   1. Try the deterministic parser. Most replies are "12-5" or
 *      "Kanata 12 Orleans 5" and need nothing more.
 *   2. If it is not confident, ask the model, giving it that diamond's
 *      scheduled games as context.
 *   3. If the model is unavailable, slow, or returns nonsense, keep the
 *      deterministic reading — with its low confidence intact, so the queue
 *      shows a human the raw text.
 *
 * Nothing is ever dropped. Every path ends in a row in the approval queue.
 */

export interface ParseOutcome extends ParsedScore {
  /** Which pass produced this: useful when tuning, and shown in the queue. */
  parserModel: string | null;
}

const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5';
const TIMEOUT_MS = Number(process.env.SCORE_PARSER_TIMEOUT_MS ?? 6_000);

export async function parseScoreMessage(
  text: string,
  candidates: readonly CandidateGame[],
  now: Date,
): Promise<ParseOutcome | null> {
  const deterministic = parseScoreText(text, candidates, now);

  // Confident local read, or nothing to match against: no reason to spend a
  // token. Running costs come out of donation dollars.
  if (!deterministic) return null;
  if (deterministic.confidence >= AUTO_FILL_CONFIDENCE && deterministic.homeRuns !== null) {
    return { ...deterministic, parserModel: null };
  }

  const fromModel = await askModel(text, candidates, now).catch((error) => {
    console.error('[scoreParser] model call failed, keeping local reading', error);
    return null;
  });

  if (!fromModel) return { ...deterministic, parserModel: null };

  // Trust whichever pass is more sure of itself, but never let the model push a
  // forfeit past the human gate.
  if (fromModel.resultKind === 'forfeit') {
    fromModel.confidence = Math.min(fromModel.confidence, 0.6);
  }
  return fromModel.confidence >= deterministic.confidence
    ? fromModel
    : { ...deterministic, parserModel: null };
}

interface AnthropicResponse {
  content?: { type: string; text?: string }[];
}

async function askModel(
  text: string,
  candidates: readonly CandidateGame[],
  now: Date,
): Promise<ParseOutcome | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || candidates.length === 0) return null;

  const roster = candidates
    .map(
      (c) =>
        `- game_id: ${c.gameId} | number: ${c.externalGameId} | ` +
        `${formatTimeFriendly(c.scheduledStart)} | home: ${c.homeTeamName} | away: ${c.awayTeamName}`,
    )
    .join('\n');

  const prompt =
    `A volunteer at a youth baseball tournament sent this text message reporting a score:\n\n` +
    `"""${text}"""\n\n` +
    `These are the games they could be reporting on:\n${roster}\n\n` +
    `Return ONLY a JSON object, no prose, with these keys:\n` +
    `  game_id: string — which game, from the list above\n` +
    `  home_runs: integer or null\n` +
    `  away_runs: integer or null\n` +
    `  result_kind: "played" or "forfeit"\n` +
    `  forfeited_by: "home" | "away" | null\n` +
    `  confidence: number between 0 and 1\n` +
    `  reasoning: one short sentence explaining your reading\n\n` +
    `Assign runs to the correct side — the message may name either team first. ` +
    `If you are unsure, say so with a low confidence rather than guessing; a human ` +
    `reviews anything below ${AUTO_FILL_CONFIDENCE}.`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.error('[scoreParser] model returned', response.status);
      return null;
    }

    const body = (await response.json()) as AnthropicResponse;
    const raw = body.content?.find((part) => part.type === 'text')?.text ?? '';
    return interpret(raw, candidates, now);
  } finally {
    clearTimeout(timer);
  }
}

/** Read the model's JSON, rejecting anything that does not match a real game. */
function interpret(
  raw: string,
  candidates: readonly CandidateGame[],
  now: Date,
): ParseOutcome | null {
  const match = /\{[\s\S]*\}/.exec(raw);
  if (!match) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }

  const game = candidates.find((c) => c.gameId === parsed.game_id);
  // A game_id that is not on the list we supplied is a hallucination; drop it
  // rather than attaching a score to the wrong game.
  if (!game) return null;

  const runs = (value: unknown): number | null =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 99 ? value : null;

  const resultKind = parsed.result_kind === 'forfeit' ? 'forfeit' : 'played';
  const forfeitedBy =
    parsed.forfeited_by === 'home'
      ? game.homeTeamId
      : parsed.forfeited_by === 'away'
        ? game.awayTeamId
        : null;

  const confidence =
    typeof parsed.confidence === 'number' && parsed.confidence >= 0 && parsed.confidence <= 1
      ? parsed.confidence
      : 0.5;

  const homeRuns = runs(parsed.home_runs);
  const awayRuns = runs(parsed.away_runs);

  // A "played" result with no runs is not a reading, whatever confidence it claims.
  if (resultKind === 'played' && (homeRuns === null || awayRuns === null)) return null;

  void now;

  return {
    gameId: game.gameId,
    homeRuns,
    awayRuns,
    resultKind,
    forfeitedByTeamId: forfeitedBy,
    confidence,
    reasoning:
      typeof parsed.reasoning === 'string' && parsed.reasoning.trim() !== ''
        ? parsed.reasoning.trim()
        : 'read by the model',
    parserModel: MODEL,
  };
}
