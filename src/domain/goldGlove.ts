/**
 * The Gold Glove draw.
 *
 * At opening ceremonies on the Saturday, one player is drawn at random from
 * everybody registered. It is part of what makes this a memorial rather than
 * just a tournament, and the prize carries the name of the person the weekend
 * is for.
 *
 * That is why this is code and not somebody's hand in a hat. Two properties
 * matter and neither is about convenience:
 *
 *   - **It can be shown to have been fair.** The pool size and the random
 *     value are both recorded, so the same draw re-derives to the same person.
 *     A draw that cannot be checked is one somebody can doubt out loud, in
 *     front of a family, about a prize named after their son.
 *   - **It cannot quietly be run again.** Redrawing until a nicer name comes
 *     up is the failure this is guarding against, and the honest defence is a
 *     record of every draw rather than a rule nobody can see.
 *
 * The randomness comes in from the caller rather than being generated here, so
 * this stays pure and so the caller is forced to use a cryptographic source.
 */

export interface Candidate {
  playerId: string;
  playerName: string;
  teamName: string;
  divisionName: string;
}

export interface Draw {
  winner: Candidate;
  poolSize: number;
  /** The random value used, recorded so the draw can be re-derived. */
  seed: string;
}

export type DrawResult =
  | { ok: true; draw: Draw }
  | { ok: false; error: 'empty_pool' };

/**
 * Pick one candidate from a pool, using a seed the caller supplies.
 *
 * The selection is `seed mod poolSize` over a pool sorted by player id — a
 * stable order that does not depend on how the database happened to return
 * the rows. Sorting matters: without it the same seed picks different people
 * on different days, and the record stops meaning anything.
 */
export function draw(candidates: readonly Candidate[], seed: bigint): DrawResult {
  if (candidates.length === 0) return { ok: false, error: 'empty_pool' };

  const pool = [...candidates].sort((a, b) => a.playerId.localeCompare(b.playerId));
  const size = BigInt(pool.length);
  // Non-negative modulo, because a negative seed would index off the front.
  const index = Number(((seed % size) + size) % size);

  return {
    ok: true,
    draw: { winner: pool[index]!, poolSize: pool.length, seed: seed.toString() },
  };
}

/**
 * Re-run a recorded draw and check it lands on the same person.
 *
 * The point of storing the seed. Somebody who wants to satisfy themselves that
 * the draw was straight can be shown this, rather than being asked to take it
 * on trust.
 */
export function verify(
  candidates: readonly Candidate[],
  recorded: { playerId: string | null; poolSize: number; seed: string },
): { ok: boolean; reason?: string } {
  if (candidates.length !== recorded.poolSize) {
    return {
      ok: false,
      reason:
        `The pool has ${candidates.length} players now and had ${recorded.poolSize} at the draw. ` +
        'Rosters changed afterwards, so this cannot be re-checked — which is not the same as it having been unfair.',
    };
  }

  let seed: bigint;
  try {
    seed = BigInt(recorded.seed);
  } catch {
    return { ok: false, reason: 'The recorded seed is not a number.' };
  }

  const again = draw(candidates, seed);
  if (!again.ok) return { ok: false, reason: 'There is nobody in the pool now.' };

  return again.draw.winner.playerId === recorded.playerId
    ? { ok: true }
    : { ok: false, reason: 'The same seed picks a different player. Something has changed.' };
}

/** Turn cryptographic bytes into the seed the draw wants. */
export function seedFrom(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}
