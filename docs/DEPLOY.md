# Deploying to Railway

Everything needed is in the repo. I could not run the deploy myself — this
container has no Railway credentials — so the steps below are yours to run, and
they should take about ten minutes.

---

## 1. New project, same account as Pawl

In Railway, **New Project → Deploy from GitHub repo**, pick this repository and
the branch `claude/tokessy-tournament-ops-v1o6id`.

Keep it a **separate project** from Pawl rather than a second service inside it.
Separate projects get separate databases, separate environment variables and
separate usage — which matters here because this one is dead for 51 weeks and
then very much alive for three days, and you do not want that spike sharing a
plan with something you rely on year-round.

## 2. Add Postgres

**New → Database → Add PostgreSQL**, in the same project. Railway sets
`DATABASE_URL` on the service automatically once they are linked.

## 3. Environment variables

Required:

| Variable | Value |
|---|---|
| `DATABASE_URL` | set by Railway when you attach Postgres |
| `SESSION_SECRET` | a long random string — `openssl rand -base64 48` |

Rotating `SESSION_SECRET` signs everyone out and invalidates every outstanding
team link, so set it once and leave it.

For the demo (see below):

| Variable | Value |
|---|---|
| `DEMO_MODE` | `true` |

Leave unset for anything real.

**For texts to actually be delivered** — none of it needed to boot, but without
it outbound messages are printed to the server log in development and refused
outright in production:

| Variable | Value |
|---|---|
| `TWILIO_ACCOUNT_SID` | from the Twilio console |
| `TWILIO_AUTH_TOKEN` | also gates the inbound webhook — required in production |
| `TWILIO_MESSAGING_SERVICE_SID` | **preferred** — see below |
| `TWILIO_FROM_NUMBER` | only if there is no Messaging Service |
| `TWILIO_WEBHOOK_URL` | the public URL of `POST /api/sms/inbound`, for signature checking behind Railway's proxy |

Use a **Messaging Service** rather than a bare number if you can. A long code
sends about one message per second, so a broadcast to ninety teams takes three
minutes to drain and Saturday evening has several bursts overlapping. The outbox
paces itself to match when it has to, but a Messaging Service does that queueing
properly on Twilio's side.

Also optional: `ANTHROPIC_API_KEY` (score parsing), `SQUARE_APPLICATION_ID`,
and `CRON_SECRET` (see *Outbound messaging* below).

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

### Outbound messaging needs no setup

There is **no worker service and no cron to configure**. The messaging worker
runs inside the web process, started by the first health check, and ticks every
30 seconds. That is deliberate: a second service is a second thing to redeploy,
and its failure mode is that somebody forgets — with the symptom appearing on
Saturday as "the texts stopped" and nothing on the board to explain it.

If you would rather drive it externally, set `SMS_WORKER=off` and `CRON_SECRET`,
and have something POST to `/api/jobs/tick` with `Authorization: Bearer
$CRON_SECRET`. Setting `CRON_SECRET` alone just adds a manual trigger; the
inline worker keeps running.

`/hq/messages` is where to look if you are wondering whether any of this is
working. It shows the queue, what failed and why, and warns if the oldest queued
message has been sitting for more than ten minutes — which is what a worker that
never started looks like.

## 5. Load the demo data

Once it is up, from the Railway service shell:

```bash
npm run demo
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
5. `/hq/messages` — the score request that went out for the overdue game, and
   the nudge that followed it. Without Twilio credentials these are logged
   rather than delivered, and the screen says so at the top instead of
   pretending
6. `/hq/shifts` — the coverage table. March Central has a game today and nobody
   on shift, which is the gap that is invisible until something looks for it
7. Sign in as **Concession Volunteer** → `/pos` — open a till, sell a hot dog,
   take cash, get change
8. Sign in as **Concession Lead** → `/hq/concessions` — takings, then close the
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
- **The rest of the Twilio variables**, or nothing is delivered. `/hq/settings`
  and `/hq/messages` both say so in as many words rather than letting a queue
  grow quietly.
- **Diamond volunteers on shift** at `/hq/shifts`. Without them nobody is asked
  for a score and the primary intake path does not run. The coverage table on
  that screen shows exactly which games have nobody to ask.
- **Turn on Railway's Postgres backups.** Losing Saturday's scores loses the
  tournament.

## Cost

One small service plus a Postgres instance sits near the bottom of a Hobby plan
most of the year, since it is idle for 51 weeks. The weekend itself is a few
hundred requests a minute at peak — well inside a small instance.

The number worth having before the board asks is the *total*: hosting plus SMS.
Spec §11 puts the whole weekend under $200, and SMS will dominate that once
outbound sending exists.
