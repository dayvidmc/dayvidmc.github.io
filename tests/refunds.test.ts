import { describe, expect, it } from "vitest";
import {
  ADMIN_FEE_CENTS,
  buildRefundList,
  completedGameCounts,
  formatCents,
  refundFor,
} from "../src/domain/refunds";
import { games } from "./helpers";

const ENTRY_FEE = 65_000; // $650

describe("completedGameCounts", () => {
  it("counts a completed game for both teams", () => {
    const counts = completedGameCounts(
      games(
        { home: "A", away: "B", homeRuns: 5, awayRuns: 3 },
        { home: "A", away: "C", homeRuns: 2, awayRuns: 1 },
      ),
      ["A", "B", "C", "D"],
    );
    expect(counts.get("A")).toBe(2);
    expect(counts.get("B")).toBe(1);
    expect(counts.get("D")).toBe(0);
  });
});

describe("refundFor", () => {
  it("returns the full fee less the admin fee when no games were played", () => {
    const line = refundFor("A", 0, ENTRY_FEE);
    expect(line.grossRefundCents).toBe(65_000);
    expect(line.adminFeeCents).toBe(ADMIN_FEE_CENTS);
    expect(line.refundCents).toBe(60_000);
  });

  it("returns half the fee less the admin fee after one game", () => {
    const line = refundFor("A", 1, ENTRY_FEE);
    expect(line.grossRefundCents).toBe(32_500);
    expect(line.refundCents).toBe(27_500);
  });

  it("returns nothing after two games, and charges no admin fee", () => {
    const line = refundFor("A", 2, ENTRY_FEE);
    expect(line.refundCents).toBe(0);
    expect(line.adminFeeCents).toBe(0);
    expect(line.explanation).toContain("no refund");
  });

  it("treats three or more games the same as two", () => {
    expect(refundFor("A", 5, ENTRY_FEE).refundCents).toBe(0);
  });

  it("never returns a negative refund when the fee is below the admin fee", () => {
    const line = refundFor("A", 1, 4_000); // $40 fee, 50% = $20, admin fee $50
    expect(line.refundCents).toBe(0);
  });

  it("rounds the fee share to the cent before deducting the admin fee", () => {
    const line = refundFor("A", 1, 12_345);
    expect(line.grossRefundCents).toBe(6_173); // 6172.5 rounded
    expect(line.refundCents).toBe(1_173);
  });

  it("explains itself in a sentence the treasurer can paste into an email", () => {
    expect(refundFor("A", 1, ENTRY_FEE).explanation).toBe(
      "1 game played - 50% of $650.00 ($325.00) less the $50.00 admin fee.",
    );
  });
});

describe("buildRefundList", () => {
  it("generates the whole washed-out-weekend list in one pass", () => {
    const played = games(
      { home: "A", away: "B", homeRuns: 5, awayRuns: 3 },
      { home: "A", away: "C", homeRuns: 2, awayRuns: 1 },
    );
    const fees = new Map([
      ["A", ENTRY_FEE],
      ["B", ENTRY_FEE],
      ["C", ENTRY_FEE],
      ["D", ENTRY_FEE],
    ]);

    const { lines, totalRefundCents } = buildRefundList(played, fees);
    expect(lines.map((l) => [l.teamId, l.gamesPlayed, l.refundCents])).toEqual([
      ["A", 2, 0],
      ["B", 1, 27_500],
      ["C", 1, 27_500],
      ["D", 0, 60_000],
    ]);
    expect(totalRefundCents).toBe(115_000);
  });
});

describe("formatCents", () => {
  it("formats whole and part dollars", () => {
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(5_000)).toBe("$50.00");
    expect(formatCents(65_000)).toBe("$650.00");
    expect(formatCents(6_173)).toBe("$61.73");
  });
});
