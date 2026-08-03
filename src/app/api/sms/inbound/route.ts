import { createHmac, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { query } from '@/db/client';
import {
  candidateGamesForPhone,
  currentTournament,
  parkUnmatchedMessage,
  recordProposal,
} from '@/server/repo';
import { parseScoreMessage } from '@/server/scoreParser';
import { optIn, optOut } from '@/server/sms/drain';
import { AUTO_FILL_CONFIDENCE } from '@/domain/scoreParsing';
import { inboundIntent } from '@/domain/messaging';
import { toWallClock } from '@/domain/time';

/**
 * Inbound SMS (§5.2, paths 1 and 2).
 *
 * A diamond volunteer replies to the prompt; a coach texts unprompted. Both
 * arrive here, both get parsed, and both land in the same approval queue.
 *
 * The reply is short and confirms what was understood, so the sender can see
 * immediately if it was read wrong and text again. Silence would leave them
 * wondering whether to phone HQ.
 */

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const body = await request.text();

  if (!verifyTwilioSignature(request, body)) {
    return new NextResponse('invalid signature', { status: 403 });
  }

  const form = new URLSearchParams(body);
  const from = (form.get('From') ?? '').trim();
  const text = (form.get('Body') ?? '').trim();
  const mediaUrl = form.get('MediaUrl0');

  if (!from || (!text && !mediaUrl)) return twiml('Sorry, that came through empty.');

  // STOP comes before everything, including before we look for a tournament.
  // Carriers require it to work, Canadian anti-spam law requires it to work,
  // and "we were between tournaments" is not a defence for having ignored it.
  //
  // The match is strict — the whole message must be the keyword — because
  // reading "stop the game, it's raining" as an unsubscribe silences a coach
  // for the rest of the weekend.
  const intent = inboundIntent(text);
  if (intent === 'stop') {
    await optOut(from, text);
    return twiml('Stopped. You will not get any more texts from the tournament. Reply START to turn them back on.');
  }
  if (intent === 'start') {
    await optIn(from);
    return twiml('You are back on. We will text you about your games again.');
  }
  if (intent === 'help') {
    return twiml(
      'Scott Tokessy Memorial Tournament. Reply with a score like "MA-01 7-2". ' +
        'Reply STOP to stop these texts.',
    );
  }

  const tournament = await currentTournament();
  if (!tournament) return twiml('No tournament is running right now.');

  const now = toWallClock(new Date(), tournament.time_zone);
  const candidates = await candidateGamesForPhone(tournament.id, from, now);

  if (candidates.length === 0) {
    // Nothing to attach it to. Do not drop it — a human at HQ is the last link
    // in every fallback chain (§4).
    await parkForHq(tournament.id, from, text, mediaUrl, 'no_candidate_games');
    return twiml("Thanks — we couldn't match that to a game, so HQ will take a look.");
  }

  const parsed = await parseScoreMessage(text, candidates, now);

  if (!parsed) {
    await parkForHq(tournament.id, from, text, mediaUrl, 'unreadable');
    return twiml("Thanks — we couldn't read a score in that, so HQ will take a look.");
  }

  const game = candidates.find((c) => c.gameId === parsed.gameId);
  if (!game) {
    await parkForHq(tournament.id, from, text, mediaUrl, 'no_game_matched');
    return twiml('Thanks — HQ will take a look.');
  }

  // A message with no runs in it is not a score report, whatever game it was
  // nearest to. "Game is running long sorry" and a bare photo of the signed
  // sheet both land here. Sending them to the approval queue would put things
  // in front of the director that cannot be approved; they belong on the
  // unmatched screen, where a human decides what they are.
  //
  // Forfeits are exempt: a forfeit is a result even with no runs attached.
  if (parsed.resultKind === 'played' && (parsed.homeRuns === null || parsed.awayRuns === null)) {
    await parkForHq(tournament.id, from, text, mediaUrl, 'unreadable');
    return twiml("Thanks — we couldn't read a score in that, so HQ will take a look.");
  }

  await recordProposal({
    tournamentId: tournament.id,
    gameId: game.gameId,
    source: (await isDiamondVolunteer(tournament.id, from)) ? 'diamond_volunteer' : 'coach_sms',
    reportedBy: from,
    rawText: text,
    homeRuns: parsed.homeRuns,
    awayRuns: parsed.awayRuns,
    resultKind: parsed.resultKind,
    forfeitedByTeamId: parsed.forfeitedByTeamId,
    confidence: parsed.confidence,
    parserModel: parsed.parserModel,
    photoKey: mediaUrl ?? null,
  });

  if (parsed.resultKind === 'forfeit') {
    return twiml(`Got it — recorded as a forfeit in ${game.externalGameId}. HQ will confirm.`);
  }

  if (parsed.homeRuns === null || parsed.awayRuns === null || parsed.confidence < AUTO_FILL_CONFIDENCE) {
    return twiml(
      `Thanks. We think that's ${game.externalGameId} (${game.homeTeamName} v ${game.awayTeamName}) ` +
        `but weren't certain, so HQ will confirm it.`,
    );
  }

  return twiml(
    `Got it: ${game.homeTeamName} ${parsed.homeRuns}, ${game.awayTeamName} ${parsed.awayRuns}. ` +
      `Reply again if that's wrong.`,
  );
}

/**
 * A message we cannot attach to a game becomes a row on the HQ unmatched
 * screen, not a line in a log nobody reads. Any photo comes with it — a picture
 * of the signed sheet is often the most useful part of a message we could not
 * otherwise place.
 */
async function parkForHq(
  tournamentId: string,
  from: string,
  text: string,
  mediaUrl: string | null,
  reason: 'no_candidate_games' | 'unreadable' | 'no_game_matched',
): Promise<void> {
  await parkUnmatchedMessage({
    tournamentId,
    fromPhone: from,
    body: text === '' ? null : text,
    photoKey: mediaUrl,
    reason,
  });
}

async function isDiamondVolunteer(tournamentId: string, phone: string): Promise<boolean> {
  const rows = await query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM diamond_shift
        WHERE tournament_id = $1 AND volunteer_phone = $2
     ) AS exists`,
    [tournamentId, phone],
  );
  return rows[0]?.exists ?? false;
}

function twiml(message: string): NextResponse {
  const escaped = message
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return new NextResponse(
    `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escaped}</Message></Response>`,
    { headers: { 'content-type': 'text/xml' } },
  );
}

/**
 * Twilio signs every webhook. Without this check, anyone who guesses the URL
 * can post a score — and scores decide who plays on Sunday.
 *
 * When no auth token is configured (local development), the check is skipped
 * and says so loudly rather than silently accepting anything in production.
 */
function verifyTwilioSignature(request: Request, body: string): boolean {
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!authToken) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[sms] TWILIO_AUTH_TOKEN is not set — rejecting inbound webhook');
      return false;
    }
    console.warn('[sms] TWILIO_AUTH_TOKEN not set — skipping signature check (development only)');
    return true;
  }

  const signature = request.headers.get('x-twilio-signature');
  if (!signature) return false;

  // Twilio signs the full URL plus the POST parameters sorted by key.
  const url = process.env.TWILIO_WEBHOOK_URL ?? request.url;
  const params = new URLSearchParams(body);
  const sorted = [...params.keys()].sort();
  const payload = url + sorted.map((key) => key + params.get(key)).join('');

  const expected = createHmac('sha1', authToken).update(Buffer.from(payload, 'utf8')).digest('base64');

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
