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

### 2.15 A CHECK constraint is rebuilt from the current list, never an old one

**Decision.** Adding a value to a `CHECK (col IN (…))` means dropping and
recreating the constraint with **every** value the column already legally
holds — which is the union of the original list and everything later
migrations added, not the list in the file that created it. `npm run
migrate:check` enforces this by applying migrations twice: once to an empty
database, and once to one carrying a row for every value legal at each step.

**Why.** This is written down because it already caused an outage. Migration
006 added `'umpire'` by rebuilding the constraint from 001's list, which
predates `'unknown_sms'` being added in 002. Every fresh database accepted it.
The live one held rows using that value, rejected the new constraint, and —
because migrations run on boot — never started.

The class of bug is invisible to a fresh-database test by construction: a
narrowed constraint only fails where the older data lives. That is why the
second pass exists rather than a single "do the migrations run" check.

### 2.16 Texting is off by default, and a credential is not consent to send

**Decision.** The SMS provider is the console one — messages logged, marked
sent, nobody texted — unless `SMS_PROVIDER=twilio` is set explicitly. Having
Twilio credentials in the environment is not enough.

**Why.** The obvious design is "use Twilio if it is configured", and it is
wrong. A rehearsal, a staging copy or a restored database backup would all pick
up a stray credential and start texting ninety real coaches. Requiring a
separate, explicit switch means turning sending on is always something somebody
decided to do.

The same reasoning puts the drain endpoint behind `SENDER_TOKEN` and closes it
entirely when that is unset: an open endpoint that costs money per call is a
gift to anyone who finds it.

### 2.17 Consent is checked when a message is sent, not when it is queued

**Decision.** `sms_opt_out` is consulted at send time. A message queued before
somebody texted STOP is cancelled rather than delivered.

**Why.** The queue can be minutes or hours behind. A coach who opts out on
Saturday morning must not receive Friday night's backlog — that is precisely
the complaint that STOP exists to prevent, and "it was already in the queue" is
not a defence under CASL or to a carrier.

Consent lives on the phone number rather than on `team`, because the person
texting STOP may be a volunteer, an umpire, a coach's spouse using their phone,
or a wrong number. None of those have a row in `team`.

**Also decided:** the keyword match is strict — the whole message must be the
word. "Stop the game, it's raining" is not an unsubscribe request, and reading
it as one silences a coach for the rest of the weekend.

### 2.18 Taken is not raised, and an unknown cost is not a cost of zero

**Decision.** Concession items carry a cost, and a total computed over any item
whose cost is unrecorded is reported as a **ceiling** rather than a total,
naming the items responsible. Stock marked as donated costs nothing regardless
of what is in its cost field.

**Why.** The till reported revenue and every screen called it takings, which is
correct and is not what anyone means by "how much did we raise". The gap is not
academic: Montana's donate the food and the labour for the main-field BBQ, so
that stand is close to 100% margin, and a canteen selling bought-in pop is
nowhere near. Averaging the two hides both the real cost of the canteens and
the real size of the gift.

Assuming a missing cost is zero would overstate the total; assuming a typical
cost would understate it and be invented. Somebody is going to read this number
out at a cheque presentation, so it says which it is.

### 2.19 Donated time is recorded and cannot be receipted

**Decision.** `gift_in_kind.kind` separates goods from services. A receipt
requested against donated services is flagged rather than quietly ignored.

**Why.** Under CRA rules a gift must be of property, so donated labour — a
sponsor's staff cooking all day — is not receiptable however generous. A
business can invoice, be paid, and donate the money back, which is; but that is
a different arrangement somebody has to choose deliberately.

It is still recorded, because it is most of what the sponsor actually gave and
the thank-you should say so. What must not happen is a volunteer promising a
receipt the treasurer cannot issue, and nobody finding out until September.

**Confirm with:** the treasurer. This is an accounting decision, not a
technical one; the software's job is to capture fair market value at the moment
the gift arrives, because that is unrecoverable afterwards.

### 2.20 A tie on a bid sheet goes to whoever wrote it first

**Decision.** `winningBid()` sorts by amount descending, then by the time the
bid was recorded ascending. Two bids of $150 mean the first one wins.

**Why.** The sheet already says this. The second person to write $150 wrote it
underneath the first, on a sheet that says the highest bid wins and gives an
increment to clear. Any other rule — a coin toss, asking them to bid again —
needs someone to stand there and adjudicate at the moment the room is emptying.

**Confirm with:** nobody. If the auction lead wants a different rule they will
say so, and it is a one-line change with a test that names it.

### 2.21 A lot with a bid on it cannot be marked "no bids"

**Decision.** `setStatusAction` refuses `unsold` on a lot with a live bid, and
the button is not shown for one. Striking every bid out first, or withdrawing
the lot, are the two honest routes.

**Why.** The two states look identical afterwards — a lot with no winner
against it — but one of them has quietly removed real money from the total.
This runs at 9pm on a phone with buttons next to each other. The "no bids"
sweep on the board has the same shape and is the same guard: it names the lots
it will close, and it only touches empty sheets.

**Related:** the same reasoning as §2.13. A state that cannot be told apart
from a mistake afterwards is worth refusing at the moment it is made.

### 2.22 A phone number off a bid sheet is normalised, and an illegible one is dropped

**Decision.** Both bid-writing paths put the number through `normalisePhone`.
One that will not parse is stored as no number rather than rejecting the bid.

**Why.** Winners are texted through the same outbound queue as everyone else,
and that queue matches a person to a number by exact string comparison — an
opt-out recorded against `+16135550188` does not stop a message addressed to
`613-555-0188`, and that is somebody who asked us to stop texting them.

The dropping half matters more. This runs at 8pm with a stack of paper: a
winning bid must never be lost because the mobile column was scrawled. A
winner with no readable number gets found by voice, which is what would have
happened if the column had been left blank — and the count of those winners is
shown, so somebody knows how many to go and find.

### 2.23 A card number never reaches this server

**Decision.** The payment provider hosts the page that takes the card. Our
interface has two calls — start a checkout, verify a webhook — and no method
that accepts a card number. There must never be one.

**Why.** PCI DSS scope. A tournament run by volunteers can attest to SAQ-A,
which is the bracket you are in when the card is entered on the processor's own
page and your server only ever sees a token. The moment a card field is posted
to this application, the committee is signing a different form about a system
none of them maintain.

The corollary is that "our own payment taking" means *our own merchant account
with somebody else's card form*. The money is the tournament's; the card page
is not, and should not be.

**Confirm with:** the treasurer, when opening the merchant account.

### 2.24 The window is enforced in the write, not on the screen

**Decision.** Before the opening minute the public page has no form on it —
not a disabled one, none — and `createEntry` re-reads the opening time from the
database inside the same transaction that inserts.

**Why.** With one hard opening time announced to ninety coaches, the fairness of
every place given out rests on nobody being able to submit early. A disabled
control is a suggestion; the server refusing is the door. Both are needed: the
missing form is the polite half, the transaction is the real one.

**Related:** the same reasoning puts the queue in `submitted_at` order and
nothing else, and gives the HQ board no way to sort by anything. A column header
that let somebody order the queue by "paid" would quietly turn an opening time
into an auction.

### 2.25 A payment row means money moved

**Decision.** `entry_payment` has no status column and is append-only. A started
card checkout lives at the provider until it succeeds; the webhook writes the
row. A coach saying they have sent an e-transfer is a claim on the entry, not a
payment.

**Why.** A row that can go from `pending` to `paid` has to be reconciled against
the provider forever, and a stale pending row is indistinguishable from a real
one at the moment somebody is deciding whether a team is in. Keeping the claim
separate also means the treasurer's to-do list — "somebody says they sent this,
find it" — is a real list rather than an inference.

A claim is settled by a payment recorded *after* it, not by the entry being paid
at all: the same coach transfers the deposit in January and the balance in
March, and treating the second claim as handled because the first was is how a
balance goes missing.

### 2.26 Accepting creates the team; un-accepting does not delete it

**Decision.** Accepting an entry creates the `team` row in the same transaction
and stamps the balance deadline. Moving an accepted entry to any other status
breaks the link and leaves the team.

**Why.** By the time somebody changes their mind the team may be on a schedule,
in a pool, and in a bracket slot. Deleting it would leave games pointing at
nothing. The director is told the link is broken and can deal with the schedule,
which is a conversation, not a cascade.

The deadline is stamped rather than recomputed for the same reason §2.14 pins a
bracket slot: the date the coach was told is the date on the record, even if
somebody changes the setting in March.

### 2.27 Age group and division are two questions, not one

**Decision.** An entry records both. The age group is required and comes from a
list the director maintains; the division is the tier they are asking for.

**Why.** A coach knows their age group for certain, because birth years decide
it. Which tier they belong in is an opinion, and one the director may overrule
after watching them for a weekend. Holding both is what makes "move this team
from A to B within Bantam" a thing somebody can do — with only the division,
that move loses the one fact nobody had to look up.

The list is data rather than a set in code because Baseball Ontario has renamed
these twice in ten years, and a tournament that decides to say "13U" instead of
"Peewee" should not be waiting on a deployment. An empty list means the field
falls back to free text: blocking every entry on a setting nobody filled in
would be worse than a word the director tidies up afterwards.

### 2.28 The balance is due on a date, or so many days after acceptance

**Decision.** A stated calendar date wins when it is set; otherwise the balance
is due N days after that team was accepted. Either way the date is stamped onto
the entry at acceptance and never recomputed.

**Why.** Both are real. A fixed date is what goes on a poster and makes chasing
one list rather than ninety; days-after-acceptance is fairer to a team taken off
the waitlist in April, who would otherwise be handed a deadline that has already
gone. The tournament picks.

A fixed date already in the past is used as-is rather than quietly moved. A team
accepted after the stated deadline does owe the money now, and inventing them a
fresh fortnight is the kind of kindness that costs a tournament its own
deadline.

### 2.29 A team row cannot be deleted, by anything

**Not a decision so much as a discovered property, recorded so nobody trips
over it.** `score_report`'s append-only trigger is `FOR EACH STATEMENT`, so the
`ON DELETE SET NULL` cascade from `team` raises even when it would null out
nothing at all. The practical effect is that no `team` row can ever be deleted.

That is the behaviour the design wants — §2.26 says un-accepting an entry must
not delete a team that may already be on a schedule — but the error somebody
would see is `score_report is append-only`, which says nothing about teams. If a
"delete this team" control is ever wanted, it needs a real answer for the games,
pools and bracket slots pointing at it, not a change to that trigger.

The browser checks assert the deletion fails, so this cannot be quietly
"fixed".

### 2.30 Thirteen divisions, grouped by age group everywhere

**Decision.** `division.age_group` holds Rookie / Minor / Major / Junior, and
every screen that shows all the divisions groups by it. The tier stays part of
the division's own name.

**Why.** The real shape is thirteen — Rookie A/B; Minor All Star/A/B/Girls;
Major All Star/A/B/Girls; Junior A/B/Girls. Thirteen rows of anything is a list
nobody reads to the bottom of, and the question a director asks of that table is
"is this age group full", not "what is the thirteenth row".

Note that the second axis is **not** a skill tier. Girls sits beside All Star, A
and B rather than under them, which is why it is not modelled as one — an
`enum('all_star','a','b')` with a gender stream jammed into it would be wrong
about the tournament in a way that got harder to unpick every year.

`divisionLabel()` drops the age group when the division's name already begins
with it, so a card says "Major A" and not "Major · Major A" ninety times.

### 2.31 One fee and one deposit, set once for all thirteen

**Decision.** `tournament.default_entry_fee_cents` and `default_deposit_cents`
are what the director sets; saving them writes every division. Per-division
figures still work, for the exceptions.

**Why.** The fee is similar across age groups. Typing the same number thirteen
times is thirteen chances to mistype it, and the mistyped one is not discovered
until a coach pays the wrong amount.

Lowering the tournament-wide fee below a division's deposit drags the deposit
down with it rather than failing on the CHECK that keeps a deposit inside its
fee. A director cannot see that constraint, and a save that fails without
explanation is worse than one that does the obviously-intended thing.

### 2.32 An uneven pool is reported, not resolved

**Decision.** `poolBalance()` says whether everybody in a pool has played the
same number of games and names who is short. The standings screen shows it and
states that the table is not a seeding. Nothing switches to points-per-game.

**Why.** Rain here can mean games are **dropped**, not just compressed, and the
table ranks on total points — which is only fair when everybody has had the same
number of chances. The tournament's stated answer is that the tournament team
decides on the day, and that is the right answer: no rule survives "we lost
Saturday morning on two diamonds".

So the software's job is to stop a coach reading a seeding off a table the
weather partly wrote. Quietly switching to points-per-game would be a different
and equally unilateral answer, arrived at by nobody.

### 2.33 Refund terms are stated before the money, or not at all

**Decision.** `refund_cutoff_date` and a free-text note, shown on the entry page
and again directly above the payment options. With no cutoff set, both pages say
nothing about refunds.

**Why.** Terms somebody finds out about when they want their money back are not
terms. And a default — "non-refundable", say — would be inventing a policy on a
committee's behalf about other people's money, which is worse than silence.

The cutoff day itself is refundable: "non-refundable after 1 May" means the 1st
is the last day, which is how anybody reading a poster takes it. Being stricter
than the sentence the coach was shown is a surprise, not a rule.

### 2.34 A roster over the maximum is a warning, not a wall

**Decision.** `max_roster_size`, 14 by default, produces a note on the roster
screen. Affiliates called up for the weekend are not counted against it.

**Why.** A roster arriving with fifteen names is a conversation with a coach,
not a crash — but nobody counts to fourteen by eye on a Friday night, so it has
to be said. Counting affiliates would flag exactly the team that was already
short of players, which is the opposite of useful.

### 2.35 Costs arrive as a shop, not as a hot dog

**Decision.** `concession_purchase` records one line per receipt — a total, a
date, who paid. A purchase total on its own settles the "this figure is a
ceiling" warning; per-item costs still work for anyone who wants them.

**Why.** Receipts are kept and totalled. That is how the shopping actually gets
recorded, and asking anybody to price a single freezie to the cent produces a
column nobody fills in — which then makes the money screen call its own
headline a ceiling forever. A treasurer doing the work the honest way should
not be told her figure cannot be trusted.

### 2.36 Somebody is out of pocket, and that is a debt to a person

**Decision.** A purchase can be marked as paid personally. Until it is
reimbursed it appears by name at the top of the purchases screen and on the
money screen.

**Why.** A volunteer who fronted the Costco run is owed real money by the
tournament, and until now that appeared nowhere in this system at all. It is
not a second cost — the purchase is already counted — it is a different
question with a different answer: who do we owe, and how much.

Recording a purchase is open to the concession lead, because the person who did
the shopping is the person holding the receipt and making them find a director
is how receipts end up in a glovebox until September. **Paying somebody back is
the director's**, because it is the one line on that screen somebody could
quietly write in their own favour.

### 2.37 A markdown is set by a lead, never typed at the till

**Decision.** `concession_item.clearance_price_cents`, set on the menu screen,
applied by `sellingPrice()` everywhere. The till has no way to enter a price.

**Why.** Sunday afternoon with forty freezies left is a real situation and a
lower price is the right answer. Letting a volunteer type any number into a
till is not, because a till whose prices can be anything is a till that is
evidence of nothing — and cash reconciliation depends on it being evidence.

The button shows both numbers, struck-through and new. A price that changed
without the customer being able to see why is a conversation the volunteer
cannot win.

A "markdown" above the ordinary price is refused by the database, by the domain
and by the save action, with an explanation on the third — it is a price rise
with a nicer name.

### 2.38 A sponsor is owed a line in the pamphlet and a thank-you

**Decision.** `sponsor` holds the relationship, what was promised, how the name
should be printed, and whether the pamphlet entry and the thank-you have gone
out. Gifts and cash link to it.

**Why.** What a sponsor wants back is not complicated, and both halves have
failed before — not through carelessness but because the promise lived in an
inbox and the pamphlet had a print deadline nobody tracked against it.

The pamphlet outranks the thank-you on the screen, and not by a little. A late
thank-you is a letter sent late; a missing pamphlet entry is a promise broken
in print, in front of everybody, and unlike almost everything else here it
cannot be fixed on the day.

`pamphlet_name` is separate from `name` because "Kanata Home Hardware" is what
everybody calls them and "Home Hardware (Kanata) Ltd." is what goes in print,
and getting that wrong in a pamphlet is worse than leaving them out.

Both flags toggle in **both** directions. The person working down that list is
doing it from memory and will occasionally tick the wrong row; a box that
cannot be un-ticked means the only way back is a database.

### 2.39 CHEO's foundation issues the receipts, so nothing here does

**Decision.** No screen in this repository prints, emails or resembles a
charitable receipt. The sponsors screen says so in as many words.

**Why.** The foundation issues them. The tournament's job is a clean list of
who gave what — and something that looks like a receipt, produced by software
with no charitable status behind it, is a problem for a treasurer rather than a
convenience.

The fair-market-value fields therefore exist for the thank-you letter and for
the foundation's list, not for tax. That is a different purpose and it survives
somebody asking what the number is for.

---

## 3. Deliberately not built

| Thing | Why |
|---|---|
| Raffle / 50-50 logic | §7.4 — likely needs an AGCO or municipal licence. Legal question for the committee, not a technical one. No draw functionality exists. |
| Charitable receipting | §8A.4 — entry fees are generally not receiptable; who issues the receipt is unresolved. The schema separates payment types from day one so this is not painful later, but no receipting logic is written. |
| Scheduling engine | §5.1 — explicitly out of scope for v1. |
| Bracket generation | §5.6 — depends on §13 Q4 (how the schedule is actually built). |
| Player rosters, stats, the public website | §2 — RAMP and WordPress keep these. Entry-taking is now ours; the rest of what RAMP does is not, and should not be. |
| A card form of our own | §2.23 — the provider's hosted page takes the card. This is permanent, not an interim step. |
| Charging a card from HQ | A card payment only ever arrives from the provider with its own reference. A hand-typed one would create money in this system that does not exist in the merchant account. |

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

Everything else in this repository can run in parallel with the current process
— if it fails, nobody notices. Entry-taking cannot. There is no shadow mode for
taking money.

The spec's advice, on the 30th anniversary, was the second option. That was
written before entry-taking existed; it now does, and the shape of the risk has
changed enough to be worth restating rather than assuming.

**What is now true.** The two rails that cost nothing — e-transfer and cheque —
need no external account and no card processing at all. In that configuration
the software is doing what a spreadsheet and an inbox do today: taking an
application, holding a queue, and recording money a treasurer confirms by hand.
The failure mode is a bad afternoon, not a lost fee, because no money passes
through anything this code controls.

**What is still true.** The opening minute is unforgiving. Ninety coaches
refreshing one page at one time, and if it is down or wrong, the tournament
spends the evening on the phone and the fairness of the queue is gone. Nothing
tests that except doing it.

**So the honest recommendation is a middle one the spec did not offer.** Take
entries here for 2027 with e-transfer and cheque only, keep the existing process
as the stated fallback in the same announcement, and leave cards for 2028 once a
year's figures exist to show the committee what the processing fees would have
cost the ward. If instead the committee wants to wait entirely, the 2027 game-ops
modules need coach contact data imported from the existing system rather than
collected natively — the `team` table has `coach_phone`, `coach_email` and
`alternate_contact` ready for exactly that import, and team communication (§5.7)
does not work without them.

**Confirm with:** the committee. This is a risk appetite question, not a
technical one, and it is the only decision in this document that has a deadline.
