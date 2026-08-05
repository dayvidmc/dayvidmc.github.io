# Changes and additions worth considering

Written after building the game-operations core, so this is grounded in what the
code actually does rather than what the spec imagines. Ordered by whether it
would hurt to skip, not by how interesting it is.

Nothing here is a commitment. Most of it should be checked against the Phase 0
debrief before anyone builds it.

---

## 1. The messaging spine — built, with the last link named

**The sending works.** `notification` rows are drained by a real sender with
retries, exponential backoff, per-second rate limiting, STOP/START handling and
a failure screen at `/hq/messages`. Score confirmations, schedule changes and
bracket publications now leave the building.

Two things are still true and both matter.

### It is a dry run until somebody buys a number

Without `SMS_PROVIDER=twilio` the console provider logs each message and marks
it sent. That is the correct default — a stray credential must not be able to
text ninety coaches during a rehearsal — but it means "sent" on screen does not
mean "delivered" until a Twilio account exists. HQ → Texts says which of the
three states you are in, in a coloured box, at the top.

**Decide the number type deliberately.** A long code sends about one message a
second. Ninety teams × two coaches is ~180 messages, so a bracket-publish
broadcast takes three minutes to drain and Saturday evening will have bursts
overlapping. Either buy a Messaging Service with a toll-free or short code, or
accept the lag knowingly — the rate limiter already spreads the send rather
than losing half of it, which is the failure this would otherwise have been.

### Score intake path 1 still does not start itself

The spec's primary route is "the system texts the diamond volunteer when a game
should be finishing, they reply". The *reply* half has always worked and the
*sending* half now works — but **nothing creates the `score_request` message**,
so the conversation still never starts.

**The blocker is gone.** That chain was: `gamesNeedingNudge()` is built and
called by nothing → because it needs to know which volunteer is on which diamond
→ which was `diamond_shift` → which had no rows and no screen. The volunteers
module supplies exactly that. Rostering somebody to a diamond shift creates a
posting, and the demo now has real ones for the first time.

**So the remaining piece is a cron that turns `gamesNeedingNudge()` into queued
messages** — which now has somebody to address them to.

**And it should address the site supervisor, not the diamond volunteer.** The
signed sheet reaches a supervisor covering two or three diamonds; that is who
texts it in. `diamond_posting` now resolves a supervisor to every diamond at
their site, so `gamesNeedingNudge()` will already find the right phone — but
the message wording needs to name the game, because a supervisor covering three
diamonds cannot be assumed to know which one is being asked about.

### Still missing: webhook idempotency

Twilio retries a webhook that times out or returns non-2xx. Today a retry
creates a second `score_report` for the same message, and `score_report` is
append-only, so the duplicate cannot be cleaned up. Store Twilio's `MessageSid`
with a unique constraint and no-op on conflict. Ten lines, and much more
expensive after the fact.

---

## 2. Dead ends the UI still has

Small builds that close a loop the system already promises.

- **Recording a coin flip.** Standings say a placement is "provisional until a
  director records the result" and there is no way to record it. The `coin_flip`
  table and the engine's support for it are both done; this is a button and an
  action.
- ~~Diamond shifts~~ — done, via the volunteers module. `/hq/volunteers/shifts`
  creates them and `/hq/volunteers` fills them; the `diamond_posting` view is
  what score intake reads.
- **A place to see failures.** Failed sends, model-parse errors and unmatched
  texts each need a human eventually. Unmatched texts have a screen; the others
  have nowhere.

**Effort:** a day or two total.

---

## 3. Brackets (§5.6) — built, with one thing missing

The map is drawn: `/bracket/[divisionId]` shows every playoff game from the
start, with the empty spots naming what will fill them. Seeds resolve from live
standings, winners and losers propagate on approval, and the director can pin
any slot by hand.

**What is still missing: there is no way to set a bracket up from a screen.**
Slots are created by the demo seed. A director with a real playoff schedule
would have to have it imported with `bracket_round` and `bracket_position` set,
and the slot rules written directly into `bracket_slot`. Two ways out, and §13
Q4 decides which — how does he build the playoff schedule today?

- If he draws it himself: a builder screen. Pick a round, add a game, and say
  where each side comes from. More work, but it matches a director who already
  has a shape in his head.
- If he wants it generated: "8 teams, one pool, single elimination with a bronze
  game" produces the whole structure, then he adjusts. Faster, but wrong for any
  division that does not fit a standard shape — and this tournament has seven
  divisions with different sizes.

Either way the schedule importer should learn to read a playoff row whose team
column says "Winner Game 12" or "1st Pool A" as a slot rule rather than a team
name, because that is what those spreadsheets actually contain today.

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

The auction (§7) is built, and so are team entries with payment (§8A/E) — a
timed opening, a queue, caps and waitlists, deposits and balances across
e-transfer, cheque and card.

What is left:

- ~~Volunteers (§6)~~ — built. The list, shifts, coverage gaps worst-first, a
  paste import from the coordinator's spreadsheet, and each volunteer's own
  link. Rostering somebody at a diamond is also what makes score intake
  recognise their phone, which had never actually worked in the demo before.
- **Sponsor and donor relationships** — the rest of Module C, waiting on §13 Q7
  about who owns them.
- **An email when an entry lands and when it is accepted.** The coach currently
  has to keep their own reference. The text spine can carry this and nothing
  else needs building for it.
- **A merchant account**, if the committee wants cards. Everything on this side
  is written and dry-runs end to end; see `docs/DEPLOY.md`.

The §12 decision — ship entry-taking for 2027 or 2028 — is now a question about
confidence rather than about code. Both rails that cost nothing (e-transfer,
cheque) work with no external account at all, so a parallel run in which the
tournament takes entries both ways is possible in a way it was not before.

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

## 12. What the four late modules left behind

Tickets, supervisors, donations and the small ones are built. Four things they
made visible and did not finish:

**A receipt for a donation is a sentence on a page, not an email.** The donate
page promises one will follow and nothing sends it. The notification queue
exists and the donor's address is stored, so this is a template and a call —
but until it is written, that promise is being made and not kept, which is
worse than not promising. Either send it or change the wording.

**A charitable receipt is a different thing again.** §8A.4 is still unresolved:
who issues it, and under whose registration number. A donation to a tournament
that gives everything to CHEO is not automatically receiptable by the
tournament. Committee question, not a technical one, and the wording on the
donate page deliberately says "a receipt" rather than "a tax receipt" until it
is answered.

**Ticket counts are recorded and nothing reconciles them.** `tickets_per_team`
times the number of teams is how many went out; `ticket_count` summed is how
many came back. The two are never put next to each other on a screen. That is a
ten-line report and the number it produces is what next year's print run is
decided on.

**The Gold Glove draw has no public page.** It is recorded, verifiable and
visible only inside HQ. The point of storing the seed is that somebody who wants
to satisfy themselves the draw was straight can be shown it — and the people
most likely to want that are not the people with a PIN.

---

## 13. The website, now that it is one

Merging the public site in closed some gaps and opened others.

**There are no images anywhere.** No logo, no photograph of a diamond, no
sponsor logos. Every other tournament site has them and this one looks
deliberately plain beside those. The reason is that images need somewhere to
live and something to serve them, and neither exists in this repository yet —
that is an object store, an upload path, and a size limit, and it is a real
piece of work rather than an afternoon. Worth doing before this replaces
anything public.

The logo, photographs and sponsor logos all exist on the current site and the
committee is happy for them to be used. Two things stand in the way. This
environment cannot reach that site — its network policy refuses arbitrary hosts
— so somebody has to put the files in the repository. And photographs of
children need the naming decision in `docs/ANSWERS.md` answered first.

**The domain is going to point here.** That makes a redirect map part of the
work rather than a nicety: `/2024-results/`, `/scotts-story/`,
`/links-and-info/maps/`, `/tournament-sponsors/` and the per-year results pages
are all links that exist in the world — in emails, in Facebook posts, in other
clubs' newsletters — and every one of them currently lands on a 404 here.

**Nothing has a printable form.** A sponsor asking for the pamphlet, a coach
wanting the rules on paper, a director wanting the honour roll for the
engraver — all of them currently print a web page with a menu on it.

**The honour roll holds three years, not twenty-nine.** The demo deliberately
does not invent the rest: twenty-six years of made-up champions would fill a
page with fiction that looks exactly like a record, and somebody would
eventually cite it. Typing in the real ones is a genuinely valuable afternoon's
work by somebody who has the old results, and the year nobody does it is the
year they are lost.

**Search engines see almost nothing.** Titles and descriptions are set per
page, and that is all. No sitemap, no structured data for the event, no Open
Graph tags — so a link to this site shared in a Facebook group is a bare URL
where every other tournament's is a card with a name and a date on it.

---

## Recommended next three

1. **The messaging spine** (§1). Without it the primary score path is
   half-built, and everything else that promises a text is writing to a queue
   nobody drains.
2. **Close the dead ends** (§2) — coin flips and diamond shifts. Small, and both
   are places the system currently promises something it cannot do.
3. **Print views** (§5) and **an e2e smoke test** (§8). Together these are what
   make a parallel run in July 2027 something the director will actually agree
   to.

Brackets (§3) before Phase 2 closes, but only after §13 Q4 is answered.
