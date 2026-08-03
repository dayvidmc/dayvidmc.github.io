# Tokessy Tournament Operations — Build Spec

**Working name:** TBD
**Target:** 30th Annual Scott Tokessy Memorial Gold Glove Tournament, late July 2027
**Author:** David
**Status:** Draft v1 — pending director debrief

> This is the spec as written, committed verbatim as the project's source of
> truth. Code comments reference these section numbers. Where implementation
> found the spec ambiguous or self-contradicting, the question is recorded in
> [OPEN-QUESTIONS.md](./OPEN-QUESTIONS.md) rather than resolved silently here.

---

## 1. What this is

A **three-day operations tool** for one tournament, once a year.

It handles four jobs the weekend actually runs on:

1. **Registration and payments** — team signup, entry fees, donations, refunds
2. **Game operations** — scores in, standings and brackets out
3. **Volunteers** — recruitment, shift scheduling, day-of reminders
4. **Silent auction** — items, bids, checkout
5. **Concessions** — staffing only (Square already handles sales)

## 2. What this is NOT

This is critical scope discipline. The Kanata Baseball Association runs RAMP InterActive year-round for the whole organization. RAMP stays. This tool does not replace it and does not attempt to.

**Explicitly out of scope:**

- Player rosters and eligibility records (RAMP)
- The public tournament website (WordPress at tokessytournament.com)
- Season standings, honour roll, historical archive (RAMP / existing site)
- Player statistics
- **Schedule generation** — see §5.1. The director builds the schedule; we import it.

When the weekend ends, final results are exported and handed back to the existing systems.

## 3. Context the build needs to respect

- ~90 teams, 7 divisions (Rookie, Minor, Minor Girls, Major, Major Girls, Junior, Junior Girls), several with A/B splits and All-Star divisions
- 8+ diamonds across Kanata: Tokessy, Deevy Pines 1 & 2, Mike Channing, Walter Baker West, Roland Michener, Kinsmen, March Central
- Round robin Friday and Saturday; playoffs Sunday
- ~150+ round robin games plus playoffs
- Run **entirely by volunteers**. 100% of proceeds go to CHEO Cardiology.
- Tournament HQ is at the Tokessy site — silent auction and BBQ live there
- Rules differ per division and are published as separate PDFs each year

**Current process (do not break it):**

- Home team keeps the official score; scorekeepers from both teams confer after each complete inning and sign the official sheet
- Scores are phoned or texted in to the tournament director
- The director manually enters them and computes standings

**Known pain points:**

1. Communication with teams — the #1 complaint
2. Score entry — the director dislikes how it works today
3. Coaches are unreliable reporters

## 4. Guiding principles

| Principle | Why |
|---|---|
| **No app download. No accounts. No passwords.** | 90 visiting teams show up once a year. Anything requiring installation will fail. |
| **Paper stays.** | The signed sheet is the dispute-resolution record and is written into the rules. We digitize the *message*, not the sheet. |
| **Pull, don't push.** | Prompt people for input rather than relying on them to remember. Replying is easier than initiating. |
| **Nothing depends on one person.** | Every input has a fallback chain ending in "a human at HQ types it." |
| **Fail safe, not broken.** | If the system dies mid-Saturday, the tournament continues exactly as it does today. |
| **Built for volunteers on phones.** | Big tap targets, minimal steps, works one-handed at a diamond in the sun. |

Same design bar as Pawl: tap-based simplicity is a hard requirement, not a nice-to-have.

---

## 5. Module A — Game Operations (core)

### 5.1 Schedule import

The director continues building the schedule however he does now. The system imports it.

- CSV upload or paste
- Required fields: division, pool, game ID, date, start time, diamond, home team, away team, game type (round robin / playoff)
- Validation on import: diamond double-bookings, teams playing two games at once, games outside tournament hours
- Show conflicts as warnings, let the director override — his judgment wins

**Do not build a scheduling engine in v1.** It's the hardest component, the highest risk, and the director already has a working method. Revisit for v2 at the earliest.

### 5.2 Score intake — three paths, one queue

All three produce a **proposed score** that lands in the same approval queue.

**Path 1 — Diamond volunteer (primary).**
One volunteer per diamond per shift. System texts them when a game should be finishing:

> Deevy 1, 10:30 — Kanata Major A vs Orleans Major A. Reply with the score.

They reply in any format. Parsing handled by an LLM call with that diamond's scheduled games supplied as context; returns structured `{home_team, home_runs, away_team, away_runs, confidence}`.

- High confidence → queued, pre-filled
- Low confidence → queued with the raw text shown for a human to read

**Path 2 — Coach text (fallback).** Same number, same parser. Coaches will text unprompted; accept it.

**Path 3 — HQ phone entry (fallback).** Any HQ volunteer types a called-in score directly into the queue.

**Optional:** photo of the signed sheet attached to the game record, so reconciliation happens on a screen instead of a pile of paper.

### 5.3 The HQ board

The single most valuable screen. Today's games with live status:

- 🟢 **Reported** — score in, approved
- 🟡 **Pending** — proposed, awaiting approval
- 🔴 **Overdue** — should have finished, nothing received
- ⚠️ **Disputed** — flagged for the director

Overdue is computed as `scheduled_start + division_time_limit + grace_period`. Auto-nudge the diamond volunteer at grace, flag red at grace + 15 min.

Approval is one tap. Approving fires standings recalculation, bracket updates, and team notifications automatically.

### 5.4 Division rules configuration

Each division gets its own rules record. Set once, cloned each year. Reference values from the 2026 Major rules:

```
innings_max: 6
time_limit_minutes: 105          // no new inning after 1:45
official_game_innings: 4         // 3.5 if home team ahead
ties_allowed_round_robin: true
runs_per_inning_cap: 5           // unlimited in championship final
mercy_rule_run_lead: 11          // after 4 complete innings (3.5 if home ahead)
championship_final_mercy: 10     // after 4 or 5 innings
playoff_tiebreak: international  // runner on 2nd to start extra innings
home_team_round_robin: coin_toss
home_team_playoffs: higher_seed
```

**These differ per division.** Rookie, Minor, Junior etc. each have their own PDF. Build the config generic enough to hold all seven.

### 5.5 Standings and tiebreakers

Points: Win = 2, Tie = 1, Loss = 0.

**Global rule:** no team with a forfeit in round robin can win a tiebreaker.

**Two teams tied:**
1. Most points
2. Head-to-head result (still applies if a balancing game is pulled)
3. Most wins
4. Fewest runs allowed, all games
5. Run differential, all round robin games — **capped at 10 runs per game**
6. Coin flip

**Three teams tied:**
1. Most wins
2. Head-to-head record among all three (all three must have played each other)
3. If no clear victor: fewest runs given up — that one team advances. The second team is decided by head-to-head between the two remaining.
4. Run differential, capped at 10 runs per game
5. Coin flip

**Show the work.** Every tiebreak displays its reasoning: *"Kanata advances on runs allowed: 12 vs 15."* Directors keep paper because they don't trust opaque math. Make it visible and the paper stops mattering.

### 5.6 Brackets

- Sunday playoff slots populate from Saturday's final standings
- Manual override on every slot — the director gets final say
- One tap to publish; publishing notifies affected teams
- Playoff format per division comes from the published schedule, which is always authoritative

### 5.7 Team communication

- **One link per team.** No login. Shows only that team's games, times, diamonds, and current standing. Coach forwards it to parents once; it stays live.
- **SMS broadcasts** targeted by team, division, diamond, or everyone
- **Auto-notify** on: score approved, schedule change, bracket published, rain delay
- **Rain button:** shift all remaining games by N minutes, or compress to shortened games. Reflow, re-check conflicts, notify everyone affected.

### 5.8 Game count tracking (financial)

Rainout refunds are tiered by games played: zero games = full refund minus $50 admin fee; one game = 50% minus $50; two games = no refund.

Per-team completed-game counts are therefore a **financial record**, not a statistic. Track precisely and make exportable.

---

## 6. Module B — Volunteers

Runs on a different calendar from everything else: recruitment starts in spring, months before the weekend. **This is the module that gets used first**, and it's fully decoupled from game data — good candidate to build and ship first.

### 6.1 Recruitment

- Public signup form: name, phone, email, t-shirt size, roles willing to work, availability by day/time block
- Returning volunteers get a pre-filled link — one tap to confirm they're back
- Track student community-service hours (many high school volunteers need documented hours)
- Emergency contact for anyone under 18, plus a note of any required screening for adult roles

### 6.2 Roles

- Diamond score reporter (feeds §5.2 — this is the linchpin)
- Concession / BBQ
- Silent auction table
- Gate and admissions
- Field prep and equipment
- Parking
- Opening ceremonies
- Floaters

### 6.3 Shift scheduling

- Grid: role × day × time block, with required headcount per cell
- Auto-match volunteers to shifts by stated availability, then let the coordinator drag-and-drop to fix
- Flag understaffed shifts loudly — visible gaps weeks out, not the morning of
- Prevent double-booking one person across two roles
- Some volunteers are also parents of players — optionally avoid scheduling them against their kid's game times

### 6.4 Day-of

- Reminder text the night before and 90 minutes before each shift
- Simple check-in so the coordinator can see who's actually on site
- No-show alert to the coordinator when a shift starts unstaffed
- Every volunteer gets a link to their own shifts — no login

### 6.5 After

- Hours report per volunteer (for student credit letters)
- Total volunteer hours for the CHEO/board report
- Roll the whole roster forward to next year

---

## 7. Module C — Silent Auction

Runs at Tournament HQ (Tokessy site). Currently manual.

### 7.1 Items

- Item record: name, description, photo, donor/sponsor, retail value, minimum bid, bid increment, table number
- Donor tracking with thank-you list export — sponsors are the ask for next year
- Items carry a printable bid sheet with a QR code

### 7.2 Bidding

Two modes, decide with the committee:

**Option A — paper bid sheets + QR.** Sheets stay on the table exactly as today; QR on each sheet opens a page showing the item and current high bid. Someone at the table enters bids periodically. Low risk, minimal behaviour change.

**Option B — digital bidding.** Bidder registers once with a phone number, bids from their phone, gets outbid notifications. Raises totals meaningfully but is a real behaviour change and needs connectivity at the Tokessy site.

**Recommendation: Option A for year one.** Prove it works, then upgrade.

### 7.3 Close and checkout

- Hard close time, enforced
- Winners auto-notified by text
- Checkout list for the table: item, winner, amount, paid/unpaid
- Payment via Square (same account as concessions) or in person; record either way
- Unsold item report

### 7.4 Raffles / 50-50

**Flag before building:** raffles and 50-50 draws in Ontario generally require a licence from the AGCO or the municipality. A silent auction typically doesn't. Confirm what the tournament is licensed for before building any draw functionality — this is a legal question for the committee, not a technical one.

---

## 8. Module D — Concessions

**Build almost nothing here.** Concessions already run on Square, sales-only, no inventory tracking. Square handles payments, per-location reporting, and end-of-day totals better than anything we'd write, and the volunteers already know it.

What we do:

- **Staffing** — handled entirely by Module B
- **Square location per site** — so revenue reports break out by diamond without any custom code
- **Optional read-only rollup** — pull daily totals from the Square API into the HQ dashboard so the director sees concession revenue next to auction and registration totals in one place. Nice-to-have, not required.

What we explicitly do not build: a POS, inventory tracking, restock alerts, or item-level sales analysis. If the concession leads ask for inventory later, revisit — don't impose it on volunteers.

Concessions run at multiple sites (Tokessy, Deevy Pines, Channing, Walter Baker West, plus Saturday-only at Roland Michener, Kinsmen, March Central). Set each up as its own Square location.

---

## 8A. Module E — Registration and Payments

**Highest-stakes module in the build.** It handles other people's money, it feeds every other module, and unlike scores it has no parallel-run safety net (see §12 warning).

### 8A.1 Team registration

- Public form: team name, association, division requested, A/B preference, coach name, **coach cell and email**, alternate contact
- Coach contact capture is the foundation of all team communication in §5.7 — this is where the phone numbers come from
- Returning teams get a pre-filled invite link; one tap to confirm they're in again
- Division caps with automatic waitlist and auto-promotion when a team drops
- Committee approval step before a spot is confirmed — the tournament reserves the right to move teams between A and B based on information gathered beforehand, so registration must not auto-assign final divisions
- Roster upload deferred to RAMP; we only need enough to contact and schedule the team

### 8A.2 Payments — stay on Square

The association already runs Square for concessions. Keep it. One merchant account, one set of deposits, one reconciliation for the treasurer, and nobody has to learn a second system.

Square's Web Payments SDK or hosted Payment Links both work fine from Next.js. Payment Links are the lower-effort path and worth trying first.

- Entry fee charged at registration
- **Optional donation as a separate line item** — this must be a distinct transaction type, not bundled into the fee (see §8A.4)
- Payment status per team visible to the treasurer: unpaid / partial / paid / refunded
- Automated reminders for unpaid teams as the deadline approaches

### 8A.3 Refunds — wired to game counts

The published rainout policy is tiered by games played:

| Games played | Refund |
|---|---|
| 0 | Full, minus $50 admin fee |
| 1 | 50%, minus $50 admin fee |
| 2 | None |

This is the one place where **game operations data drives money**. §5.8 game counts must feed the refund calculation directly. On a washed-out weekend the treasurer should be able to generate the whole refund list in one action rather than reconstructing it by hand.

Refunds issue back through Square to the original payment method.

### 8A.4 Charitable receipting — get advice before building

100% of proceeds go to the CHEO Cardiology Department, and there's an existing CHEO Foundation donordrive campaign.

Two things need confirming with the committee and the CHEO Foundation before any receipting logic is written:

1. **Entry fees are generally not receiptable** as charitable donations, because the payer receives something of value in return. Voluntary donations on top typically are. The two must be tracked separately from day one — retrofitting this later is painful.
2. **Who issues the receipt** — the tournament, KBA, or the CHEO Foundation. If it's the Foundation, we may only need to report totals rather than issue anything, which is far less work.

Treat this as an accounting question, not a technical one. Get it answered by someone qualified before building.

### 8A.5 Sponsors

- Sponsor record: contact, tier, amount, logo, placement (site, signage, program)
- Payment through the same Square account
- Renewal list generated for next year's ask
- Feeds the post-event sponsor report

### 8A.6 Financial dashboard

One screen for the treasurer and board: registration revenue, donations, sponsorships, auction proceeds, concession totals (via Square), refunds issued, net to CHEO. Exportable.

This is the number the board cares about and the number that goes in the annual announcement. Making it a live figure rather than a January spreadsheet exercise is a genuine win on its own.

---

## 9. Data model (rough)

```
tournament
  └── division            (holds its own rules config)
        └── pool
              └── team
                    ├── registration
                    │     └── payment          (entry_fee | donation | refund)
                    └── game
                          ├── score_report      (append-only, all proposals)
                          └── approved_score

sponsor
  └── payment

volunteer
  └── availability
  └── shift_assignment
        └── shift ── role ── location

auction_item
  └── bid
  └── donor

concession_location
  └── stock_count
  └── cash_reconciliation
```

**Append-only events table**, same pattern as Pawl. Every score proposal, approval, correction, and schedule change writes a row with actor and timestamp. When a coach disputes a standing at 8pm Sunday, the director shows the trail. This matters more here than in the shop.

**Scope everything by `tournament_id`** — same discipline as `shop_id` in Pawl. Even though there's only one tournament today, it makes year-over-year cloning trivial.

## 10. Access model

| Role | Access | Auth |
|---|---|---|
| Tournament director | Everything | PIN |
| HQ staff | Score queue, board, comms | PIN |
| Diamond volunteer | Reply to SMS only | none |
| Volunteer coordinator | Module B | PIN |
| Auction lead | Module C | PIN |
| Coach | Own team's page | magic link |
| Volunteer | Own shifts | magic link |
| Public | Schedule, standings, brackets | none |

Tile + PIN for staff, exactly like Pawl. Magic links for everyone else. No passwords anywhere.

---

## 11. Stack

- Next.js + PostgreSQL
- Railway hosting
- Cloudflare R2 for photos (signed sheets, auction items)
- Twilio for SMS
- **Square** for all payments — registration, donations, sponsors, auction checkout, concessions. Already in use by the association; one merchant account, one reconciliation.
- Anthropic API **server-side only** for score parsing
- GitHub for cross-device access

Same shape as Pawl, deliberately — the point is to reuse patterns already proven.

**Load profile is unusual:** dead for 51 weeks, then hammered for 72 hours, with a sharp peak Saturday evening when every diamond finishes at once. Load-test that specific hour rather than assuming steady-state behaviour.

**Running costs come out of donation dollars.** SMS and hosting for the weekend should land well under $200, but have the number ready before the board asks.

---

## 12. Build order

**Phase 0 — Aug–Sep 2026: Debrief.**
Sit with the director, HQ volunteers, the volunteer coordinator, and the auction lead while the 2026 weekend is fresh. Write down what actually broke. Everything below is provisional until this happens.

**Phase 1 — Oct–Nov 2026: Registration and payments.**
Must be live before registration opens for 2027. Work backwards from that date — it's the one hard external deadline in the whole project. Build it first because everything downstream depends on the team and contact data it collects.

**Phase 1b — Nov–Dec 2026: Volunteers.**
Independent of game data, needed early (spring recruitment), zero risk to game operations. Ship it and use it for real in spring 2027.

**Phase 2 — Jan–Mar 2027: Game operations.**
Schedule import → score intake → HQ board → standings → brackets, in that order.

**Phase 3 — Apr 2027: Replay test.**
Load the 2026 schedule and real results. Run every division's standings through the tiebreaker code and compare to what actually happened. Any disagreement is a free bug find.

**Phase 4 — May 2027: Live pilot.**
One division at a regular-season KBA weekend.

**Phase 5 — Jun 2027: Auction + concessions.**
Lower risk, later build.

**Phase 6 — Late July 2027: Run in parallel.**
Paper, phone calls, and the current process continue **exactly as today**. This system runs alongside and is compared afterward. If it's right all weekend, it becomes primary in 2028. If it breaks, nobody notices.

> **The parallel run is non-negotiable.** This tournament has run 29 years and raised over $536,000 for CHEO Cardiology. 2027 is the 30th anniversary. It cannot have a bad year because of new software.

> **Registration is the exception, and it's the risk.** Scores, brackets, auction and volunteers can all run in parallel with the existing process — if they fail, nobody notices. Registration can't. Either teams register through the new system or they don't. There is no shadow mode for taking money.
>
> Two options, and the committee should choose deliberately:
>
> - **Ship registration for 2027.** Requires it live and tested by roughly January, with a manual fallback ready (a form and a Square payment link) if something breaks mid-window.
> - **Keep 2027 registration where it is; ship it for 2028.** Lower risk on the anniversary year, but means the 2027 game-ops modules need coach contact data imported from the existing system rather than collected natively.
>
> If in doubt on the 30th anniversary, take the second option.

---

## 13. Open questions

Answer these before Phase 2 starts. Tracked, with additions found during
implementation, in [OPEN-QUESTIONS.md](./OPEN-QUESTIONS.md).

1. Does a per-diamond volunteer role already exist (field marshal, convenor)? If yes, §5.2 is a small change. If no, it's a recruitment ask that must reach the committee by spring.
2. Is the signed-sheet requirement a KBA or Little League obligation, or just custom? Determines what's negotiable later.
3. Does the director want an approval queue, or does he want to keep personally knowing every score? Build to his preference — he's the user who matters most.
4. How does he actually build the schedule today — spreadsheet, software, paper? Determines the import format.
5. Cell coverage at each diamond. Offline queueing is only needed where it's genuinely bad.
6. What is the tournament licensed for regarding raffles/50-50?
7. Who owns the relationship with sponsors and auction donors, and what do they use now?
8. Can final results be pushed back into RAMP, or is it manual re-entry?
