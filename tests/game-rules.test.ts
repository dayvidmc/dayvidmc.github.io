import { describe, expect, it } from "vitest";
import {
  gameOutcome,
  isOfficialGame,
  mercyReached,
  officialInningsRequired,
  runsPerInningCap,
} from "../src/domain/game-rules";
import { divisionRules } from "../src/domain/division-rules";

const major = divisionRules("major-a");

describe("official game", () => {
  it("needs 4 innings, or 3.5 when the home team is ahead", () => {
    expect(
      officialInningsRequired(major, {
        homeRuns: 5,
        awayRuns: 2,
        completedInnings: 3.5,
      }),
    ).toBe(3.5);
    expect(
      officialInningsRequired(major, {
        homeRuns: 2,
        awayRuns: 5,
        completedInnings: 3.5,
      }),
    ).toBe(4);
  });

  it("is official at 3.5 innings with the home team ahead", () => {
    expect(
      isOfficialGame(major, { homeRuns: 5, awayRuns: 2, completedInnings: 3.5 }),
    ).toBe(true);
  });

  it("is not official at 3.5 innings with the away team ahead", () => {
    expect(
      isOfficialGame(major, { homeRuns: 2, awayRuns: 5, completedInnings: 3.5 }),
    ).toBe(false);
  });
});

describe("mercy rule", () => {
  it("ends the game at an 11-run lead once the game is official", () => {
    expect(
      mercyReached(major, { homeRuns: 13, awayRuns: 2, completedInnings: 4 }),
    ).toBe(true);
  });

  it("does not apply before the game is official", () => {
    expect(
      mercyReached(major, { homeRuns: 13, awayRuns: 2, completedInnings: 3 }),
    ).toBe(false);
  });

  it("does not apply at a 10-run lead in a regular game", () => {
    expect(
      mercyReached(major, { homeRuns: 12, awayRuns: 2, completedInnings: 4 }),
    ).toBe(false);
  });

  it("tightens to 10 runs in the championship final", () => {
    expect(
      mercyReached(major, {
        homeRuns: 12,
        awayRuns: 2,
        completedInnings: 4,
        isChampionshipFinal: true,
      }),
    ).toBe(true);
  });

  it("applies to the away team's lead too", () => {
    expect(
      mercyReached(major, { homeRuns: 0, awayRuns: 11, completedInnings: 4 }),
    ).toBe(true);
  });
});

describe("runs per inning cap", () => {
  it("caps at 5 in a regular game and lifts the cap in the final", () => {
    expect(runsPerInningCap(major, {})).toBe(5);
    expect(runsPerInningCap(major, { isChampionshipFinal: true })).toBeNull();
  });
});

describe("gameOutcome", () => {
  const full = { completedInnings: 6 };

  it("reads a completed round robin game", () => {
    expect(gameOutcome(major, { ...full, homeRuns: 5, awayRuns: 3 })).toBe(
      "home_win",
    );
    expect(gameOutcome(major, { ...full, homeRuns: 3, awayRuns: 5 })).toBe(
      "away_win",
    );
    expect(gameOutcome(major, { ...full, homeRuns: 4, awayRuns: 4 })).toBe("tie");
  });

  it("refuses to call a short game", () => {
    expect(
      gameOutcome(major, { homeRuns: 3, awayRuns: 5, completedInnings: 2 }),
    ).toBe("not_official");
  });

  it("does not allow a tie in a playoff game", () => {
    expect(
      gameOutcome(major, { ...full, homeRuns: 4, awayRuns: 4 }, "playoff"),
    ).toBe("not_official");
  });

  it("does not allow a tie where the division forbids one", () => {
    const noTies = divisionRules("junior-a", { tiesAllowedRoundRobin: false });
    expect(gameOutcome(noTies, { ...full, homeRuns: 4, awayRuns: 4 })).toBe(
      "not_official",
    );
  });
});
