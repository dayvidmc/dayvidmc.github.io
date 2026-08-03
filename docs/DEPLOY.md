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

Needed before any text is sent or received — the app boots without them, it just
cannot do the thing it exists to do:

| Variable | Value |
|---|---|
| `TWILIO_ACCOUNT_SID` | from the Twilio console |
| `TWILIO_AUTH_TOKEN` | also signs the inbound webhook |
| `TWILIO_FROM_NUMBER` | an E.164 number, or a Messaging Service SID (`MG...`) |
| `CRON_SECRET` | `openssl rand -base64 32` — see step 5 |

Optional: `TWILIO_WEBHOOK_URL` (only if Railway's reported URL differs from the
one Twilio signs against), `SMS_MAX_PER_SECOND`, `ANTHROPIC_API_KEY`,
`SQUARE_APPLICATION_ID`.

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

## 5. Schedule the tick

Nothing time-driven happens without this. `POST /api/cron/tick` is what asks
diamond volunteers for scores when their games should have finished, reminds the
ones who have not replied, and drains the outbound queue — so with no scheduler,
score intake path 1 does not run and no queued text ever leaves.

In Railway, **New → Cron Job** (or a cron service in the same project) pointed at
the deployed URL:

```bash
curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" \
  "https://<your-app>.up.railway.app/api/cron/tick"
```

**Every minute** during the tournament (`* * * * *`). It is cheap when there is
nothing to do — one indexed query — and a minute is the resolution at which
"your game should have finished" still feels prompt. Outside the weekend it
returns immediately with `no tournament running`.

Safe to run more often than needed and safe to overlap with itself: prompts
dedupe in the database, and the outbox claims rows with `FOR UPDATE SKIP
LOCKED`, so two ticks take disjoint work rather than sending anything twice.

`-f` makes curl exit non-zero on a failing tick so the run shows as failed
rather than silently green. The body says what went wrong; the most likely
answer is Twilio not being configured.

### Sending rate

`SMS_MAX_PER_SECOND` defaults to `1`, which is roughly what a bare Twilio long
code sustains. Ninety teams times two contacts is ~180 messages, so a
bracket-publish broadcast takes about three minutes to drain, and Saturday
evening will have several bursts overlapping.

Either accept that lag knowingly or set `TWILIO_FROM_NUMBER` to a **Messaging
Service SID** (`MG...`) with a toll-free number and raise the rate. The code
handles both — a value starting `MG` is sent as `MessagingServiceSid` rather
than `From`. Decide before July rather than at 7pm on the Saturday.

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
- **All three Twilio variables and `CRON_SECRET`** must be set, or outbound does
  nothing: without Twilio the tick refuses to run rather than pretend, and
  without the scheduled tick nobody is ever asked for a score. `/hq/settings`
  checks both.
- **Put diamond volunteers on shift.** `diamond_shift` is what says whose phone
  to text about which diamond. A diamond with nobody on shift is one HQ chases
  by hand — `/hq/settings` counts them.
- **Turn on Railway's Postgres backups.** Losing Saturday's scores loses the
  tournament.

## Cost

One small service plus a Postgres instance sits near the bottom of a Hobby plan
most of the year, since it is idle for 51 weeks. The weekend itself is a few
hundred requests a minute at peak — well inside a small instance.

The number worth having before the board asks is the *total*: hosting plus SMS,
and SMS now dominates it. A rough count for the weekend: ~150 round robin games
plus playoffs, each costing a score request and sometimes a reminder, plus a
confirmation to both coaches on approval — call it four or five messages per
game, so somewhere around 800. Add broadcasts, and a rainy weekend where
everything is rescheduled at least once.

At Twilio's Canadian long-code rate that lands in the low tens of dollars, which
is comfortably inside spec §11's $200 for the weekend — but it is worth checking
against real pricing before the board asks, since it comes out of donation
dollars. `/hq/outbox` counts exactly what was sent, so the figure after 2027 will
be a measurement rather than an estimate.
