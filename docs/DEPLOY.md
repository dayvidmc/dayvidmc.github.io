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

**For texts to actually send**, all of these:

| Variable | Value |
|---|---|
| `TWILIO_ACCOUNT_SID` | from the Twilio console |
| `TWILIO_AUTH_TOKEN` | from the Twilio console — also required for inbound |
| `TWILIO_FROM_NUMBER` | *or* `TWILIO_MESSAGING_SERVICE_SID`, see below |
| `CRON_SECRET` | a long random string — the heartbeat will not run without it |

Without a from number the service refuses to boot the sender rather than
quietly pretending to send. To run a deployment deliberately without sending
real texts — a staging copy, say — set `ALLOW_LOG_SMS=true` and messages are
written to the log with a `log:` provider id instead.

Tuning, all optional:

| Variable | Default | What it does |
|---|---|---|
| `SMS_RATE_PER_SECOND` | `1` | Matches a long code. Raise it for a Messaging Service. |
| `SMS_BATCH_LIMIT` | `50` | Messages claimed per heartbeat. |
| `SMS_DRAIN_MAX_MS` | `25000` | Stops a heartbeat request hanging. |

Optional, none of it needed to boot: `TWILIO_WEBHOOK_URL`,
`ANTHROPIC_API_KEY`, `SQUARE_APPLICATION_ID`.

## 4. Schedule the heartbeat

**This is the step that is easy to skip and impossible to notice missing.**
Nothing asks a volunteer for a score and nothing drains the outbound queue
except a scheduled call to:

```
POST /api/cron/messaging
Authorization: Bearer $CRON_SECRET
```

In Railway, add a second service in the same project pointed at this repo with
a **cron schedule of `* * * * *`** and a start command of:

```bash
curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" "$APP_URL/api/cron/messaging"
```

Every minute is right, not excessive: the endpoint is idempotent, a run with
nothing to do is two cheap queries, and the cost of being a minute late is a
volunteer waiting a minute longer. Any scheduler works — Railway cron, a GitHub
Actions schedule, cron-job.org — the endpoint only cares about the bearer token.

The response says what it did, which is what to check when something looks
wrong:

```json
{"date":"2027-07-24","asked":3,"nudged":1,"uncovered":0,
 "claimed":4,"sent":4,"failed":0,"abandoned":0}
```

`/hq/settings` lists the heartbeat in its readiness checklist, and `/hq/messages`
warns when the oldest queued message has been waiting more than ten minutes —
which is what a stopped heartbeat looks like from the inside.

## 5. Deploy

`railway.json` already sets the build and start commands and points the health
check at `/api/health`, so there is nothing to configure.

**Migrations run on boot.** `npm run start` is `npm run migrate && next start`,
and the migration runner takes a Postgres advisory lock first, so two instances
starting together cannot race. A deploy that adds a migration applies it before
serving traffic.

`/api/health` checks the database, not just that Node is alive — a process that
boots happily but cannot reach Postgres fails the check instead of taking
traffic.

## 6. Load the demo data

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
- **Roster the diamond volunteers** at `/hq/diamonds`. This is the linchpin:
  a diamond with nobody on shift is a diamond where nobody is ever asked for a
  score, and those games go red with no explanation. The screen lists the gaps
  at the top, and `/hq/settings` counts them.
- **Confirm the heartbeat is actually firing** — see step 4. Everything else
  can be configured perfectly and nothing will send.
- **Decide the sending number.** A long code sends roughly one message per
  second, so a broadcast to ninety teams takes about three minutes to drain and
  Saturday evening will have bursts overlapping. A Messaging Service with a
  toll-free number is the fix; either is fine, but decide deliberately rather
  than discovering it at 7pm.
- **Turn on Railway's Postgres backups.** Losing Saturday's scores loses the
  tournament.

## Cost

One small service plus a Postgres instance sits near the bottom of a Hobby plan
most of the year, since it is idle for 51 weeks. The weekend itself is a few
hundred requests a minute at peak — well inside a small instance.

The number worth having before the board asks is the *total*: hosting plus SMS.
Spec §11 puts the whole weekend under $200, and SMS dominates it.

SMS is billed per *segment*, not per message. `/hq/messages` shows the running
segment count and an estimate at long-code rates, so the figure comes from what
was actually sent rather than a guess. As a rough shape: ~150 round robin games
generating an ask, some nudges, and two confirmations each, plus a handful of
broadcasts to ninety teams, lands in the low tens of dollars — comfortably
inside the spec's ceiling, as long as every message stays one segment. It does
so today because every template is plain ASCII; the tests enforce that, since a
single em dash cuts a segment from 160 characters to 70.
