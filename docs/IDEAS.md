# Changes and additions worth considering

Written after building the game-operations core, so this is grounded in what the
code actually does rather than what the spec imagines. Ordered by whether it
would hurt to skip, not by how interesting it is.

Nothing here is a commitment. Most of it should be checked against the Phase 0
debrief before anyone builds it.

---

## 1. The messaging spine — ~~this is the real gap~~ built

**Done.** Score intake path 1 now runs end to end: when a game should be
finishing, the volunteer on shift at that diamond is texted and asked for the
score; one nudge follows at grace; then the board goes red and it is a phone
call. See the README's *Outbound messaging* section and DECISIONS §2A.

What landed:

- A worker inside the web process, ticking every 30 seconds — reclaim, chase,
  send. Sends claim their row with `FOR UPDATE SKIP LOCKED`; chases dedupe on a
  unique index, so nothing goes twice.
- Retries at 1, 5 and 20 minutes, then failure with a readable reason and a
  retry button on `/hq/messages`. Permanent failures (invalid number,
  unsubscribed) are not retried at all.
- Quiet hours, so a backlog cannot empty itself into people's pockets at 2am.
- Webhook idempotency on Twilio's `MessageSid`, so a retried webhook replays the
  reply rather than writing a second `score_report` into an append-only table.
- `POST /api/jobs/tick` behind `CRON_SECRET`, for an external cron or a manual
  run.

**Still worth deciding: the long code.** A bare `TWILIO_FROM_NUMBER` sends about
one message per second, so a broadcast to ninety teams takes three minutes to
drain. The outbox paces itself to match and skips the pacing entirely when a
Messaging Service is configured — but the account still needs one. Decide it
deliberately rather than discovering it at 7pm.

**Also worth doing at some point: delivery receipts.** A message marked `sent`
means Twilio accepted it, not that a phone received it. Twilio's status callback
would close that gap; it needs a second webhook and a status column.

---

## 2. Dead ends the UI still has

Small builds that close a loop the system already promises.

- **Recording a coin flip.** Standings say a placement is "provisional until a
  director records the result" and there is no way to record it. The `coin_flip`
  table and the engine's support for it are both done; this is a button and an
  action.
- ~~**Diamond shifts.**~~ Built: `/hq/shifts`, with a coverage table showing
  which games have nobody to ask. Still typed in by hand until Module B (§6)
  recruits these people properly and feeds them in.
- ~~**A place to see failures.**~~ Built for sends: `/hq/messages`. Model-parse
  errors still have nowhere — they currently fall back to the unmatched screen,
  which is the right destination but tells nobody the model was the reason.

**Effort:** a day for the coin flip.

---

## 3. Brackets (§5.6)

Sunday depends on it, and it is not built. Blocked on §13 Q4 — how the director
actually builds the playoff schedule today — because the answer decides whether
this is "populate slots from standings" or "let him type it in and just publish
it". Ask before designing.

The engine already produces ranked standings with reasoning, so seeding is
mostly presentation. The manual override on every slot (§5.6) matters more than
the automation.

---

## 4. The rain button (§5.7)

The highest-stress twenty minutes of the weekend: shift everything remaining by
N minutes, or compress to shortened games, re-check conflicts, tell everyone.

Most of the pieces now exist — the import validator already detects diamond
double-bookings and team overlaps and could be pointed at a proposed reflow
instead of a CSV, and "tell everyone" is a `queueMessage` call. The hard part is
not the algorithm, it is showing the director what is about to change and
letting him veto individual games before anything is committed.

Worth building as **preview → confirm**, never as a single button that fires.

---

## 5. Paper, deliberately

"Paper stays" is in the guiding principles, and the system currently treats
paper as something it tolerates rather than supports. Cheap things that would
earn goodwill from the people who are sceptical of this:

- **Printable HQ board** for the wall — the fallback when the system dies.
- **Printable blank score sheets** with the game number, teams, diamond and time
  pre-filled, matching what the scorekeepers already sign.
- **Printable standings** per division for the HQ table and the announcer.
- **A printed one-page "how to report a score" card** for diamond volunteers.

All of it is CSS `@media print` plus a couple of routes. Half a day, and it
makes the parallel run in 2027 genuinely comfortable.

---

## 6. Board and queue polish

The board is the screen the weekend runs on, so small things compound.

- **Auto-refresh.** HQ leaves this open. A 20–30 second `router.refresh()` in a
  client component, paused when a form has focus so it never eats typing.
- **Undo on approval.** A 30-second window converts "am I sure?" into "just tap
  it", which is worth a lot when there are eighty games. The audit trail already
  supports it — an undo is just another correction.
- **Bulk approve.** When six 95%-confidence scores arrive at once, approving
  them individually is six taps and six page loads.
- **Jump to a game.** 150+ games; typing "MA-14" should get there.
- **Add to home screen.** A web manifest so HQ volunteers get an icon rather
  than hunting for a bookmark. No app store, no download — still within the
  "no app" principle.

---

## 7. Exports and the handover

The weekend ends with results going back to existing systems (§2), and that has
no code at all.

- **Final results CSV** for re-entry into RAMP — or an API push, pending §13 Q8.
- **Per-team completed game counts** for the rainout refund tiers. The function
  exists (`completedGameCounts`) and nothing surfaces it. On a washed-out
  weekend the treasurer needs this as a one-click list, not a reconstruction.
- **Full tournament archive** — a single JSON or SQL dump per year, so 2027 can
  be replayed against 2028's code. This is what makes the Phase 3 replay test
  repeatable in future years.

---

## 8. Robustness before July

- **Commit an end-to-end smoke test.** I have now written the same Playwright
  script twice and deleted it twice. It should be `npm run e2e`: sign in, import
  a schedule, text a score, approve it, check the standings moved. That is the
  test that catches a broken weekend.
- **Load-test the Saturday 6pm hour specifically** (§11), not steady state. Every
  diamond finishing at once, HQ refreshing the board constantly, and a broadcast
  draining at the same time.
- **Rate-limit the SMS webhook.** It is a public endpoint that does an LLM call.
  Signature verification stops forgery but not volume.
- **Backups.** Railway's automatic ones plus a manual export button before the
  weekend starts. The cost of losing Saturday's scores is the whole tournament.
- **A staging environment** with `npm run demo` data, so changes are never first
  tried on the live tournament.

---

## 9. Smaller correctness items

- **Explicit game numbers outside the candidate window** (DECISIONS §2.11). A
  text saying `MA-03 was 9-2` when MA-03 is not in the ±window gets matched
  against the wrong game and the digits in `MA-03` can be read as runs.
  Confidence drops below auto-fill so a human sees it, but it should widen the
  candidate set instead.
- **Cross-pool playoff seeding.** Standings are computed per pool. Seeding a
  bracket across pools in the same division has no code.
- **Schedule import currently invents teams from typos.** Once registration owns
  the team list, the importer should match against it and flag unknown names
  rather than silently creating a second "Kanata Major A ".

---

## 10. The other modules

Per the spec's build order, unchanged: registration and payments first
(§8A, hard external deadline), then volunteers (§6, needed for spring
recruitment and the source of diamond shift data), then auction (§7).

The one decision that cannot wait is §12's: **ship registration for 2027, or
keep it where it is and ship it for 2028?** If 2028, the game-ops modules need
coach contact data imported from the existing system — the columns are ready and
the teams screen can take it by hand, but somebody has to get the list.

---

## 11. Things worth *not* building

Recorded so they do not get re-proposed every year.

- **A scheduling engine.** §5.1 is explicit, and the director has a working
  method.
- **Digital auction bidding in year one.** §7.2 recommends paper sheets plus a
  QR code. Prove it works first.
- **A native app.** The first guiding principle. A web manifest gets ninety
  percent of the benefit at none of the cost.
- **Anything that replaces RAMP.** §2.
- **Inventory tracking for concessions.** §8 — do not impose it on volunteers
  who did not ask.

---

## Recommended next three

With the messaging spine in (§1), the ordering changes.

1. **An end-to-end smoke test** (§8). The system now has a loop worth
   protecting: text in, parse, queue, approve, standings move, text out. That is
   exactly the path a broken weekend runs through, and nothing currently guards
   it. `npm run e2e`.
2. **Print views** (§5). Cheap, and the thing that makes a parallel run in July
   2027 comfortable for the people who are sceptical of this — including the
   printed "how to report a score" card the diamond volunteers now actually
   need, since they are the ones being texted.
3. **The rain button** (§4) or **brackets** (§3), depending on §13 Q4. Both now
   have the messaging half they were waiting on; what they need is the
   preview-and-confirm UI, which was always the hard part.

The coin flip (§2) is a day's work and closes the last place the system promises
something it cannot do.
