import { describe, expect, it } from "vitest";
import { rankDivision, resolveTieGroup } from "../src/domain/tiebreakers";
import { computeStandings } from "../src/domain/standings";
import { games } from "./helpers";

describe("two teams tied", () => {
  it("decides on head-to-head and quotes the game", () => {
    const played = games(
      { home: "Kanata", away: "Orleans", homeRuns: 5, awayRuns: 3 },
      { home: "Nepean", away: "Kanata", homeRuns: 9, awayRuns: 1 },
      { home: "Orleans", away: "Nepean", homeRuns: 6, awayRuns: 2 },
    );
    const result = resolveTieGroup(["Kanata", "Orleans"], played);

    expect(result.order).toEqual(["Kanata", "Orleans"]);
    expect(result.fullyResolved).toBe(true);
    const step = result.steps.find((s) => s.rule === "Head-to-head")!;
    expect(step.explanation).toContain("5-3");
    expect(step.explanation).toContain("Kanata advances head-to-head over Orleans");
  });

  it("falls through to runs allowed when the teams never met", () => {
    const played = games(
      { home: "A", away: "C", homeRuns: 3, awayRuns: 1 },
      { home: "B", away: "D", homeRuns: 5, awayRuns: 4 },
    );
    const result = resolveTieGroup(["A", "B"], played);

    expect(result.order).toEqual(["A", "B"]);
    const step = result.steps.at(-1)!;
    expect(step.rule).toBe("Runs allowed");
    expect(step.explanation).toBe("A advances on runs allowed: A 1 vs B 4.");
  });

  it("uses display names in the reasoning when given", () => {
    const played = games(
      { home: "kan", away: "orl", homeRuns: 4, awayRuns: 2 },
      { home: "nep", away: "kan", homeRuns: 3, awayRuns: 1 },
      { home: "orl", away: "nep", homeRuns: 5, awayRuns: 0 },
    );
    const result = resolveTieGroup(["kan", "orl"], played, {
      teamNames: { kan: "Kanata Major A", orl: "Orleans Major A" },
    });
    expect(result.steps[0]!.explanation).toBe(
      "Kanata Major A advances head-to-head over Orleans Major A, 4-2 on 2027-07-23.",
    );
  });
});

describe("the forfeit rule", () => {
  it("stops a forfeiting team winning a tiebreaker it would otherwise win", () => {
    const played = games(
      // A forfeited to C, so it carries a forfeit despite good numbers.
      { home: "C", away: "A", homeRuns: 1, awayRuns: 0, forfeitBy: "away" },
      { home: "A", away: "D", homeRuns: 10, awayRuns: 0 },
      { home: "B", away: "E", homeRuns: 3, awayRuns: 2 },
    );

    const rows = computeStandings(played, ["A", "B"]);
    // Both on 2 points, and A allowed fewer runs than B.
    expect(rows.find((r) => r.teamId === "A")!.points).toBe(2);
    expect(rows.find((r) => r.teamId === "B")!.points).toBe(2);
    expect(rows.find((r) => r.teamId === "A")!.runsAgainst).toBe(1);
    expect(rows.find((r) => r.teamId === "B")!.runsAgainst).toBe(2);

    const result = resolveTieGroup(["A", "B"], played);
    expect(result.order).toEqual(["B", "A"]);
    expect(result.steps[0]!.rule).toBe("Forfeit");
    expect(result.steps[0]!.explanation).toContain(
      "cannot win a tiebreaker after a round robin forfeit",
    );
  });
});

describe("three teams tied", () => {
  it("breaks a circular head-to-head on runs allowed, then head-to-head again", () => {
    // Each team is 1-1 inside the group, so head-to-head is circular.
    const played = games(
      { home: "A", away: "B", homeRuns: 5, awayRuns: 0 },
      { home: "B", away: "C", homeRuns: 5, awayRuns: 1 },
      { home: "C", away: "A", homeRuns: 2, awayRuns: 1 },
    );

    const rows = computeStandings(played);
    expect(rows.map((r) => r.points)).toEqual([2, 2, 2]);
    expect(rows.find((r) => r.teamId === "A")!.runsAgainst).toBe(2);
    expect(rows.find((r) => r.teamId === "B")!.runsAgainst).toBe(6);
    expect(rows.find((r) => r.teamId === "C")!.runsAgainst).toBe(6);

    const result = resolveTieGroup(["A", "B", "C"], played);

    // A advances on runs allowed; B and C are then split head-to-head, which is
    // exactly what the published three-team rule prescribes.
    expect(result.order).toEqual(["A", "B", "C"]);
    expect(result.fullyResolved).toBe(true);
    expect(result.steps.map((s) => s.rule)).toEqual([
      "Runs allowed",
      "Head-to-head",
    ]);
    expect(result.steps[1]!.explanation).toContain(
      "B advances head-to-head over C",
    );
  });

  it("skips head-to-head when the tied teams have not all played each other", () => {
    const played = games(
      { home: "A", away: "B", homeRuns: 4, awayRuns: 1 },
      { home: "B", away: "X", homeRuns: 4, awayRuns: 1 },
      { home: "C", away: "Y", homeRuns: 4, awayRuns: 3 },
      { home: "Z", away: "A", homeRuns: 6, awayRuns: 0 },
      { home: "Z", away: "C", homeRuns: 6, awayRuns: 0 },
    );
    // A, B and C are level on points but C never met A or B.
    const result = resolveTieGroup(["A", "B", "C"], played);
    expect(result.steps.some((s) => s.rule === "Head-to-head record")).toBe(false);
  });
});

describe("when the ladder runs out", () => {
  it("requires a coin flip rather than inventing a winner", () => {
    const played = games(
      { home: "A", away: "C", homeRuns: 3, awayRuns: 1 },
      { home: "B", away: "D", homeRuns: 3, awayRuns: 1 },
    );
    const result = resolveTieGroup(["A", "B"], played);

    expect(result.fullyResolved).toBe(false);
    expect(result.coinFlips).toEqual([["A", "B"]]);
    expect(result.steps.at(-1)!.rule).toBe("Coin flip");
  });

  it("does not let a blowout buy a tiebreak, because the cap flattens it", () => {
    const played = games(
      { home: "A", away: "C", homeRuns: 20, awayRuns: 0 },
      { home: "B", away: "D", homeRuns: 12, awayRuns: 0 },
    );
    const rows = computeStandings(played, ["A", "B"]);
    // Uncapped, A is miles ahead; capped, the two are identical.
    expect(rows.find((r) => r.teamId === "A")!.runDifferential).toBe(20);
    expect(rows.find((r) => r.teamId === "B")!.runDifferential).toBe(12);
    expect(rows.find((r) => r.teamId === "A")!.cappedRunDifferential).toBe(10);
    expect(rows.find((r) => r.teamId === "B")!.cappedRunDifferential).toBe(10);

    const result = resolveTieGroup(["A", "B"], played);
    expect(result.fullyResolved).toBe(false);
    expect(result.coinFlips).toEqual([["A", "B"]]);
  });
});

describe("rankDivision", () => {
  it("orders the whole division and carries the reasoning with it", () => {
    const played = games(
      { home: "A", away: "B", homeRuns: 5, awayRuns: 0 },
      { home: "A", away: "C", homeRuns: 3, awayRuns: 2 },
      { home: "B", away: "C", homeRuns: 4, awayRuns: 1 },
      { home: "D", away: "A", homeRuns: 1, awayRuns: 0 },
      { home: "D", away: "B", homeRuns: 2, awayRuns: 1 },
      { home: "C", away: "D", homeRuns: 7, awayRuns: 3 },
    );
    const { order, coinFlips } = rankDivision(played, ["A", "B", "C", "D"]);

    // A and D both finish 2-1, and D won the game between them, so D leads.
    // B and C both finish 1-2, and B won that meeting, so B is third.
    expect(order).toEqual(["D", "A", "B", "C"]);
    expect(order).toHaveLength(4);
    expect(new Set(order)).toEqual(new Set(["A", "B", "C", "D"]));
    expect(coinFlips).toEqual([]);
    expect(order[0]).toBe("D");
  });
});
