/**
 * Game counts and rainout refunds (spec §5.8, §8A.3).
 *
 * This is the one place where game operations data drives money, so per-team
 * completed-game counts are a **financial record**, not a statistic.
 *
 * All amounts are integer **cents**. Never floats — a rounding error here is a
 * wrong cheque.
 */

import type { CompletedGame, TeamId } from "./types";

/** Published rainout policy (spec §8A.3). */
export const ADMIN_FEE_CENTS = 5_000; // $50

export interface RefundPolicyTier {
  gamesPlayed: number;
  /** Share of the entry fee returned before the admin fee is deducted. */
  proportion: number;
}

/**
 * 0 games → full refund minus the admin fee.
 * 1 game  → 50% minus the admin fee.
 * 2+      → no refund, and no admin fee to deduct.
 */
export const RAINOUT_TIERS: readonly RefundPolicyTier[] = [
  { gamesPlayed: 0, proportion: 1 },
  { gamesPlayed: 1, proportion: 0.5 },
  { gamesPlayed: 2, proportion: 0 },
];

/**
 * Games each team actually completed.
 *
 * Only approved scores reach this function, and a forfeit still counts as a
 * game played — the team was there and the diamond was used. Flagged in
 * docs/OPEN-QUESTIONS.md for the committee to confirm.
 */
export function completedGameCounts(
  games: readonly CompletedGame[],
  teams: readonly TeamId[] = [],
): Map<TeamId, number> {
  const counts = new Map<TeamId, number>(teams.map((id) => [id, 0]));
  for (const { game } of games) {
    for (const teamId of [game.homeTeamId, game.awayTeamId]) {
      counts.set(teamId, (counts.get(teamId) ?? 0) + 1);
    }
  }
  return counts;
}

export interface RefundLine {
  teamId: TeamId;
  gamesPlayed: number;
  entryFeeCents: number;
  /** Entry fee share before the admin fee. */
  grossRefundCents: number;
  adminFeeCents: number;
  refundCents: number;
  /** Sentence for the treasurer's export and the team's notification. */
  explanation: string;
}

/** Refund owed to one team, given how many games it got in. */
export function refundFor(
  teamId: TeamId,
  gamesPlayed: number,
  entryFeeCents: number,
): RefundLine {
  const tier =
    RAINOUT_TIERS.find((t) => t.gamesPlayed === gamesPlayed) ??
    RAINOUT_TIERS[RAINOUT_TIERS.length - 1]!;

  // Round the fee share to the cent before deducting, so the arithmetic on the
  // page matches the arithmetic on the Square refund.
  const gross = Math.round(entryFeeCents * tier.proportion);
  const adminFee = gross > 0 ? ADMIN_FEE_CENTS : 0;
  const refund = Math.max(0, gross - adminFee);

  const explanation =
    gross === 0
      ? `${gamesPlayed} games played - no refund under the rainout policy.`
      : `${gamesPlayed} game${gamesPlayed === 1 ? "" : "s"} played - ${
          tier.proportion === 1 ? "full" : `${tier.proportion * 100}%`
        } of ${formatCents(entryFeeCents)} (${formatCents(
          gross,
        )}) less the ${formatCents(ADMIN_FEE_CENTS)} admin fee.`;

  return {
    teamId,
    gamesPlayed,
    entryFeeCents,
    grossRefundCents: gross,
    adminFeeCents: adminFee,
    refundCents: refund,
    explanation,
  };
}

/**
 * Whole refund list for a washed-out weekend — the treasurer generates this in
 * one action rather than reconstructing it by hand.
 */
export function buildRefundList(
  games: readonly CompletedGame[],
  entryFees: ReadonlyMap<TeamId, number>,
): { lines: RefundLine[]; totalRefundCents: number } {
  const counts = completedGameCounts(games, [...entryFees.keys()]);
  const lines = [...entryFees.entries()]
    .map(([teamId, feeCents]) =>
      refundFor(teamId, counts.get(teamId) ?? 0, feeCents),
    )
    .sort((a, b) => a.teamId.localeCompare(b.teamId));
  return {
    lines,
    totalRefundCents: lines.reduce((sum, line) => sum + line.refundCents, 0),
  };
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
