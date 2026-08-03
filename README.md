# Tokessy Tournament Operations

Operations tooling for the **30th Annual Scott Tokessy Memorial Gold Glove
Tournament**, late July 2027. Three days, ~90 teams, 7 divisions, 8+ diamonds,
run entirely by volunteers. 100% of proceeds go to CHEO Cardiology.

Full spec: [`docs/SPEC.md`](docs/SPEC.md).

---

## What's in the repo right now

The **domain core** — the rules the tournament actually runs on, as pure
functions over plain data, plus the database schema they map onto.

| Module | Spec | What it does |
|---|---|---|
| [`division-rules`](src/domain/division-rules.ts) | §5.4 | Per-division rules config, generic enough for all seven divisions |
| [`game-rules`](src/domain/game-rules.ts) | §5.4 | Official game, mercy rule, per-inning cap, outcome |
| [`standings`](src/domain/standings.ts) | §5.5 | W=2 / T=1 / L=0, runs for and against, capped run differential |
| [`tiebreakers`](src/domain/tiebreakers.ts) | §5.5 | Two-team and three-team ladders, forfeit rule, **with reasoning attached** |
| [`schedule-import`](src/domain/schedule-import.ts) | §5.1 | CSV import and conflict detection (warnings only — the director overrides) |
| [`board`](src/domain/board.ts) | §5.3 | HQ board status: reported / pending / overdue / disputed, nudge and red-flag timing |
| [`refunds`](src/domain/refunds.ts) | §5.8, §8A.3 | Per-team game counts and the tiered rainout refund list |
| [`db/schema.sql`](db/schema.sql) | §9 | Postgres schema, `tournament_id`-scoped, append-only audit trail |

62 tests, all passing.

```bash
npm install
npm test          # vitest
npm run typecheck # tsc --noEmit
```

### Why this part first

Two reasons.

**It is the part that has to be right.** Spec §12 Phase 3 exists specifically
to replay the 2026 schedule and real results through the tiebreaker code and
compare against what actually happened. That test needs this code to exist, and
it needs it to be replayable without standing up a database, a phone number, or
a payment processor. Everything here is a pure function over plain data, so the
replay is a test file, not an environment.

**Nothing else is unblocked.** Per spec §12 the project starts with Phase 0, a
debrief with the director and the volunteer, HQ and auction leads, and
"everything below is provisional until this happens." Phase 1 (registration)
also depends on a live committee decision — see §12's warning and question F in
[`docs/OPEN-QUESTIONS.md`](docs/OPEN-QUESTIONS.md). Building the Next.js app,
Square integration, or Twilio wiring ahead of those answers would be building on
sand. The rules ladder is the one substantial piece that no answer changes.

### What's deliberately not here yet

- The Next.js app, HQ screens, and team/volunteer magic-link pages
- Square (registration, donations, sponsors, auction checkout)
- Twilio SMS in/out, and the LLM score parser (§5.2)
- Volunteers (§6), auction (§7), registration (§8A) beyond their schema
- **Any scheduling engine.** §5.1 is explicit: do not build one in v1

## Two design decisions worth knowing

**The tiebreakers show their work.** Every step that moves a team returns the
sentence explaining why — *"Kanata advances on runs allowed: Kanata 12 vs
Orleans 15."* Directors keep paper because they don't trust opaque math, so the
reasoning is a return value, not a log line.

**The code never flips the coin.** When the published ladder is exhausted,
`resolveTieGroup` reports `coinFlips` and `fullyResolved: false` and stops. A
machine silently picking a winner is exactly what the paper trail exists to
prevent.

```ts
import { resolveTieGroup } from "./src/domain/tiebreakers";

const result = resolveTieGroup(["kanata", "orleans"], completedGames, {
  teamNames: { kanata: "Kanata Major A", orleans: "Orleans Major A" },
});

result.order;          // ["kanata", "orleans"]
result.fullyResolved;  // true
result.steps[0].explanation;
// "Kanata Major A advances head-to-head over Orleans Major A, 5-3 on 2027-07-23."
```

## Open questions

[`docs/OPEN-QUESTIONS.md`](docs/OPEN-QUESTIONS.md) carries the spec's eight
questions plus seven found while implementing — including three that the code
currently answers by assumption and somebody should confirm:

- **Four or more teams tied on points.** The published rules cover two and
  three. They do not cover four, and with ~90 teams it will happen.
- **Does a forfeit count as a game played for refund purposes?** This one moves
  money.
- **§9's data model contradicts §8 on concessions** — it sketches `stock_count`
  and `cash_reconciliation` tables that §8 explicitly forbids building. The
  schema follows §8.

## Money

All amounts are integer **cents**, everywhere, with no exceptions. A rounding
error in `refunds.ts` is a wrong cheque.
