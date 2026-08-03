/**
 * Public surface of the tournament domain core.
 *
 * Everything exported here is a pure function over plain data: no database, no
 * network, no clock. That is deliberate. These are the rules the tournament
 * actually runs on, and they need to be replayable against the 2026 results
 * without standing anything up (spec §12, Phase 3).
 */

export * from "./domain/types";
export * from "./domain/division-rules";
export * from "./domain/game-rules";
export * from "./domain/standings";
export * from "./domain/tiebreakers";
export * from "./domain/schedule-import";
export * from "./domain/board";
export * from "./domain/refunds";
