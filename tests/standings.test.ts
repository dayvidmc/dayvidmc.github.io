import { describe, expect, it } from "vitest";
import { computeStandings, tieGroups } from "../src/domain/standings";
import { games } from "./helpers";

describe("computeStandings", () => {
  it("awards 2 for a win, 1 for a tie, 0 for a loss", () => {
    const rows = computeStandings(
      games(
        { home: "A", away: "B", homeRuns: 5, awayRuns: 3 },
        { home: "A", away: "C", homeRuns: 4, awayRuns: 4 },
        { home: "D", away: "A", homeRuns: 7, awayRuns: 1 },
      ),
    );
    const a = rows.find((r) => r.teamId === "A")!;
    expect(a).toMatchObject({
      gamesPlayed: 3,
      wins: 1,
      ties: 1,
      losses: 1,
      points: 3,
    });
  });

  it("seeds teams that have not played yet", () => {
    const rows = computeStandings([], ["A", "B"]);
    expect(rows.map((r) => r.teamId)).toEqual(["A", "B"]);
    expect(rows.every((r) => r.gamesPlayed === 0 && r.points === 0)).toBe(true);
  });

  it("caps run differential at 10 per game but leaves the raw figure intact", () => {
    const rows = computeStandings(
      games({ home: "A", away: "B", homeRuns: 25, awayRuns: 0 }),
    );
    const a = rows.find((r) => r.teamId === "A")!;
    expect(a.runDifferential).toBe(25);
    expect(a.cappedRunDifferential).toBe(10);

    const b = rows.find((r) => r.teamId === "B")!;
    expect(b.runDifferential).toBe(-25);
    expect(b.cappedRunDifferential).toBe(-10);
  });

  it("ignores playoff games", () => {
    const rows = computeStandings(
      games({ home: "A", away: "B", homeRuns: 9, awayRuns: 0, type: "playoff" }),
      ["A", "B"],
    );
    expect(rows.every((r) => r.gamesPlayed === 0)).toBe(true);
  });

  it("counts forfeits against the team that failed to field", () => {
    const rows = computeStandings(
      games({
        home: "A",
        away: "B",
        homeRuns: 7,
        awayRuns: 0,
        forfeitBy: "away",
      }),
    );
    expect(rows.find((r) => r.teamId === "B")!.forfeits).toBe(1);
    expect(rows.find((r) => r.teamId === "A")!.forfeits).toBe(0);
  });

  it("reports groups level on points", () => {
    const rows = computeStandings(
      games(
        { home: "A", away: "B", homeRuns: 5, awayRuns: 3 },
        { home: "C", away: "D", homeRuns: 5, awayRuns: 3 },
      ),
    );
    expect(tieGroups(rows)).toEqual([
      ["A", "C"],
      ["B", "D"],
    ]);
  });
});
