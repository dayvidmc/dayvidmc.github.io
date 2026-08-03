import { describe, expect, it } from "vitest";
import { boardEntry, buildBoard, expectedFinish } from "../src/domain/board";
import { divisionRules } from "../src/domain/division-rules";
import type { Game } from "../src/domain/types";

const rules = divisionRules("major-a"); // 105 min limit, 20 min grace
const TODAY = "2027-07-24";

const game: Game = {
  id: "101",
  tournamentId: "T2027",
  divisionId: "major-a",
  pool: "A",
  date: TODAY,
  startTime: 10 * 60 + 30, // 10:30, so expected finish 12:15
  diamond: "Deevy Pines 1",
  homeTeamId: "Kanata",
  awayTeamId: "Orleans",
  type: "round_robin",
};

const base = {
  game,
  rules,
  hasApprovedScore: false,
  hasPendingProposal: false,
  isDisputed: false,
};

const at = (minutes: number, overrides = {}) =>
  boardEntry({ ...base, ...overrides }, minutes, TODAY);

describe("expectedFinish", () => {
  it("is start plus the division time limit", () => {
    expect(expectedFinish(game, rules)).toBe(12 * 60 + 15);
  });
});

describe("boardEntry", () => {
  it("is scheduled before first pitch", () => {
    expect(at(9 * 60).status).toBe("scheduled");
  });

  it("is in progress once it starts", () => {
    const entry = at(11 * 60);
    expect(entry.status).toBe("in_progress");
    expect(entry.nudgeDue).toBe(false);
  });

  it("nudges the diamond volunteer once the grace period lapses", () => {
    // 12:15 finish + 20 min grace = 12:35.
    const entry = at(12 * 60 + 36);
    expect(entry.status).toBe("in_progress");
    expect(entry.nudgeDue).toBe(true);
  });

  it("flags red 15 minutes after the nudge", () => {
    // 12:35 nudge + 15 = 12:50.
    const entry = at(12 * 60 + 50);
    expect(entry.status).toBe("overdue");
    expect(entry.nudgeDue).toBe(true);
    expect(entry.detail).toContain("35 min after expected finish");
  });

  it("shows a proposal awaiting approval as pending, not overdue", () => {
    expect(at(13 * 60, { hasPendingProposal: true }).status).toBe("pending");
  });

  it("never drags an approved score back to overdue", () => {
    expect(at(20 * 60, { hasApprovedScore: true }).status).toBe("reported");
  });

  it("puts a dispute above everything else", () => {
    const entry = at(20 * 60, { hasApprovedScore: true, isDisputed: true });
    expect(entry.status).toBe("disputed");
  });

  it("never marks another day's game overdue", () => {
    const tomorrow = { game: { ...game, date: "2027-07-25" } };
    expect(at(23 * 60, tomorrow).status).toBe("scheduled");
  });
});

describe("buildBoard", () => {
  it("sorts the worst statuses to the top so red rises", () => {
    const entries = buildBoard(
      [
        { ...base, game: { ...game, id: "done" }, hasApprovedScore: true },
        { ...base, game: { ...game, id: "late" } },
        { ...base, game: { ...game, id: "queued" }, hasPendingProposal: true },
        { ...base, game: { ...game, id: "flagged" }, isDisputed: true },
      ],
      13 * 60,
      TODAY,
    );
    expect(entries.map((e) => e.gameId)).toEqual([
      "flagged",
      "late",
      "queued",
      "done",
    ]);
  });
});
