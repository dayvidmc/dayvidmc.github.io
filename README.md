# Tokessy Tournament Operations

Operations tool for the **Scott Tokessy Memorial Gold Glove Tournament** — 30th
annual, late July 2027, in support of CHEO Cardiology.

> **Status: pre-Phase-0.** The build spec is Draft v1 and explicitly provisional
> until the director debrief (spec §12, Phase 0). This repository contains the
> foundation and the game-operations core. See [DECISIONS.md](DECISIONS.md) for
> every assumption made along the way and what still needs a human answer.

[`docs/AUDIT.md`](docs/AUDIT.md) is the security and correctness pass: what was
tested, what was wrong, and what is still open.

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
| HQ screen for texts nobody could place | §5.2 | Built |
| HQ board with overdue clock | §5.3 | Built, tested |
| Division rules config | §5.4 | Built — auto-saving editor with a live overdue-clock preview, and one document applied across every division since that is how they are published |
| Standings and tiebreakers | §5.5 | Built, tested — the core deliverable; flags a pool the weather made uneven rather than seeding it |
| Game count tracking (financial) | §5.8 | Built, tested |
| Team links, no login | §5.7 | Built |
| Tile + PIN staff access | §10 | Built — each role signs in to the first screen of their own job, with a menu of what they may open and a way out from every screen |
| The tool on a desk | §4 | Built — a navigation column and denser controls from 1000px with a mouse; the same list folds back to a dropdown on a phone, and the phone sizing is untouched |
| Game detail: correct, dispute, reschedule, history | §5.3 | Built |
| Team contacts and per-team links | §5.7 | Built — auto-saving |
| Settings and pre-weekend readiness checklist | — | Built |
| Concessions till, offline-capable | §8 | Built, tested — cash and Square hand-off; markdowns set by a lead, never typed at the till |
| Public schedule with live status | §5.7 | Built, tested |
| Playoff bracket — the map, drawn before it is played | §5.6 | Built, tested — structure must still be seeded by hand |
| Umpires: roster, crews with conflict checks, their own link, honoraria | — | Built, tested — not in the spec at all; see `docs/BRAINSTORM.md` §4. The crew is a mix of paid and volunteer, and the pay screen only chases a rate for the ones who should have one |
| Registration and rosters, no payments | — | Built, tested — Module E's fees stay deferred |
| Outbound SMS: sender, retries, opt-outs, failure screen | §5.7 | Built, tested — **dry run by default**; needs a Twilio account to reach a phone |
| Outbound email: entry confirmations, decisions, balance chases | §5.7 | Built, tested — same queue and failure screen as the texts, its own unsubscribe list. **Dry run by default**; needs a verified sending domain |
| Money raised: every stream, cost of goods, gifts in kind, cash control | §8A | Built, tested — costs as receipts or per item; the raffle is still recorded by hand |
| What it cost, and who fronted it | §8A | Built, tested — one line per shop, and volunteers owed money are named until paid back |
| Sponsors: what was promised, the pamphlet list, the thank-you list | §7 | Built, tested — links a gift to what it fetched at the auction |
| Silent auction: lots, printable bid sheets, a fast close, winners, payment | §7.3 | Built, tested — reports itself into the money total |
| Team entries: a timed opening, a queue, caps and waitlists, deposits and balances | §8A/E | Built, tested — thirteen divisions grouped by age group, refund terms stated before payment; e-transfer and cheque work out of the box, card needs a merchant account |
| Volunteers: the list, shifts, coverage gaps, their own link | §6 | Built, tested — a diamond shift is also what makes score intake recognise that phone |
| Volunteers: site supervisors covering a whole site | §6 | Built, tested — this is who the signed sheets actually reach, and their phone is recognised for every diamond at their site |
| Concession tickets from the team packages | §8 | Built, tested — a third tender, so food given away is neither counted as takings nor lost from the books |
| Donations: a public page, a live total against last year | §8A | Built, tested — off until the committee turns it on; nobody is thanked by name who did not ask to be |
| Receipts for CHEO | §8A.4 | Built — CHEO issues them, so this collects the address, hands the list over and records that it went. Nothing is sent from here |
| Cash that goes home overnight | §8A | Built, tested — who has it and since when, because that protects the volunteer as much as the money |
| Trophies: the engraving list, and the Gold Glove draw | — | Built, tested — the draw records its pool size and seed so it can be shown to have been straight |
| **The public website itself** | — | Built, tested — pages the committee edits, the honour roll, sponsors, directions, a volunteer sign-up. This is the site, not a tool beside it |
| Coin flips | §5.5 | Built — the one placement a person decides, recorded and named on the public standings |
| Append-only audit trail | §9 | Built, enforced by the database |

## The site it now is

This started as an operations tool sitting beside a WordPress site. It is now
both, because each half needed the other: the public site's most-wanted pages
during the weekend are the schedule and the results, which only this database
has — and the tool's most valuable public moment, a live fundraising total on a
page a parent is already reading, only works if that page is this one.

```
/                     what is on today, the running total, and what this is
/schedule             every division, with what is on now
/standings            every division, with the tiebreakers shown
/bracket              the Sunday map, filling in as it goes
/results              the honour roll — this year live, every year before it recorded
/donate               a running total against last year, and a way to give
/volunteer            what is short this weekend, and a form to put your name down
/sponsors             who agreed to be named, and what they gave
/contact              who to email about what, and where every diamond is
/enter                a timed opening, a queue, deposits and balances
/p/<anything>         a page the committee wrote — Scott's story, the rules, visiting Kanata
/team/<token>         one team's games, times, diamonds and roster
/hq                   the board, and everything behind it
/pos                  the concession till
```

Every page the committee writes is a row, editable from `/hq/site`. Page bodies
are a markdown subset parsed into a tree of nodes that React renders — there is
no `dangerouslySetInnerHTML` in this repository and there must never be one, so
a body cannot introduce a tag, an attribute or a script whatever gets pasted
into the editor.

## What is deliberately not here

Per the spec's own build order, and because these need answers this repository
cannot supply:

- **A way to *build* a bracket from a screen.** The map, the seeding, the
  propagation and the director's per-slot override are all built and tested.
  Creating the structure is not: `bracket_slot` rows are written by the demo
  seed, and a director with a real playoff schedule has no screen for it. §13
  Q4 — how he builds it today — decides which shape that screen takes. See
  `docs/IDEAS.md` §3.
- **A broadcast composer and the rain button (§5.7).** The pipeline that would
  carry them now exists — see below — but there is no screen for writing a
  message to a whole division, and no rain-delay recompute behind it.
- **Card processing.** The till records card sales; it does not charge them.
  Tapping a card on a phone needs a native app — Apple and Google only expose
  the NFC reader to signed native apps — so the card tap happens in the Square
  app and this records the result. See `docs/CONCESSIONS.md`.
- **Sponsor relationships beyond the pamphlet and the thank-you list.** The
  auction (Module C), team entries with payment (Module E) and volunteers
  (Module B) are built.
- **A card form of our own.** Card payments go through a hosted checkout on the
  provider's page, so no card number reaches this server. That is deliberate
  and permanent — see `DECISIONS.md` §2.23.
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
npm test          # 440+ unit tests, no database needed
npm run typecheck
npm run build

# Migrations, against a throwaway database. Applies them twice: once to an
# empty database, and once to one carrying data from every earlier migration.
CHECK_DATABASE_URL=postgres://…/tokessy_migcheck npm run migrate:check
```

The second migration pass exists because of a real outage. A migration that
rebuilt a CHECK constraint from an outdated list passed against every fresh
database and was rejected by the live one, which held a value added by a later
migration — and since migrations run on boot, the site would not start. A
fresh-database test cannot catch that by construction.

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
    bracket.ts         playoff slots that resolve to a team, a seed or a winner
    umpires.ts         crew conflicts, workload, and what each umpire is owed
    contact.ts         phone and email normalising, shared by every editor
    messaging.ts       send scheduling, opt-out keywords, what a text costs
    fundraising.ts     taken vs raised, where the cash is, gifts in kind
    time.ts            tournament-local wall clock handling
    schedule/          CSV reader and schedule import validation
  db/
    migrations/        plain numbered SQL
    client.ts          pool, transactions, timestamp type parsing
    migrate.ts         migration runner
    seed.ts            development data
  server/              database-backed services (repo, auth, events, parser)
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

---

## Before this is used for anything real

- Enter the tournament's actual rules from the published document. Every
  division currently carries Major's 2026 numbers with `rules_reviewed =
  false`. One document covers all the divisions, so the way to do this is to
  type it into one division and press *apply to every division*, then go back
  and type the exceptions. **The time limit drives the overdue clock**, so a
  wrong value quietly breaks the HQ board.
- Set `TWILIO_AUTH_TOKEN`. Without it the SMS webhook refuses all traffic in
  production — deliberately, since anyone who guesses the URL could otherwise
  post scores that decide who plays on Sunday.
- Load-test the Saturday-evening peak specifically (§11). The profile is dead
  for 51 weeks, then every diamond finishing at once.
- Read [docs/ANSWERS.md](docs/ANSWERS.md) **before asking the committee
  anything.** Every question already put to the family and the answer given,
  what the tournament's own website says, and what is genuinely still open. It
  exists because three questions were asked twice, and both times the answer was
  already written down in this repository.
- Read [DECISIONS.md](DECISIONS.md) and get the open questions answered.
- Read [docs/IDEAS.md](docs/IDEAS.md) — what is missing, ordered by whether it
  would hurt to skip. The messaging spine is first for a reason.
- Read [docs/BRAINSTORM.md](docs/BRAINSTORM.md) — the same territory approached
  from the other end: what each person's weekend actually needs. Written to be
  argued with at the debrief. It is where the missing umpire came from.
- To put it on Railway, see [docs/DEPLOY.md](docs/DEPLOY.md).

> The 2027 parallel run is non-negotiable (spec §12). This tournament has run 29
> years and raised over $536,000 for CHEO Cardiology. It cannot have a bad year
> because of new software.
