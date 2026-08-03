# Decisions, assumptions and open questions

The build spec is Draft v1 and provisional until the Phase 0 director debrief.
Where it was silent I made a call and built through rather than stopping. Every
one of those calls is written down here, with the reasoning, so the debrief has
a checklist rather than an archaeology exercise.

Each entry says who should confirm it and what breaks if the answer is different.

---

## 1. Assumptions in the tiebreaker (§5.5)

These affect who plays on Sunday, so they matter more than anything else here.

### 1.1 Forfeited games contribute no runs

**Decision.** A forfeit counts toward wins, losses, points and games played, but
its runs are excluded from runs-for, runs-allowed and both differentials.

**Why.** A forfeit is recorded with a nominal score. Letting a nominal 7–0
decide a "fewest runs allowed" tiebreak *between two other teams* would be
indefensible in a dispute — the opponent of a forfeiting team would get a free
shutout on their record.

**Confirm with:** tournament director. **If wrong:** change `buildRecords()` in
`src/domain/records.ts`; the tests pin the current behaviour explicitly.

### 1.2 Head-to-head is measured in points, not wins

**Decision.** Head-to-head uses a mini-league of points (W=2, T=1, L=0) among the
tied teams only.

**Why.** The spec says "head-to-head result" for two teams and "head-to-head
record" for three. With ties allowed in round robin, points is the only measure
that treats a tie between two teams as *inconclusive* and falls through to the
next criterion, which is what the spec's ordering implies.

**Confirm with:** tournament director.

### 1.3 A three-way tie that partially breaks re-enters from the top

**Decision.** When any criterion splits a tie group, each resulting subgroup is
resolved from the top of the chain for *its own size*. A remaining pair
therefore re-enters the two-team chain and hits head-to-head.

**Why.** This is the spec's own §5.5 language falling out of the recursion:
*"fewest runs given up — that one team advances. The second team is decided by
head-to-head between the two remaining."* There is a test for exactly this shape.

### 1.4 An incomplete mini-league is not applied at all

**Decision.** For three or more tied teams, head-to-head is skipped entirely
unless every pair has played.

**Why.** The spec requires it ("all three must have played each other"). A
partial mini-league is not a record, and applying one is exactly the sort of
opaque math that keeps directors on paper.

### 1.5 Coin flips are never simulated

**Decision.** The engine reports `awaitingCoinFlip` and orders the group
alphabetically as provisional. A director records the real flip in the
`coin_flip` table; only then is the standing final.

**Why.** The rules hand this decision to a person. Software inventing an answer
and presenting it as final is the fastest way to lose a director's trust.

### 1.6 Teams that have not played rank below teams that have — display only

**Decision.** Within an equal-points group, teams with zero games played are
listed below teams with a record, and never trigger a coin-flip warning.

**Why.** This is not one of the tournament's rules; it is a display-time fix for
a real defect found during verification. Without it, "fewest runs allowed" hands
first place to a team that has allowed zero runs *by not taking the field* — an
0-3 team would rank below a team that hasn't played — and every division's page
reads "coin flip required" all Friday morning while everyone is 0-0.

By the time the round robin is complete every team has played, so this can never
affect the final standings the §5.5 rules actually govern.

**Confirm with:** tournament director — mainly that the *presentation* is what
he wants mid-tournament.

### 1.7 "All games" means all round robin games

**Decision.** §5.5's "fewest runs allowed, all games" is computed over round
robin games only, matching the "all round robin games" wording one line later.

**Why.** Standings are a round robin construct; playoff results never move them.

---

## 2. Assumptions elsewhere

### 2.1 A forfeit counts as a game played for refund purposes

**Decision.** `completedGameCounts()` counts a forfeited game as played.

**Why.** The team was at the tournament and a result was recorded.

**Confirm with:** the treasurer — this feeds the rainout refund tiers (§8A.3),
so it is a decision about real money, not a statistic. **If wrong:** one filter
in `completedGameCounts()`.

### 2.2 Grace period defaults to 20 minutes

**Decision.** `gracePeriodMinutes: 20` in the reference rules; red flag 15
minutes after that, per §5.3.

**Why.** The spec fixes the 15-minute escalation but never states the grace
period. It is per-division config, so this is only a starting value.

**Confirm with:** tournament director.

### 2.3 Tight turnarounds are warned about at under 30 minutes

**Decision.** The importer warns when a team has less than 30 minutes between
games, and says so more loudly when the two games are at different diamonds.

**Why.** Not in the spec, but the diamonds are spread across Kanata and this is
the kind of thing that is cheap to catch in February and miserable to discover
in July. It is a warning, so the director overrides it freely.

### 2.4 Schedule import creates missing divisions, teams and diamonds

**Decision.** An unrecognised division/team/diamond in the CSV is created rather
than rejected. New divisions get Major's reference rules and
`rules_reviewed = false`.

**Why.** Blocking the import until someone pre-registers eight divisions and
ninety teams would make the tool useless in February. The `rules_reviewed` flag
is how the system insists a human check the numbers before the weekend.

**Risk:** a typo in a team name creates a second team rather than erroring.
Worth revisiting once registration (Module E) is the source of team records.

### 2.5 Games are cancelled, never deleted

**Decision.** Re-importing with "cancel missing" marks absent games cancelled.
Nothing is deleted, and `score_report` blocks deletes at the database level.

**Why.** A game that vanishes from a spreadsheet was still a real thing teams
were told about. It needs a tombstone and a reason.

### 2.6 A bare "12-5" is read as home team first, below the auto-fill threshold

**Decision.** With no team named, the first number is the home team's, at 0.5
confidence — so it always gets a human glance.

**Why.** The outbound request names the home team first, so it is the reasonable
reading; but it is a convention, not a statement, and a reversed score is
exactly the error that costs a team a Sunday.

### 2.7 The deterministic parser runs before the model

**Decision.** Local parse first; the model is called only when the local read is
not confident; if the model is unavailable the local read is kept with its low
confidence intact.

**Why.** "Fail safe, not broken" (§4) — score intake must survive an API outage
at 6pm on Saturday. And running costs come out of donation dollars (§11): not
spending a token on the eighty replies that parse with a regex is free money for
CHEO.

A model `game_id` that is not in the candidate list supplied to it is discarded
rather than trusted, so a hallucination cannot attach a score to the wrong game.

### 2.8 An unmatched text lands on an HQ screen, not in a log

**Decision.** A message that cannot be attached to a game becomes a row in
`unmatched_message`, shown at `/hq/unmatched`, and the sender is told HQ will
look at it. HQ attaches it to a game or dismisses it with a reason.

**Why.** "Nothing depends on one person" — every input has a fallback chain
ending in a human at HQ. Silence would leave a volunteer wondering whether to
phone.

It is a table rather than more rows in `event` because the message has a
lifecycle — open, then assigned or dismissed. Modelling state in an append-only
log means an anti-join on every page load. Both the arrival and the resolution
are still written to `event`, so the trail is complete.

### 2.9 A message with no runs in it goes to the unmatched screen, not the queue

**Decision.** If a text matches a game but contains no readable runs, it is
parked as unmatched rather than filed as a proposal. Forfeits are exempt — a
forfeit is a result even with no runs attached.

**Why.** Found during live verification: without this, *"game is running long
sorry"* and a bare photo of the signed sheet both arrived in the approval queue
as things for the director to approve, which they are not. The approval queue is
for scores awaiting a yes; anything else in it is noise at the exact moment
noise is most expensive.

The photo travels with the message, so a picture of the signed sheet with no
covering text reaches HQ intact — it is usually the most useful part.

### 2.10 Attaching a stray message creates a proposal, never an approved score

**Decision.** `/hq/unmatched` files the message into the normal approval queue.
It does not approve anything.

**Why.** A score becomes real in exactly one place. It also means a mis-picked
game is caught one tap later, because the queue shows the actual team names next
to the numbers — which matters, since the game picker cannot label its inputs
with team names without JavaScript.

The row is claimed with a conditional `UPDATE ... WHERE status = 'open'` before
the proposal is written, so two HQ volunteers working the same list cannot file
two proposals for one text. Verified.

### 2.11 Known gap: a game number outside the candidate window is not matched

**Not fixed.** If a volunteer texts `MA-03 was 9-2 for Kanata` but MA-03 is
outside the ±4h/+2h candidate window, the message is matched against the games
that *are* in the window, and the digits in `MA-03` can be read as runs. Only
candidate game numbers are masked before the run totals are extracted.

**Why it is survivable:** the extra numbers drop confidence below the auto-fill
threshold, so the queue shows the raw text with "read this one yourself". No
wrong score can be approved without a human seeing the original message.

**Worth fixing** when someone next touches the parser: an explicit game number is
the strongest signal in a message and should widen the candidate set rather than
be ignored.

### 2.12 Only the director changes the schedule

**Decision.** HQ staff approve scores and read the board; schedule import is
director-only.

**Why.** §10 gives HQ "score queue, board, comms". Reshaping the schedule is not
in that list.

### 2.13 A playoff game with an undecided side has no team, not a placeholder

**Decision.** `game.home_team_id` and `game.away_team_id` are nullable. A
playoff side that has not been decided is `NULL`, and `home_slot_label` /
`away_slot_label` carry what the screen should say instead — "Winner of
Semifinal 1", "1st in Pool A". A round robin game with an empty side is still
rejected, by a check constraint.

**Why.** Requiring a team on every game left only two options for Sunday's
bracket, and both printed something untrue: invent a placeholder team, or park a
real team in a game it may never play. Either way the board, the public
schedule and the team pages showed a matchup that did not exist, and a
volunteer could report a score against it. The first version of the bracket did
exactly this, and the failure was the one you would expect — the map drew one
matchup while the game row held another, and the wrong team advanced.

**Consequence.** Resolution is not a display concern. `materialiseBracket`
writes the resolved slot onto the game row after every approval, so there is one
answer to "who is playing this game" rather than two that can disagree. It never
touches a played game or a slot a director pinned, and it leaves alone any side
the bracket was never asked to own.

### 2.14 Pinning a slot keeps the rule underneath it

**Decision.** A director pinning a team into a bracket slot sets `overridden`
and the team; the slot's original rule (seed, winner-of, loser-of) is left
intact. Unpinning drops the pinned team and hands the slot back to the rule.

**Why.** §5.6 gives the director final say on every slot. The first version
overwrote the rule, which made unpinning a dead end — the slot could not
remember what it used to be, so releasing it left a hole. Keeping the rule
underneath costs nothing and makes the override reversible, which is what
"final say" should mean.

---

## 3. Deliberately not built

| Thing | Why |
|---|---|
| Raffle / 50-50 logic | §7.4 — likely needs an AGCO or municipal licence. Legal question for the committee, not a technical one. No draw functionality exists. |
| Charitable receipting | §8A.4 — entry fees are generally not receiptable; who issues the receipt is unresolved. The schema separates payment types from day one so this is not painful later, but no receipting logic is written. |
| Scheduling engine | §5.1 — explicitly out of scope for v1. |
| Bracket generation | §5.6 — depends on §13 Q4 (how the schedule is actually built). |
| Player rosters, stats, the public website | §2 — RAMP and WordPress keep these. |

---

## 4. Open questions from §13, and what each one blocks

1. **Does a per-diamond volunteer role already exist?** Blocks nothing in code —
   `diamond_shift` is built and score intake path 1 works. But if the role does
   not exist, it is a spring recruitment ask, and path 1 is the primary route.
   **This is the highest-leverage question on the list.**
2. **Is the signed-sheet requirement KBA/Little League or custom?** Determines
   whether the photo-of-the-sheet field ever becomes more than optional.
3. **Does the director want an approval queue at all?** The whole HQ flow assumes
   yes. If he would rather personally know every score, the queue becomes a
   notification list — a real change, worth asking before Phase 2.
4. **How does he build the schedule today?** Determines the import format. The
   importer accepts common spreadsheet headings (`Game #`, `Time`, `Field`,
   `Home`, `Visitor`) as a hedge, but a real sample file would settle it.
5. **Cell coverage at each diamond.** No offline queueing is built. If coverage
   is bad anywhere, path 1 needs a fallback there specifically.
6. **Raffle/50-50 licensing.** See above.
7. **Who owns sponsor and auction donor relationships.** Module C.
8. **Can results be pushed back into RAMP?** Affects the export at the end of the
   weekend, which does not exist yet.

---

## 5. The one that needs deciding first

Spec §12 poses it: **ship registration for 2027, or keep it where it is and ship
it for 2028?**

Everything in this repository can run in parallel with the current process — if
it fails, nobody notices. Registration cannot. There is no shadow mode for
taking money.

The spec's own advice, on the 30th anniversary: take the second option. If the
committee agrees, the 2027 game-ops modules need coach contact data imported
from the existing system rather than collected natively. The `team` table has
`coach_phone`, `coach_email` and `alternate_contact` columns ready for exactly
that import, and team communication (§5.7) does not work without them.
