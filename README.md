# Tokessy Tournament Operations

Operations tool for the **Scott Tokessy Memorial Gold Glove Tournament** — 30th
annual, late July 2027, in support of CHEO Cardiology.

> **Status: pre-Phase-0.** The build spec is Draft v1 and explicitly provisional
> until the director debrief (spec §12, Phase 0). This repository contains the
> foundation and the game-operations core. See [DECISIONS.md](DECISIONS.md) for
> every assumption made along the way and what still needs a human answer.

Code comments and both documents cite the build spec by section (§5.5, §8A.3
and so on). **The spec itself is not in this repository yet — commit it to
`docs/SPEC.md`** so those references resolve for whoever picks this up later.

---

## What is here

The deterministic heart of game operations, fully tested, plus the screens and
intake paths that feed it.

| Area | Spec | State |
|---|---|---|
| Schedule import + conflict validation | §5.1 | Built, tested |
| Score intake — 3 paths, one queue | §5.2 | Built, tested |
| **Outbound SMS: the system asks, then nudges** | §5.2 | Built, tested — the primary path now starts |
| Outbox worker, retries, failure screen | §5.7 | Built, tested |
| Diamond volunteer shifts + coverage gaps | §5.2 | Built |
| HQ screen for texts nobody could place | §5.2 | Built |
| HQ board with overdue clock | §5.3 | Built, tested |
| Division rules config | §5.4 | Built — auto-saving editor with a live overdue-clock preview |
| Standings and tiebreakers | §5.5 | Built, tested — the core deliverable |
| Game count tracking (financial) | §5.8 | Built, tested |
| Team links, no login | §5.7 | Built |
| Tile + PIN staff access | §10 | Built |
| Game detail: correct, dispute, reschedule, history | §5.3 | Built |
| Team contacts and per-team links | §5.7 | Built — auto-saving |
| Settings and pre-weekend readiness checklist | — | Built |
| Concessions till, offline-capable | §8 | Built, tested — cash only; card hands off to Square |
| Public schedule with live status | §5.7 | Built, tested |
| Append-only audit trail | §9 | Built, enforced by the database |

## What is deliberately not here

Per the spec's own build order, and because these need answers this repository
cannot supply:

- **Brackets (§5.6)** — playoff format comes from the published schedule, and
  §13 Q4 (how the director actually builds it) is unanswered.
- **SMS broadcast and the rain button (§5.7).** The messaging spine underneath
  them is built and working; what is missing is the screen that chooses who to
  send to and the reflow that decides what to say.
- **Card processing.** The till records card sales; it does not charge them.
  Tapping a card on a phone needs a native app — Apple and Google only expose
  the NFC reader to signed native apps — so the card tap happens in the Square
  app and this records the result. See `docs/CONCESSIONS.md`.
- **Registration and payments (Module E)**, **volunteers (Module B)**,
  **auction (Module C)**.
- **Charitable receipting and raffles** — §7.4 and §8A.4 are legal and
  accounting questions, not technical ones. No logic has been written for
  either, on purpose.
- **A scheduling engine.** Spec §5.1: *"Do not build a scheduling engine in
  v1."*

---

## Running it

Requires Node 22+ and PostgreSQL 14+.

```bash
npm install
cp .env.example .env.local        # then set DATABASE_URL and SESSION_SECRET
npm run migrate                   # apply schema
npm run seed                      # dev tournament; prints staff PINs
npm run dev
```

`npm run seed` prints a random PIN per staff member. It creates a 2027
tournament, eight divisions, eight diamonds and a sample schedule.

### Seeing it as it would look mid-weekend

```bash
dropdb tokessy && createdb tokessy && npm run migrate && npm run demo && npm run dev
```

`npm run demo` builds a tournament dated relative to *now*, so the HQ board
shows live statuses rather than a page of grey rows: yesterday's round robin
complete, today's games variously reported, waiting on approval, overdue and
going red, and one disputed. Yesterday's results are chosen to produce a genuine
circular three-way tie, so the standings screen shows the tiebreaker explaining
itself.

It is meant for the Phase 0 debrief — it is much easier to ask a director "is
this the board you want?" than to describe one.

```bash
npm test          # 91 unit tests, no database needed
npm run typecheck
npm run build
```

The domain layer is pure — no database, no network, no clock reads — so the
whole test suite runs in about a second and needs no infrastructure. That is
also what makes the **Phase 3 replay test** possible: load the 2026 schedule and
real results, run them through the tiebreaker, and compare against what actually
happened.

---

## Layout

```
src/
  domain/            pure logic — no I/O, fully tested
    types.ts           shared types, points and cap constants
    divisionRules.ts   per-division rules + validation on read
    records.ts         W/L/T, points, runs, capped differential, game counts
    tiebreak.ts        the tiebreaker engine and its reasoning output
    gameStatus.ts      the overdue clock and HQ board ordering
    scoreParsing.ts    deterministic score-text reader
    time.ts            tournament-local wall clock handling
    schedule/          CSV reader and schedule import validation
    messaging.ts       message bodies, chase planning, backoff, SMS segments
    phone.ts           E.164 normalisation
  db/
    migrations/        plain numbered SQL
    client.ts          pool, transactions, timestamp type parsing
    migrate.ts         migration runner
    seed.ts            development data
  server/              database-backed services (repo, auth, events, parser)
    sms.ts             the Twilio call, and nothing else
    outbox.ts          claim, send, retry, give up
    scoreChase.ts      who to ask, and which diamonds have nobody
    tick.ts            one pass of all of it, plus the inline worker
    inbound.ts         webhook idempotency
  app/                 Next.js App Router pages and the SMS webhook
```

### Three conventions worth knowing

**1. Times are tournament-local wall clock.** Every time a volunteer sees is a
wall clock time in Kanata. `scheduled_start` is `timestamp` *without* time zone,
and domain `Date` objects hold local values in their UTC fields — read them with
`getUTC*`. The single conversion from a real instant is `toWallClock()`, at the
edge. Real instants (`created_at`, `sent_at`) stay `timestamptz`.

**2. Everything is scoped by `tournament_id`.** There is one tournament today.
Scoping now means cloning 2028 is copying rows, not migrating a schema.

**3. Append-only means append-only.** `score_report` and `event` reject `UPDATE`
and `DELETE` at the database level, via trigger. No future code path can quietly
rewrite history — which is the entire point of having a trail when a coach
disputes a standing at 8pm on Sunday.

---

## Two design decisions worth defending

**The engine never simulates a coin flip.** When the rules run out, it reports
that a flip is required and orders the group provisionally, saying so. A
director flips a real coin and records it; only then does the standing become
final. Software should not invent the answer to a question the rules hand to a
person.

**Every tiebreak shows its work.** Each placement carries the sentence that
produced it — *"Kanata Major A advances on runs allowed: 12 vs 15."* Directors
keep paper because they don't trust opaque math. This is the part that makes the
paper stop mattering.

---

## Score intake

Three paths, one queue (§5.2). All of them end at a person.

1. **Diamond volunteer** replies to a prompt — the primary route.
2. **Coach texts** unprompted — accepted on the same number.
3. **HQ types in** a phoned-in score.

**The prompt is real.** When a game should be finishing, the volunteer on shift
at that diamond gets a text naming the game and asking for the score. If nothing
comes back by the end of the division's grace period they get one nudge, and
then nothing more — the game turns red on the board and it becomes a phone call.
A game with nobody on shift is never chased; it is counted as uncovered and
shown on `/hq/shifts`, because that gap is otherwise completely invisible.

Inbound text is read by a deterministic parser first. Most replies —
`Kanata 12 Orleans 5`, `12-5` — parse locally with no model call, which keeps
score intake working when the API is slow and keeps donation dollars out of
token spend. Anything it is not confident about goes to the model with that
diamond's scheduled games as context; anything the model can't read lands in the
queue with the raw text showing for a human to read.

Nothing is ever dropped. A text that cannot be attached to a game at all — an
unknown number, no games running nearby, or no score in the message — lands on
`/hq/unmatched`, with any photo attached, for someone to read and either file
against a game or dismiss with a reason. That screen is the last link in the
fallback chain, and the board carries a badge whenever anything is waiting on it.

Forfeits are never auto-filled regardless of confidence — a forfeit bars a team
from winning a tiebreaker, so a director confirms it.

Every inbound text is recorded against Twilio's `MessageSid` before anything is
written. Twilio retries a webhook that times out, and without that record a
retry would create a second `score_report` for the same text — in an
append-only table, so the duplicate could never be removed.

---

## Outbound messaging

A worker runs **inside the web process**, every 30 seconds: reclaim anything a
dead worker was holding, ask whoever is owed a score request, send what is due.
No second service and no cron to configure — a deploy is the whole setup.

- **Nothing sends twice.** Sends claim their row with `FOR UPDATE SKIP LOCKED`;
  chases dedupe on a unique index. Running two workers is wasteful, not wrong.
- **Nothing fails silently.** Retries at 1, 5 and 20 minutes, then the message
  is marked failed and appears on `/hq/messages` with a plain-English reason and
  a retry button. The board carries a banner when anything has given up.
- **Nothing goes out overnight.** The queue holds between 23:00 and 07:00. Not
  for the game that finishes at 2am — none do — but for the backlog that would
  otherwise empty four hundred texts into people's pockets when sending recovers.
- **Nothing costs more than it should.** One character outside GSM-7 drops a
  message from 160 characters per billable segment to 70. Message bodies avoid
  them, `smsSegments` is tested, and anything over one segment is flagged.

`/hq/messages` is the screen that answers "is the chasing actually happening?" —
a different question from the board's "what still needs chasing?".

Without Twilio credentials the transport prints to the server log instead, so
the whole loop can be exercised locally. In production that fallback is refused
rather than silently pretending: "messages went to the log" and "messages were
delivered" look identical from the HQ board, and only one of them is true.

---

## Before this is used for anything real

- Enter each division's actual rules from its published PDF. Every division
  currently carries Major's 2026 numbers with `rules_reviewed = false`. **The
  time limit drives the overdue clock**, so a wrong value quietly breaks the HQ
  board.
- Set `TWILIO_AUTH_TOKEN`. Without it the SMS webhook refuses all traffic in
  production — deliberately, since anyone who guesses the URL could otherwise
  post scores that decide who plays on Sunday.
- Set the rest of the Twilio variables too, or nothing is delivered. Prefer
  `TWILIO_MESSAGING_SERVICE_SID` over a bare `TWILIO_FROM_NUMBER`: a long code
  sends about one message per second, so a broadcast to ninety teams takes three
  minutes to drain and Saturday evening has several bursts overlapping.
- Put diamond volunteers on shift at `/hq/shifts`. Without them nobody is asked
  for a score and the primary intake path does not run — the coverage table on
  that screen is the thing to check in June, not in July.
- Load-test the Saturday-evening peak specifically (§11). The profile is dead
  for 51 weeks, then every diamond finishing at once.
- Read [DECISIONS.md](DECISIONS.md) and get the open questions answered.
- Read [docs/IDEAS.md](docs/IDEAS.md) — what is missing, ordered by whether it
  would hurt to skip. The messaging spine is first for a reason.
- To put it on Railway, see [docs/DEPLOY.md](docs/DEPLOY.md).

> The 2027 parallel run is non-negotiable (spec §12). This tournament has run 29
> years and raised over $536,000 for CHEO Cardiology. It cannot have a bad year
> because of new software.
