# Deploying to Railway

Everything needed is in the repo. I could not run the deploy myself — this
container's network policy blocks every Railway host, so the CLI cannot reach
the API from here even with a token. The steps below are yours to run, and they
should take about ten minutes.

## The short version

```bash
railway login                 # once, opens a browser
./scripts/railway-setup.sh
```

That script does sections 1–4 below and then waits for `/api/health` to come
back green. It is safe to re-run: each step checks whether it has already been
done. If one step fails, do that step in the dashboard using the click-path
below and run the script again.

It was written against Railway CLI 5.30.3 with every flag checked against that
version's `--help`, but it has **never been run against a live Railway
account** — nobody could reach one from the container it was written in. Read it
before you run it; it is about a hundred lines and does nothing clever.

---

## 1. New project, same account as Pawl

In Railway, **New Project → Deploy from GitHub repo**, pick this repository and
the branch `claude/tokessy-tournament-ops-3uz5t4`.

Keep it a **separate project** from Pawl rather than a second service inside it.
Separate projects get separate databases, separate environment variables and
separate usage — which matters here because this one is dead for 51 weeks and
then very much alive for three days, and you do not want that spike sharing a
plan with something you rely on year-round.

## 2. Add Postgres

**New → Database → Add PostgreSQL**, in the same project.

This creates a *second service*, named `Postgres`, with its own `DATABASE_URL`.
The app service does **not** inherit it. You have to point one at the other by
setting a reference variable on the app service:

```
DATABASE_URL=${{Postgres.DATABASE_URL}}
```

Type it exactly, braces included — Railway resolves that at deploy time. Miss
this and the app builds fine, boots, fails its migration step, and never passes
the health check. It is the single most likely thing to go wrong.

If you renamed the database service, use its name instead of `Postgres`.

## 3. Environment variables

Required, both on the **app** service:

| Variable | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` — the reference from section 2 |
| `SESSION_SECRET` | a long random string — `openssl rand -base64 48` |

Rotating `SESSION_SECRET` signs everyone out and invalidates every outstanding
team link, so set it once and leave it.

For the demo (see below):

| Variable | Value |
|---|---|
| `DEMO_MODE` | `true` |

Leave unset for anything real. Optional, none of it needed to boot:
`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`,
`TWILIO_WEBHOOK_URL`, `ANTHROPIC_API_KEY`, `SQUARE_APPLICATION_ID`.

## 4. Deploy

`railway.json` already sets the build and start commands and points the health
check at `/api/health`, so there is nothing to configure.

**Migrations run on boot.** `npm run start` is `npm run migrate && next start`,
and the migration runner takes a Postgres advisory lock first, so two instances
starting together cannot race. A deploy that adds a migration applies it before
serving traffic.

`/api/health` checks the database, not just that Node is alive — a process that
boots happily but cannot reach Postgres fails the check instead of taking
traffic.

## 5. Load the demo data

Once it is up, from your own machine:

```bash
railway ssh --service tokessy-ops 'npm run demo'
```

There is no in-browser shell for a service, so this runs over Railway's SSH.
If it will not connect, run the seeder locally against the database's *public*
URL instead — `DATABASE_URL` inside Railway points at `postgres.railway.internal`,
which only resolves from inside the project:

```bash
DATABASE_URL="$(railway variable list --service Postgres --kv \
  | sed -n 's/^DATABASE_PUBLIC_URL=//p')" npm run demo
```

That creates a tournament dated relative to *now*, so the board shows live
statuses rather than grey rows: yesterday's round robin complete, today's games
variously final, on now, upcoming and one disputed, three concession stands with
a menu, and two texts nobody could place.

It refuses to run against a database that already has a tournament. To start
over you have to drop and recreate the database — a tournament with history
cannot be deleted, because the event log is append-only by design.

---

## Demo accounts

With `DEMO_MODE=true`, the sign-in screen shows each tile's PIN underneath it,
so nobody has to be told one over the phone.

| Tile | Role | PIN | What they can see |
|---|---|---|---|
| Tournament Director | director | `4021` | Everything — board, rules, schedule import, corrections |
| HQ Desk 1 | hq | `5150` | Board, score queue, unmatched texts |
| HQ Desk 2 | hq | `6274` | Same as HQ Desk 1 |
| Concession Lead | concession_lead | `2260` | Till, menu, refunds, closing a drawer |
| Concession Volunteer | concession_volunteer | `9074` | Till only — no refunds, no price edits |
| Volunteer Coordinator | volunteer_coordinator | `7318` | Nothing yet — Module B is unbuilt |
| Auction Lead | auction_lead | `8493` | Nothing yet — Module C is unbuilt |

**A good tour for someone seeing it for the first time**, no sign-in needed for
the first two:

1. `/schedule` — pick a division, see what is on now, final and upcoming
2. `/standings/…` — the three-way tie, with the tiebreaker explaining itself
3. Sign in as **HQ Desk 1** → `/hq` — the board, worst-first
4. `/hq/queue` — approve a score, and watch the standings move
5. Sign in as **Concession Volunteer** → `/pos` — open a till, sell a hot dog,
   take cash, get change
6. Sign in as **Concession Lead** → `/hq/concessions` — takings, then close the
   till and count the cash

Try signing in as the **Concession Volunteer** and visiting `/hq/concessions` —
it tells you plainly that the screen is not yours rather than pretending you are
logged out. And try a wrong PIN five times; the tile locks for fifteen minutes.

### Turn `DEMO_MODE` off before this holds anything real

The banner says so on every sign-in. `demo_pin` is only ever populated by
`npm run demo`, so switching the flag on against real data shows nothing rather
than leaking a working PIN — but the flag should still be off.

---

## Before it holds anything real

- **`DEMO_MODE` off**, and re-seed from a real schedule import rather than
  `npm run demo`.
- **Enter each division's real rules** from its published PDF at `/hq/rules`.
  Everything starts marked unchecked. The time limit drives the overdue clock,
  so a wrong value quietly breaks score chasing.
- **`TWILIO_AUTH_TOKEN`** must be set or the inbound webhook refuses everything
  in production — deliberately, since anyone who guesses the URL could otherwise
  post scores that decide who plays on Sunday.
- **Outbound texts still do not send.** Rows pile up in `notification` and
  nothing drains them. `/hq/settings` shows the queue depth and says so. This is
  item 1 in `docs/IDEAS.md`.
- **Turn on Railway's Postgres backups.** Losing Saturday's scores loses the
  tournament.

## Cost

One small service plus a Postgres instance sits near the bottom of a Hobby plan
most of the year, since it is idle for 51 weeks. The weekend itself is a few
hundred requests a minute at peak — well inside a small instance.

The number worth having before the board asks is the *total*: hosting plus SMS.
Spec §11 puts the whole weekend under $200, and SMS will dominate that once
outbound sending exists.
