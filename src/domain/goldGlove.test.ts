import { describe, expect, it } from 'vitest';
import { draw, seedFrom, verify, type Candidate } from './goldGlove';

const pool = (n: number): Candidate[] =>
  Array.from({ length: n }, (_, i) => ({
    playerId: `p${String(i).padStart(3, '0')}`,
    playerName: `Player ${i}`,
    teamName: 'Kanata Major A',
    divisionName: 'Major A',
  }));

describe('drawing the Gold Glove', () => {
  it('refuses an empty pool rather than inventing a winner', () => {
    expect(draw([], 42n)).toEqual({ ok: false, error: 'empty_pool' });
  });

  it('picks somebody from the pool', () => {
    const result = draw(pool(90), 12345n);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(pool(90).some((c) => c.playerId === result.draw.winner.playerId)).toBe(true);
    expect(result.draw.poolSize).toBe(90);
  });

  it('gives the same answer for the same seed, whatever order the rows arrive in', () => {
    // Without sorting, the same seed picks different people on different days
    // and the recorded seed stops meaning anything.
    const forwards = draw(pool(50), 999n);
    const backwards = draw([...pool(50)].reverse(), 999n);
    expect(forwards.ok && backwards.ok).toBe(true);
    if (!forwards.ok || !backwards.ok) return;
    expect(forwards.draw.winner.playerId).toBe(backwards.draw.winner.playerId);
  });

  it('gives different answers for different seeds', () => {
    const seen = new Set<string>();
    for (let seed = 0n; seed < 20n; seed += 1n) {
      const result = draw(pool(90), seed);
      if (result.ok) seen.add(result.draw.winner.playerId);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('handles a pool of one', () => {
    const result = draw(pool(1), 7n);
    expect(result.ok && result.draw.winner.playerId).toBe('p000');
  });

  it('does not index off the front on a negative seed', () => {
    const result = draw(pool(10), -7n);
    expect(result.ok).toBe(true);
    if (result.ok) expect(pool(10).some((c) => c.playerId === result.draw.winner.playerId)).toBe(true);
  });

  it('copes with a seed far larger than the pool', () => {
    const huge = seedFrom(new Uint8Array(Array.from({ length: 32 }, () => 255)));
    const result = draw(pool(90), huge);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.draw.poolSize).toBe(90);
  });

  it('records the seed as a string so it survives being stored', () => {
    const result = draw(pool(90), 12345678901234567890n);
    expect(result.ok && result.draw.seed).toBe('12345678901234567890');
  });
});

describe('checking a draw afterwards', () => {
  it('re-derives the same winner', () => {
    const result = draw(pool(90), 4242n);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(
      verify(pool(90), {
        playerId: result.draw.winner.playerId,
        poolSize: result.draw.poolSize,
        seed: result.draw.seed,
      }),
    ).toEqual({ ok: true });
  });

  it('says so plainly when the rosters have changed since', () => {
    // Not the same as saying it was unfair, and the wording has to be careful
    // about that — this is a draw named after somebody's son.
    const result = draw(pool(90), 4242n);
    if (!result.ok) return;

    const check = verify(pool(91), {
      playerId: result.draw.winner.playerId,
      poolSize: 90,
      seed: result.draw.seed,
    });
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('not the same as it having been unfair');
  });

  it('catches a recorded winner who does not match the seed', () => {
    const check = verify(pool(90), { playerId: 'p999', poolSize: 90, seed: '4242' });
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('different player');
  });

  it('refuses a seed that is not a number', () => {
    expect(verify(pool(90), { playerId: 'p001', poolSize: 90, seed: 'nonsense' }).ok).toBe(false);
  });
});

describe('the seed itself', () => {
  it('turns bytes into a number', () => {
    expect(seedFrom(new Uint8Array([1]))).toBe(1n);
    expect(seedFrom(new Uint8Array([1, 0]))).toBe(256n);
    expect(seedFrom(new Uint8Array([255, 255]))).toBe(65535n);
  });

  it('uses every byte it is given', () => {
    const short = seedFrom(new Uint8Array([1, 2, 3, 4]));
    const long = seedFrom(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(long).toBeGreaterThan(short);
  });
});
