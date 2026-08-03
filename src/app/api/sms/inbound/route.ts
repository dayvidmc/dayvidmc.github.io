import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { query } from '@/db/client';
import {
  candidateGamesForPhone,
  currentTournament,
  parkUnmatchedMessage,
  recordProposal,
} from '@/server/repo';
import {
  claimInboundMessage,
  finishInboundMessage,
  releaseInboundClaim,
} from '@/server/messaging/inbound';
import { parseScoreMessage } from '@/server/scoreParser';
import { AUTO_FILL_CONFIDENCE } from '@/domain/scoreParsing';
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
 *
 * Every path runs behind a claim on Twilio's message id, so a retried delivery
 * is answered with the reply we already gave rather than recorded a second time
 * (see server/messaging/inbound.ts).
 */

export const dynamic = 'force-dynamic';

/** What one message became: what to say back, and what it was recorded as. */
interface Outcome {
  reply: string;
  scoreReportId: string | null;
}

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

  const tournament = await currentTournament();
  if (!tournament) return twiml('No tournament is running right now.');

  // Twilio always sends MessageSid. The fallback keeps the local test harness
  // and any hand-crafted POST working, at the cost of not deduping them —
  // which is correct, because there is nothing to dedupe against.
  const providerMessageId =
    form.get('MessageSid')?.trim() || form.get('SmsMessageSid')?.trim() || `local-${randomUUID()}`;

  const claim = await claimInboundMessage({
    tournamentId: tournament.id,
    providerMessageId,
    fromPhone: from,
    body: text === '' ? null : text,
    photoKey: mediaUrl,
  });

  if (claim.duplicate) {
    // Already handled. Replay the original answer if we have it; stay silent if
    // the first attempt is still running, since the alternative is telling one
    // volunteer two different things about one text.
    return claim.reply ? twiml(claim.reply) : silence();
  }

  let outcome: Outcome;
  try {
    outcome = await handleMessage(tournament.id, tournament.time_zone, from, text, mediaUrl);
  } catch (error) {
    // Release the claim so Twilio's retry — the attempt most likely to succeed
    // — is not turned away as a duplicate of a message we never processed.
    if (claim.id) await releaseInboundClaim(claim.id);
    throw error;
  }

  if (claim.id) await finishInboundMessage(claim.id, outcome.reply, outcome.scoreReportId);
  return twiml(outcome.reply);
}

async function handleMessage(
  tournamentId: string,
  timeZone: string,
  from: string,
  text: string,
  mediaUrl: string | null,
): Promise<Outcome> {
  const now = toWallClock(new Date(), timeZone);
  const candidates = await candidateGamesForPhone(tournamentId, from, now);

  if (candidates.length === 0) {
    // Nothing to attach it to. Do not drop it — a human at HQ is the last link
    // in every fallback chain (§4).
    await parkForHq(tournamentId, from, text, mediaUrl, 'no_candidate_games');
    return {
      reply: "Thanks — we couldn't match that to a game, so HQ will take a look.",
      scoreReportId: null,
    };
  }

  const parsed = await parseScoreMessage(text, candidates, now);

  if (!parsed) {
    await parkForHq(tournamentId, from, text, mediaUrl, 'unreadable');
    return {
      reply: "Thanks — we couldn't read a score in that, so HQ will take a look.",
      scoreReportId: null,
    };
  }

  const game = candidates.find((c) => c.gameId === parsed.gameId);
  if (!game) {
    await parkForHq(tournamentId, from, text, mediaUrl, 'no_game_matched');
    return { reply: 'Thanks — HQ will take a look.', scoreReportId: null };
  }

  // A message with no runs in it is not a score report, whatever game it was
  // nearest to. "Game is running long sorry" and a bare photo of the signed
  // sheet both land here. Sending them to the approval queue would put things
  // in front of the director that cannot be approved; they belong on the
  // unmatched screen, where a human decides what they are.
  //
  // Forfeits are exempt: a forfeit is a result even with no runs attached.
  if (parsed.resultKind === 'played' && (parsed.homeRuns === null || parsed.awayRuns === null)) {
    await parkForHq(tournamentId, from, text, mediaUrl, 'unreadable');
    return {
      reply: "Thanks — we couldn't read a score in that, so HQ will take a look.",
      scoreReportId: null,
    };
  }

  const scoreReportId = await recordProposal({
    tournamentId,
    gameId: game.gameId,
    source: (await isDiamondVolunteer(tournamentId, from)) ? 'diamond_volunteer' : 'coach_sms',
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
    return {
      reply: `Got it — recorded as a forfeit in ${game.externalGameId}. HQ will confirm.`,
      scoreReportId,
    };
  }

  if (parsed.homeRuns === null || parsed.awayRuns === null || parsed.confidence < AUTO_FILL_CONFIDENCE) {
    return {
      reply:
        `Thanks. We think that's ${game.externalGameId} (${game.homeTeamName} v ${game.awayTeamName}) ` +
        `but weren't certain, so HQ will confirm it.`,
      scoreReportId,
    };
  }

  return {
    reply:
      `Got it: ${game.homeTeamName} ${parsed.homeRuns}, ${game.awayTeamName} ${parsed.awayRuns}. ` +
      `Reply again if that's wrong.`,
    scoreReportId,
  };
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

/** A valid TwiML response that sends nothing back. */
function silence(): NextResponse {
  return new NextResponse('<?xml version="1.0" encoding="UTF-8"?><Response/>', {
    headers: { 'content-type': 'text/xml' },
  });
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
