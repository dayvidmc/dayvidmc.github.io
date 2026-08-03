# Changes and additions worth considering

Written after building the game-operations core, so this is grounded in what the
code actually does rather than what the spec imagines. Ordered by whether it
would hurt to skip, not by how interesting it is.

Nothing here is a commitment. Most of it should be checked against the Phase 0
debrief before anyone builds it.

---

## 1. The messaging spine — built

*Was item 1. Done, and the notes below are what it actually turned into.*

A worker claims queued rows with `FOR UPDATE SKIP LOCKED`, sends via Twilio
over plain `fetch`, and writes back `sent`/`failed` with the provider id.
Transient failures retry on a short backoff; permanent ones (landline, typo'd
number, unsubscribed) stop immediately rather than burning throughput during
the one hour of the year when throughput is scarce. Driven by
`POST /api/cron/messaging` on a one-minute schedule.

Score intake path 1 now works in both directions: the scheduler texts the
diamond volunteer on shift when a game should be finishing, and follows up at
grace. One ask and one follow-up per game, enforced by a unique index rather
than by application code, because two scheduler runs overlapping is the normal
case on Saturday evening.

Webhook idempotency went in at the same time. `MessageSid` is stored with a
unique constraint, so a Twilio retry replays the stored reply instead of
creating a second append-only proposal and a second billed parse.

**Three things learned building it, worth keeping:**

- **An ask can stop being worth sending.** A score request for a game somebody
  phoned in ten minutes ago is worse than useless — it teaches volunteers to
  ignore the system. The drain re-checks at send time and abandons instead.
- **Punctuation is a line item.** One character outside the GSM-7 alphabet cuts
  an SMS segment from 160 characters to 70. The inbound replies had em dashes
  in them and were silently billing double. Every template is now plain ASCII
  and a test enforces it.
- **The long-code throughput problem is real but deferred, not solved.** Pacing
  is configurable (`SMS_RATE_PER_SECOND`) and defaults to 1/second. A broadcast
  to ninety teams still takes about three minutes to drain. Whether to buy a
  Messaging Service with a toll-free number is a decision for the committee,
  not a code change — see `docs/DEPLOY.md`.

**Still missing from §5.7:** the broadcast composer and the rain button. The
transport underneath both exists; neither has a screen. See item 4.

---

## 2. Dead ends — closed

*Was item 2. All three now have screens.*

- **Diamond cover** (`/hq/diamonds`). The linchpin of path 1, and previously
  populatable only by hand-written SQL. Coverage gaps are listed *first*,
  because a diamond with nobody on shift is a diamond where nobody is ever
  asked and those games go red with no explanation. `npm run demo` deliberately
  leaves one diamond uncovered so the warning has something real to show.
- **Coin flips** (on the standings page, director only). The tiebreak engine
  now carries the tied group out with it, so the form offers exactly the teams
  that were still level — rather than the UI re-deriving §5.5 and eventually
  disagreeing with it.
- **Send failures** (`/hq/messages`). Everything sent, everything that failed,
  and a retry that takes a corrected number — because the usual cause is a
  wrong number on a shift or a team record, and retrying the wrong one harder
  does not help. Also shows the running segment count and cost estimate, which
  is the §11 number the board will ask for.

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

Most of the pieces exist — the import validator already detects diamond
double-bookings and team overlaps, and could be pointed at a proposed reflow
instead of a CSV. The hard part is not the algorithm, it is showing the director
what is about to change and letting him veto individual games before anything is
committed.

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

Items 1 and 2 are done. What is left, in order:

1. **Print views** (§5) and **an e2e smoke test** (§8). Together these are what
   make a parallel run in July 2027 something the director will actually agree
   to — the printable board is the fallback when the system dies, and the smoke
   test is the one that catches a broken weekend.
2. **The broadcast composer**, then **the rain button** (§4). The transport is
   built and the segment-cost warning already exists to hang a composer on. The
   rain button is the harder half and should be preview-then-confirm.
3. **Brackets** (§3) before Phase 2 closes — but only after §13 Q4 is answered.

One operational note now that texts genuinely send: **the heartbeat is the
single point of failure that looks like success.** Everything can be configured
perfectly and nothing will go out if nothing calls `/api/cron/messaging`.
`/hq/settings` lists it, and `/hq/messages` warns when the oldest queued message
has been waiting more than ten minutes, which is what a stopped heartbeat looks
like from the inside. Worth checking on the Thursday before the weekend.
