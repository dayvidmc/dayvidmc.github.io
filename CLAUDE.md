# Working on this repository

## Before asking the committee anything

**Read `docs/ANSWERS.md` first.** It holds every question already put to the
family and the answer given, the facts taken from the tournament's own website,
and a list of what is genuinely still open.

Then grep `DECISIONS.md`, then grep the migrations. A fact that shaped a schema
is usually recorded in a comment next to the column it shaped — that is where
three already-answered questions were sitting when they were asked a second
time.

Asking a volunteer something they have already explained is a small rudeness
that adds up, and it spends the goodwill needed for the questions that really
are open. When something is *nearly* known, ask it as a confirmation — "the
schema assumes X, is that still right?" — not as though nothing is known.

**Write down every new answer in `docs/ANSWERS.md` in the same turn it
arrives.** An answer that lives only in a conversation is an answer that gets
asked for again.

## What this is

The Scott Tokessy Memorial Gold Glove Tournament, Kanata — Canada's largest
Little League charity tournament, founded 1996, run entirely by volunteers.
Every dollar goes to CHEO Cardiology; $536,000 since the beginning. This
repository is both the operations tool that runs the weekend **and** the public
website.

Who to ask what: **father** — game operations, rosters, scheduling, brackets,
umpires, rules. **Mother** — concessions, sponsors, the treasurer's work.
**Committee** — anything with money or risk attached.

## Conventions that are load-bearing

- **`domain/` is pure.** No database, no network, no clock reads — the clock is
  always passed in. That is what makes the whole suite run in a few seconds
  with no infrastructure.
- **Money is integer cents.** A float never touches a price.
- **Wall clock time.** `timestamp` without time zone holds tournament-local
  time; there is one conversion, `toWallClock()`. Real instants
  (`created_at`, `sent_at`) stay `timestamptz`.
- **Append-only where it matters.** `score_report`, `event`, `pos_refund`,
  `entry_payment`, `gold_glove_draw` carry a trigger refusing UPDATE and
  DELETE. Corrections are new rows.
- **No HTML from the database.** Page bodies are parsed into a node tree that
  React renders. There is no `dangerouslySetInnerHTML` in this repository and
  there must never be one.
- **Everything is scoped by `tournament_id`.**
- **Progressive enhancement.** Every interaction works as a form post. A
  submitter button's `name`/`value` does *not* reach a Next.js server action —
  use `action.bind(null, value)` with `formAction` per button.

## Before pushing

```bash
npm run typecheck
npm test
CHECK_DATABASE_URL=postgres://…/tokessy_check npm run migrate:check   # both passes
```

And verify in a real browser against a real database, at 390px. Every module
built so far produced defects the unit tests missed. Write the checks as
assertions — a check written as a conditional skip passes while hiding the
thing it was meant to catch, which has happened twice here.

Record judgement calls in `DECISIONS.md`, and what was left undone in
`docs/IDEAS.md`.
