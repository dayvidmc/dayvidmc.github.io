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

---

## 2A. Assumptions in outbound messaging (§5.2, §5.7)

### 2A.1 One ask and one nudge, then it is a person's problem

**Decision.** A game gets exactly one score request, at its expected finish, and
exactly one nudge, at grace. After that nothing more is sent — the game goes red
on the board and someone makes a phone call.

**Why.** The spec's escalation ends at a red flag, not at a third text. Nothing
is more corrosive to a volunteer's willingness to reply than a robot asking six
times, and a volunteer who has ignored two texts is not going to answer a third
— they are busy, out of signal, or gone. The board is what catches that, and it
already does.

### 2A.2 The nudge waits ten minutes after the ask, whatever the clock says

**Decision.** On top of the division's grace period, a nudge will not go out
within ten minutes of the request actually being sent.

**Why.** After any outage both are due at once, and "reply with the score"
followed ninety seconds later by "still need the score" reads as broken rather
than diligent. This is the only rule in the chase that is about the message
history rather than the game clock.

### 2A.3 Nothing is sent between 23:00 and 07:00

**Decision.** The outbox holds everything overnight, tournament-local.

**Why.** Not for the game that finishes at 2am — none do. It is for the backlog:
if sending is broken all Saturday and recovers at 2am, the queue would otherwise
empty four hundred messages into the pockets of volunteers and ninety coaches at
once. Nothing in that queue is worth waking anyone for.

The check happens before the claim rather than after, so held messages stay
`queued` and visible on `/hq/messages` instead of being claimed and put back.

### 2A.4 Whoever was on shift when the game should have ended

**Decision.** The score request goes to the diamond volunteer whose shift covers
the game's *expected finish*, not whoever is on shift when the message is sent.

**Why.** They are the person who was standing there watching it end. Texting the
volunteer who arrived two hours later asks someone about a game they did not
see. Where two shifts overlap the later one wins, on the reasoning that the
person arriving is the one who will still be there to answer.

### 2A.5 A game with nobody on shift is reported, not chased

**Decision.** If no volunteer covers a diamond at the relevant time, no message
is queued and the game is counted as uncovered.

**Why.** There is no sensible fallback recipient — texting the coach would make
path 2 the primary route, and texting HQ tells them something the board already
shows. The gap is real and worth surfacing, so it appears on `/hq/shifts` as a
coverage table and on `/hq/messages` as a warning. It is invisible otherwise:
uncovered diamonds produce no error, no failed message and no queue, just games
quietly going red all afternoon.

### 2A.6 Three attempts, then a human

**Decision.** A failed send is retried at 1, 5 and 20 minutes, then marked failed
and shown on `/hq/messages` with a plain-English reason and a retry button.

**Why.** A message that has failed three times over half an hour is not failing
because of a blip. Failures are also sorted before retrying: a timeout or a 429
is worth another go, but "that number cannot receive texts" will be just as true
in twenty minutes, and retrying it only delays the moment someone notices the
typo in a coach's phone number.

### 2A.7 The worker runs inside the web process

**Decision.** No separate worker service, no external cron. A timer started from
the root layout and the health check ticks every 30 seconds.

**Why.** This tournament is run by volunteers and deployed once a year. A second
service is a second thing to redeploy, and its failure mode is that somebody
forgets — with the symptom appearing on Saturday as "the texts stopped" and
nothing on the board to explain it. One process that always contains its own
worker cannot drift out of sync with itself.

Safe with more than one replica: sends claim their row with `FOR UPDATE SKIP
LOCKED` and chases dedupe on a unique index, so correctness never depended on
there being exactly one worker. `POST /api/jobs/tick` exists behind
`CRON_SECRET` for an external cron if that is ever preferred.

It is deliberately **not** started from Next's `instrumentation.ts` hook, which
would be the tidier home: Next compiles instrumentation for the edge runtime as
well as Node, and the edge build cannot resolve the Postgres driver's `fs`
import, which takes `npm run dev` down entirely.

### 2A.8 Inbound webhooks are recorded against Twilio's MessageSid

**Decision.** Every inbound text is claimed by `MessageSid` before anything is
written, and the reply is stored. A retry replays that reply rather than
deciding again.

**Why.** Twilio retries any webhook that times out or answers non-2xx. Without
this a retry writes a second `score_report` for the same text — and
`score_report` is append-only by design, so the duplicate can never be removed.
It would sit in the director's queue looking like an independent second opinion
on a game.

A claim older than 60 seconds is treated as abandoned and taken over, on the
grounds that a duplicate proposal in the queue is a smaller problem than a score
nobody recorded at all.

### 2A.9 Message bodies avoid non-GSM-7 characters

**Decision.** Plain hyphens, no em dashes, no emoji in anything sent.

**Why.** One character outside GSM-7 drops the whole message to 70 characters
per billable segment instead of 160. The spec's own example score request uses
an em dash; writing it that way would have more than doubled the cost of every
score request of the weekend for a difference nobody can see on a phone. Running
costs come out of donation dollars (§11), so `smsSegments` is tested and
`/hq/messages` flags anything over one segment rather than quietly paying for it.

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
   shifts have a screen, the chase runs off them, and `/hq/shifts` shows exactly
   which games have nobody to ask. But if the role does not exist, it is a
   spring recruitment ask, and path 1 is the primary route. **This is the
   highest-leverage question on the list**, and it is now the only thing
   standing between the code and a working primary path.
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
