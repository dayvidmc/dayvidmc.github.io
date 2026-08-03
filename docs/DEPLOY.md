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

Leave unset for anything real. Optional, none of it needed to boot:
`TWILIO_WEBHOOK_URL`, `ANTHROPIC_API_KEY`, `SQUARE_APPLICATION_ID`.

Needed before any text is sent or received — see §5 below:
`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` or
`TWILIO_MESSAGING_SERVICE_SID`, and `CRON_SECRET`.

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

## 5. Schedule the sender — nothing sends without this

**This is the step that is easy to skip and expensive to skip.** Every outbound
text — the score request that starts intake path 1, the nudge, the confirmation
to both coaches, every broadcast — is written to a queue and sent by
`POST /api/tick`. If nothing calls that endpoint, messages pile up and no
volunteer is ever asked for a score.

In Railway: **New → Cron**, in the same project.

| Setting | Value |
|---|---|
| Schedule | `* * * * *` (Railway cron is per-minute; see below) |
| Command | `curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" "$APP_URL/api/tick"` |

Set `CRON_SECRET` to a long random string (`openssl rand -base64 32`) on both
the web service and the cron, and `APP_URL` to the service's public URL.

**Per-minute is the floor Railway cron offers, and it is fine.** The spec's
clocks are in tens of minutes — grace periods, a fifteen-minute escalation — so
a message waiting up to sixty seconds changes nothing anyone will notice. If you
want it tighter, the endpoint is safe to call as often as you like: enqueueing
is deduped by key and sending claims rows with `FOR UPDATE SKIP LOCKED`, so
overlapping runs do less work rather than wrong work.

Verify it before you rely on it: `/hq/messages` says how long ago the sender
last ran, and the HQ board carries a red banner when it has gone quiet. There is
also a **"Send whatever is waiting now"** button on that screen for proving it
works on a Tuesday in March.

### Pick the Twilio number type deliberately

A **long code** sends roughly one message per second. Ninety teams × two coaches
is ~180 messages, so a bracket-publish broadcast takes three minutes to drain —
and Saturday evening will have several bursts overlapping. Either use a
**Messaging Service** with a toll-free or short code
(`TWILIO_MESSAGING_SERVICE_SID`), or accept the lag knowingly. Decide this in
advance rather than discovering it at 7pm on the Saturday.

### Cost

The messages screen shows **segments**, not message count, because segments are
what Twilio bills. Every composed message is held to one GSM-7 segment by a
test — one emoji or one em dash would drop the budget from 160 characters to 70
and double the largest line on the bill.

Rough weekend estimate at Canadian SMS rates: ~150 games × (1 request + some
nudges + 2 confirmations) plus a few broadcasts lands in the low thousands of
segments — tens of dollars, not hundreds. Spec §11 budgets the whole weekend,
hosting included, under $200. That still holds.

## 6. Load the demo data

Once it is up, from the Railway service shell:

```bash
npm run demo
```

That creates a tournament dated relative to *now*, so the board shows live
statuses rather than grey rows: yesterday's round robin complete, today's games
variously final, on now, upcoming and one disputed, three concession stands with
a menu, two texts nobody could place, and a diamond volunteer on shift at every
diamond so the score-request path has someone to text.

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
5. `/hq/messages` — every text the system has sent, what it cost in segments,
   and anything it could not deliver. With `SMS_DRY_RUN=true` the "Send whatever
   is waiting now" button drains the queue to the log, so the whole path can be
   shown without a Twilio account
6. Sign in as **Concession Volunteer** → `/pos` — open a till, sell a hot dog,
   take cash, get change
7. Sign in as **Concession Lead** → `/hq/concessions` — takings, then close the
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
- **`CRON_SECRET` set and the cron scheduled** (§5). Without it nothing sends,
  and the symptom — a board slowly filling with overdue games — looks exactly
  like volunteers being slow to reply.
- **`SMS_DRY_RUN` off.** The messages screen warns when it is on.
- **Diamond volunteer shifts loaded.** They are what tells the system who to
  text about which diamond. With none, `/hq/messages` lists every unchased game
  under "no volunteer to ask" — which is accurate, and not a substitute for
  having people.
- **Turn on Railway's Postgres backups.** Losing Saturday's scores loses the
  tournament.

## Cost

One small service plus a Postgres instance sits near the bottom of a Hobby plan
most of the year, since it is idle for 51 weeks. The weekend itself is a few
hundred requests a minute at peak — well inside a small instance.

The number worth having before the board asks is the *total*: hosting plus SMS.
Spec §11 puts the whole weekend under $200, and SMS will dominate that once
outbound sending exists.
