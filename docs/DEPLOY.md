# Deploying to Railway

Everything needed is in the repo. I could not run the deploy myself — this
container has no Railway credentials — so the steps below are yours to run, and
they should take about ten minutes.

---

## 1. Pick the branch

Railway tracks **one** branch. The work is on
`claude/tokessy-tournament-ops-v1o6id`, not `main`, so either merge it to `main`
first or point Railway at that branch in **Settings → Source → Branch** after
step 2.

## 2. New project, same account as Pawl

**New Project → Deploy from GitHub repo →** `dayvidmc/dayvidmc.github.io`.

Keep it a **separate project** from Pawl rather than a second service inside it.
Separate projects get separate databases, variables and usage — which matters
here because this one is dead for 51 weeks and then very much alive for three
days, and that spike should not share a plan with something you rely on
year-round.

The first build will fail or boot-loop until step 4 gives it a database. That is
expected; don't chase it.

## 3. Add Postgres

In the project canvas: **New → Database → Add PostgreSQL**.

## 4. Point the app at the database

This does **not** happen automatically — Railway puts `DATABASE_URL` on the
*Postgres* service, not on your app. On the **app** service:

**Variables → New Variable →** name `DATABASE_URL`, value:

```
${{Postgres.DATABASE_URL}}
```

That is Railway's reference syntax; `Postgres` is the service name, so match
whatever the database service is actually called. Using the reference rather
than pasting the connection string means it keeps working if Railway rotates
the credentials.

## 5. The other variables

On the app service:

| Variable | Value |
|---|---|
| `SESSION_SECRET` | a long random string — `openssl rand -base64 48` |
| `DEMO_MODE` | `true` while your parents are trying it; unset for anything real |

Rotating `SESSION_SECRET` signs everyone out and invalidates every outstanding
team link, so set it once and leave it.

Optional, none of it needed to boot: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
`TWILIO_FROM_NUMBER`, `TWILIO_WEBHOOK_URL`, `ANTHROPIC_API_KEY`,
`SQUARE_APPLICATION_ID`.

## 6. Give it a URL

**Settings → Networking → Generate Domain.** Railway injects `PORT` and
`next start` respects it, so there is nothing to set.

## 7. Watch the first real deploy

`railway.json` already sets the build and start commands and points the health
check at `/api/health`, so there is nothing to configure. Redeploy after step 4
if it has not picked the change up.

**Migrations run on boot.** `npm run start` is `npm run migrate && next start`,
and the runner takes a Postgres advisory lock first, so two instances starting
together cannot race. The deploy log should show, before Next starts:

```
applying 001_game_operations.sql ... ok
applying 002_unmatched_messages.sql ... ok
applying 003_concessions.sql ... ok
applying 004_pin_lockout.sql ... ok
```

Then `curl https://<your-domain>/api/health` should return
`{"ok":true,"migrations":4,...}`. That endpoint checks the database rather than
just that Node is alive, so a process that boots happily but cannot reach
Postgres fails the health check instead of taking traffic.

## 8. Load the demo data

The app migrates itself, but the demo seed is a one-off you have to run. Railway
has no persistent shell, so run it from your laptop against the database's
**public** endpoint:

```bash
npm i -g @railway/cli
railway login
railway link                      # pick the project
railway variables                 # find DATABASE_PUBLIC_URL on the Postgres service
DATABASE_URL='<DATABASE_PUBLIC_URL>' npm run demo
```

The gotcha worth knowing: `railway run` injects the *internal* `DATABASE_URL`
(`postgres.railway.internal`), which only resolves inside Railway's network and
will hang from a laptop. `DATABASE_PUBLIC_URL` is the one that works from
outside.

The seed creates a tournament dated relative to *now*, so the board shows live
statuses rather than grey rows: yesterday's round robin complete, today's games
variously final, on now, upcoming and one disputed, three concession stands with
a menu, and two texts nobody could place.

It refuses to run against a database that already has a tournament. To start
over, delete and re-add the Postgres service — a tournament with history cannot
be deleted, because the event log is append-only by design.

## 9. Releasing again

Every push to the tracked branch rebuilds and redeploys, applying any new
migrations on boot. There is no separate release step.

To roll back: **Deployments → the last good one → Redeploy.** Note that this
rolls back *code*, not the database — a migration that has been applied stays
applied. Nothing here drops or rewrites a column, so a rollback is safe, but
that is a property to preserve when writing future migrations.

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
