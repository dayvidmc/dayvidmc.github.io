import { describe, expect, it } from "vitest";
import {
  importSchedule,
  parseCsv,
  parseTime,
  formatTime,
} from "../src/domain/schedule-import";

const OPTS = { tournamentId: "T2027" };

const HEADER =
  "Division,Pool,Game ID,Date,Start Time,Diamond,Home Team,Away Team,Game Type";

describe("parseTime", () => {
  it("accepts the formats a director's spreadsheet actually produces", () => {
    expect(parseTime("10:30")).toBe(630);
    expect(parseTime("10:30 AM")).toBe(630);
    expect(parseTime("1:00 PM")).toBe(780);
    expect(parseTime("1:00pm")).toBe(780);
    expect(parseTime("12:00 AM")).toBe(0);
    expect(parseTime("12:30 PM")).toBe(750);
    expect(parseTime("9")).toBe(540);
  });

  it("rejects what it cannot read rather than guessing", () => {
    expect(parseTime("noonish")).toBeNull();
    expect(parseTime("25:00")).toBeNull();
    expect(parseTime("10:75")).toBeNull();
    expect(parseTime("")).toBeNull();
  });
});

describe("formatTime", () => {
  it("round-trips through parseTime", () => {
    for (const minutes of [0, 630, 720, 750, 1260]) {
      expect(parseTime(formatTime(minutes))).toBe(minutes);
    }
  });
});

describe("parseCsv", () => {
  it("handles quoted fields with embedded commas", () => {
    expect(parseCsv('a,"b,c",d')).toEqual([["a", "b,c", "d"]]);
  });

  it("handles escaped quotes and CRLF", () => {
    expect(parseCsv('a,"say ""hi"""\r\nb,c')).toEqual([
      ["a", 'say "hi"'],
      ["b", "c"],
    ]);
  });
});

describe("importSchedule", () => {
  it("imports a clean schedule", () => {
    const csv = [
      HEADER,
      "Major A,A,101,2027-07-23,10:30 AM,Deevy Pines 1,Kanata,Orleans,Round Robin",
      "Major A,A,102,2027-07-23,1:00 PM,Deevy Pines 1,Nepean,Gloucester,Round Robin",
      "Major A,,201,2027-07-25,9:00 AM,Tokessy,Kanata,Nepean,Playoff",
    ].join("\n");

    const result = importSchedule(csv, OPTS);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.games).toHaveLength(3);
    expect(result.games[0]).toMatchObject({
      id: "101",
      divisionId: "Major A",
      pool: "A",
      startTime: 630,
      diamond: "Deevy Pines 1",
      homeTeamId: "Kanata",
      type: "round_robin",
    });
    expect(result.games[2]).toMatchObject({ pool: null, type: "playoff" });
  });

  it("reports a missing required column instead of importing junk", () => {
    const result = importSchedule("Division,Date\nMajor A,2027-07-23", OPTS);
    expect(result.games).toEqual([]);
    expect(result.errors[0]!.message).toContain("Missing required column");
  });

  it("drops unreadable rows but keeps the rest, naming the row number", () => {
    const csv = [
      HEADER,
      "Major A,A,101,2027-07-23,sometime,Deevy Pines 1,Kanata,Orleans,Round Robin",
      "Major A,A,102,2027-07-23,1:00 PM,Tokessy,Nepean,Gloucester,Round Robin",
    ].join("\n");

    const result = importSchedule(csv, OPTS);
    expect(result.games).toHaveLength(1);
    expect(result.errors).toEqual([
      { row: 2, message: 'Unreadable start time "sometime".' },
    ]);
  });

  it("warns on a diamond double-booking", () => {
    const csv = [
      HEADER,
      "Major A,A,101,2027-07-23,10:30 AM,Deevy Pines 1,Kanata,Orleans,Round Robin",
      "Major A,A,102,2027-07-23,11:00 AM,Deevy Pines 1,Nepean,Gloucester,Round Robin",
    ].join("\n");

    const warnings = importSchedule(csv, OPTS).warnings;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.code).toBe("diamond_double_booked");
    expect(warnings[0]!.gameIds).toEqual(["101", "102"]);
    expect(warnings[0]!.message).toContain("Deevy Pines 1");
  });

  it("warns when one team is booked into two games at once", () => {
    const csv = [
      HEADER,
      "Major A,A,101,2027-07-23,10:30 AM,Deevy Pines 1,Kanata,Orleans,Round Robin",
      "Major A,A,102,2027-07-23,11:00 AM,Tokessy,Kanata,Gloucester,Round Robin",
    ].join("\n");

    const codes = importSchedule(csv, OPTS).warnings.map((w) => w.code);
    expect(codes).toContain("team_double_booked");
    expect(codes).not.toContain("diamond_double_booked");
  });

  it("warns on games outside tournament hours", () => {
    const csv = [
      HEADER,
      "Major A,A,101,2027-07-23,10:00 PM,Deevy Pines 1,Kanata,Orleans,Round Robin",
    ].join("\n");

    const warnings = importSchedule(csv, OPTS).warnings;
    expect(warnings[0]!.code).toBe("outside_tournament_hours");
    expect(warnings[0]!.message).toContain("10:00 PM");
  });

  it("warns on duplicate game ids", () => {
    const csv = [
      HEADER,
      "Major A,A,101,2027-07-23,10:30 AM,Deevy Pines 1,Kanata,Orleans,Round Robin",
      "Major A,A,101,2027-07-24,10:30 AM,Tokessy,Nepean,Gloucester,Round Robin",
    ].join("\n");

    const codes = importSchedule(csv, OPTS).warnings.map((w) => w.code);
    expect(codes).toContain("duplicate_game_id");
  });

  it("does not flag back-to-back games that clear the window", () => {
    const csv = [
      HEADER,
      "Major A,A,101,2027-07-23,9:00 AM,Deevy Pines 1,Kanata,Orleans,Round Robin",
      "Major A,A,102,2027-07-23,11:30 AM,Deevy Pines 1,Nepean,Gloucester,Round Robin",
    ].join("\n");

    expect(importSchedule(csv, OPTS).warnings).toEqual([]);
  });

  it("keeps games on different days apart", () => {
    const csv = [
      HEADER,
      "Major A,A,101,2027-07-23,10:30 AM,Deevy Pines 1,Kanata,Orleans,Round Robin",
      "Major A,A,102,2027-07-24,10:30 AM,Deevy Pines 1,Kanata,Gloucester,Round Robin",
    ].join("\n");

    expect(importSchedule(csv, OPTS).warnings).toEqual([]);
  });
});
