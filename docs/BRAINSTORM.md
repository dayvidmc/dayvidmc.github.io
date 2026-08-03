# What this could be, for each person who touches it

A deliberately wide brainstorm across the six people whose weekend this is: the
**director**, the **scheduler**, the **coaches**, the **umpires**, the
**parents**, and the **volunteers**.

`docs/IDEAS.md` is the engineering backlog — what is half-built, what is a dead
end, what to do next. This document is the other half: it starts from a person
and a Saturday, not from the code. Some of it overlaps. Where it does, this
file says who it is *for* and why they would notice.

**Nothing here is a commitment.** It is a menu to argue with at the director
debrief (spec §12, Phase 0). Ideas are marked:

- **▲** — would change the weekend materially
- **●** — solid, worth doing
- **○** — nice, cheap, or speculative
- **✗** — argued against, with the reason

Two facts shape almost everything below, so they are stated once here:

1. **Nothing sends a text.** `notification` rows accumulate and no sender
   drains them. Every idea that involves telling somebody something is blocked
   on this. It is the single highest-value thing left.
2. **Umpires do not exist in this system.** No role, no table, no assignment,
   no page. Not one line of code mentions them. That is the largest structural
   gap after messaging, and an entire section below is about it.

---

## 1. The director

His weekend is: the phone does not stop, and he is the only person allowed to
change anything. Everything below is aimed at one of two things — *reduce the
number of decisions that have to reach him*, or *make the ones that do reach
him faster to make*.

### ▲ The 6am briefing

One screen, Saturday morning, before anyone arrives. What is different from the
printed schedule since it was printed. Which diamonds have nobody rostered.
Which teams have no coach phone number. How much float is in each till. What
the weather is doing. He reads it in the truck.

Today this information exists but is scattered across five screens, and three
of those are counts he has to interpret rather than answers.

### ▲ Delegation that expires

Every schedule change, every bracket override and every publish is
director-only. That is right on Friday and wrong at 2pm Saturday when he is
standing on Diamond 6. A grant — "HQ Desk 1 can act as director until 9pm
tonight" — with every action still recorded against the real human's name, ends
the bottleneck without losing the audit trail.

The permission check is already centralised (`isDirector`), so this is a small
change with a large effect on his day.

### ▲ Rain mode, which is a *delay*, not a cancellation

The rain button in the spec (§5.7) is discussed as a cancel. In practice the
common case is "everything after 2pm slides 45 minutes". That is a schedule
recomputation: push the affected games, respect diamond turnaround, detect the
games that now collide, and **show him the diff before it commits**. Then one
broadcast.

A cancel is the same machinery with a different tail. Doing the delay first is
better, because the delay happens four times a weekend and the cancel happens
once every five years.

### ▲ The cost of the decision he is about to make

Game-count tracking for rainout refunds already exists (§5.8). When he is
standing in the rain at 11am Sunday deciding whether to call it, the software
knows something he does not: **cancelling now costs $X across Y teams, and
playing two more innings changes that to $Z.** Putting that number on the
cancel screen turns a gut call into an informed one.

This is the single best use of data the system already has and currently
does nothing with.

### ● A ruling log

He makes twenty judgment calls a weekend. "We let Nepean bat nine." "We called
the Peewee game after four because of the storm." "We are treating that as a
forfeit, not a loss." Right now those live in his head, get relayed by phone,
and are gone by August.

One tap from any game or division: record a ruling, in his words, timestamped
and attached. It shows up in the game history, on the team page, and in next
year's archive. When a coach disputes a standing on Sunday night, he reads it
back instead of remembering it.

### ● One escalation inbox

Disputes, unmatched texts and failed sends are three separate screens today.
For him they are one thing: *somebody needs me*. Merge them, sort by how long
they have been waiting.

### ● The wall display

A spare tablet propped on the HQ table, auto-refreshing, big type, no chrome:
overdue count, disputes, queue depth, what is on now. He walks past and reads
it without touching it. Different from the board — the board is for working,
this is for glancing.

### ○ One-tap call

From any game, call either coach. From any diamond, call the volunteer on
shift. He is going to make that call anyway; make it not require finding the
number first.

### ○ The 30th-anniversary screen

Seven divisions, seven champions, on one page, for the closing ceremony and the
cheque photo. Cheap, and it is the emotional point of the whole weekend.

### ✗ A director mobile app

Everything above is a web page. A native app adds an app-store review cycle to
a tool that changes weekly right up to the tournament. Add-to-home-screen gets
95% of the benefit for none of the cost.

---

## 2. The scheduler

The person who builds the thing in a spreadsheet, months ahead, and then
rebuilds it four times. Mostly invisible until something collides.

### ▲ Re-import with a diff

Import is one-way today. The schedule changes right up to the week before, and
the only way to apply a change is to edit games one at a time in HQ or to have
never imported in the first place.

Re-upload the spreadsheet and see: **12 games moved, 2 added, 1 removed, 3
unchanged** — then apply, or not. This is the difference between the importer
being useful once and being useful all spring.

### ▲ The wall chart

Diamonds down the side, time across the top, three days. It is *the* scheduler
artifact — the thing that gets printed and taped to a wall — and it does not
exist in any form. Everything in the app is a list, and a list cannot show you
that Diamond 4 is empty from 11 to 2.

Also the fastest way to spot a bad schedule, which is why every tournament
scheduler in the country draws one.

### ▲ A bracket builder

Flagged in `IDEAS.md` §3 as the missing piece of the bracket work — but the
person who would use it is the scheduler, not the director. Pick a round, add a
game, say where each side comes from ("winner of Semifinal 1", "2nd in Pool
A"). The resolution engine behind it is built and tested; only the screen is
missing.

### ● Wider conflict validation

Today it catches diamond double-booking, team double-booking and tight
turnarounds. It should also catch:

- **an umpire double-booked** (needs §4 below to exist first)
- **travel time between sites** — `diamond.site` exists and is not used for
  anything; two games 20 minutes apart at different parks is a real failure
- **three games in a row** for one team
- **a 9pm finish followed by an 8am start**

Each of these is a phone call to the director on Saturday that never has to
happen.

### ● Team constraints, collected once

"Orleans cannot play before 10am Saturday." "Two of our coaches share a car."
These arrive by email in March and live in the scheduler's inbox. Capture them
against the team, then validate the schedule against them and show what is
violated. The `team` table is the obvious home.

### ● Draft and publish

Editing is live. There is no way to try a rearrangement and look at it. A draft
copy that can be compared and then published — with one broadcast at the end
rather than eleven — matches how the work is actually done.

### ● A fairness report

Which teams got the 8am Sunday slot twice? Who never played on the good
diamond? Who had every game at the far site? Coaches count these, and the
complaint lands on the director. Showing it to the scheduler in March costs
nothing and prevents it.

### ○ A round-robin generator

Given a pool and available slots, produce a draft schedule. Genuinely useful,
but it is the biggest single piece here, and a scheduler with a working
importer and a wall chart may not want it. Ask before building.

### ○ The print pack

Per-diamond day sheets, per-team schedules, the wall chart, blank score sheets.
Partly covered in `IDEAS.md` §5. Belongs to the scheduler, printed on Thursday.

---

## 3. The coaches

About ninety of them. Each has a magic link (`/team/[token]`) that needs no
password. The link is the best asset in the system and it currently shows a
read-only list.

### ▲ Make the team page do things

It already authenticates them. It should let them:

- **report a score** — more reliable than parsing a text, and the token already
  proves who they are
- **flag a dispute** without phoning HQ
- **say "we are running fifteen minutes late"** — which is the message that
  currently arrives as an unplaceable text
- **confirm their contact details are right**, which fixes the data quality
  problem that breaks SMS matching

Score reporting from the team page may be the cheapest reliability win
available: it removes the parser, the phone number matching and the ambiguity
in one move.

### ▲ "What happens if we win?"

The bracket already knows. Nobody has written the sentence.

> You are 2nd in Pool A. Win at 10:00 tomorrow and you play the winner of
> Semifinal 2 at 4:45 on Tokessy. Lose and you play the loser of Semifinal 2 at
> 2:30 for bronze.

Derivable entirely from data that exists today. It is the single most
frequently asked question of the weekend and it would answer itself.

### ● Next game, enormous, at the top

A coach opening the page on Saturday wants one thing. Time, diamond, opponent,
and how to get there. Everything else can be below the fold.

### ● A calendar feed

One ICS URL per team. Their whole weekend lands in the phone calendar and
**moves when the game moves**. This is the highest-leverage thing that works
without the SMS spine existing — the calendar does the notifying.

### ● Somewhere to say "we cannot field a team"

Forfeits currently arrive as a phone call at the worst possible moment. A
button, with a note, that lands in the director's escalation inbox.

### ○ Roster and player count

Needed properly for game counts and refund tiers, and for the umpire's lineup
card. Currently nowhere.

### ○ The other coach's number

For the "we are stuck on the 417" call. Small, and it prevents an HQ call.

### ○ After the weekend

Final standings, their record, the CHEO total. One email, one link. The
tournament's best fundraising moment is the week after it ends and nothing
currently uses it.

---

## 4. The umpires — this section is the finding

**There is no umpire anywhere in this system.** No `umpire` table, no role in
`StaffRole`, no assignment on a game, no page, no mention in any document. A
`grep -i umpire` across the whole repository returns nothing.

That is not an oversight in the code so much as a gap in the spec, and it is
worth raising at the debrief, because umpires are the group with the strongest
claim to being *the* source of truth about what happened in a game.

### ▲ Umpires as a first-class entity

Name, phone, certification level, which divisions they can work, and
availability by day and time block. Everything else depends on this existing.

### ▲ Assignment, with the same conflict validation as diamonds

An umpire cannot be at two diamonds at once, cannot cross sites in fifteen
minutes, and should not work six straight games in July heat. The validation
engine for this already exists for diamonds and teams; umpires would be a third
kind of resource running through the same checks.

### ▲ The umpire reports the score

Path 1 assumes a diamond volunteer texts it in. But the umpire is *at* the
game, is neutral, and signs the sheet. They are a better source than the
volunteer and a much better source than a coach.

Give them the same kind of magic link the coaches have, with their games on it
and a score box. This is likely the single largest improvement available to
score-intake reliability, and it needs no SMS at all.

### ▲ Honorarium tracking

Most tournaments pay umpires per game. Right now that is games worked × rate,
counted from a notebook, by a volunteer, on Sunday night, with real money at
stake and a charity's books on the other side.

Games are already tracked. Assignment plus a rate turns this into a report that
takes zero minutes and is auditable — which matters more than usual when 100%
of proceeds go to CHEO.

### ● Division rules at the plate

Division rules already exist and are configurable (§5.4) — mercy rule, time
limit, inning cap. The umpire is the person who needs them most and has no way
to see them. Their game page should show the rules for that division, on their
phone, at the diamond.

### ● No-show recovery

An umpire does not arrive for an 8am. Who else is here, who is free, who is
certified for that division. A "find a spare" view for whoever is coordinating.

### ● Incident reports

Ejections, injuries, protests. Currently paper or nothing. There are insurance
and liability reasons to have these recorded with a timestamp, and a protest
that reaches the director on Sunday needs the umpire's account attached to the
game.

### ○ Self-serve availability

Umpires enter their own availability before the weekend rather than the
coordinator collecting it by text. Depends on how the local association
actually assigns — ask before designing.

---

## 5. The parents and spectators

By far the largest audience, and the source of most of the phone calls HQ
fields. Two of their needs are already met well — the public schedule and the
bracket. The rest are not.

### ▲ Where is Diamond 3?

The most-asked question at any tournament, in any sport, anywhere. `diamond`
has a `site` column that nothing reads. Add a location and a map link, and put
it on every game everywhere it appears.

This is a small change that removes more HQ phone calls than anything else on
this list.

### ▲ A donate button

**100% of proceeds go to CHEO Cardiology.** That is the entire point of the
tournament, and it appears nowhere in the software. A parent looking at their
kid's bracket on a Sunday afternoon is the most receptive donor this
organisation will ever have, and right now the page does not ask.

Put the running total on the public pages too. Thirty years and over $536,000
is a story that raises money by being told.

### ● Follow a team

Pick your kid's team once. Every public page then defaults to it — their next
game, their standings, their bracket path. Local storage, no login, no account.

### ● Is play on?

One line at the top of every public page during the weekend, set by the
director. "All games on." "Delayed 45 minutes, next update at 2pm." Removes the
second-most-common phone call.

### ● Concessions from the stands

The till exists and knows the menu. What is available, at which stand, and
where the stands are.

### ○ The 50-50 pot

Current pot, where to buy. The licensing side is a legal question (§8A.4) and
not a technical one, but if it runs, showing the number drives sales.

### ○ Add to home screen

A web manifest. Matters most for this group, because they open it fifteen times
a day for three days.

### ✗ Live pitch-by-pitch scoring

Tempting, and wrong. It needs a dedicated scorekeeper at every diamond, and
this tournament runs on volunteers who are already stretched. The current
model — a score appears when HQ confirms it, and the page says so plainly — is
honest and achievable. Half-populated live scores are worse than none.

### ✗ A parent-uploaded photo gallery

Photographs of other people's children, uploaded by the public, with no
moderation capacity on a volunteer-run weekend. The risk is not worth the
feature. If photos are wanted, one designated photographer and a curated
gallery.

---

## 6. The volunteers

The coordinator role exists. Nothing behind it does.

### ▲ Diamond shifts, which are load-bearing

`diamond_shift` is how the system decides which games a texting volunteer could
plausibly be reporting on. It is the backbone of SMS score matching, **and it
has zero rows and no screen that writes to it.** Score intake path 1 is
therefore weaker than it looks, in a way that is invisible until Saturday.

### ● Sign up, check in, and drop out

Shifts before the weekend, a check-in on the day so the director's briefing
knows who actually turned up, and a way to say "I cannot make Sunday morning"
that reaches somebody.

### ● The volunteer's own page

Where am I, when, who do I report to, and what am I supposed to do. Most of
these people have never done it before and are handed a clipboard.

### ○ Hours tracking

Student volunteer hours are a real reason people sign up. Recording them and
producing a letter afterwards costs almost nothing and helps recruit next year.

---

## 7. Things that cut across everybody

- **▲ The messaging spine.** Said once at the top and repeated here because
  half of this document depends on it. Nothing sends.
- **▲ July sunlight.** Every screen here gets read on a phone, outdoors, at 2pm
  in July. Contrast that is fine on a desk is unreadable on a diamond. Worth a
  real pass, not a dark-mode toggle.
- **● Offline.** The till is offline-capable and nothing else is. Cell coverage
  at the far diamonds is an open question (§13 Q5) and the answer decides how
  much this matters.
- **● Bilingual.** This is Ottawa. Public pages in French is not a nice-to-have
  for a community tournament in this city.
- **● Battery.** A twelve-hour day on one phone. Auto-refresh intervals and
  polling need to be chosen with that in mind rather than defaulted.
- **○ One-handed.** Everybody is holding a coffee, a clipboard or a child.

---

## 8. If only three things get built

1. **Send the texts.** Everything else compounds off it, and its absence is
   currently a silent failure that would first become visible at the worst
   possible moment.
2. **Umpires.** They are absent entirely, they are the best available source of
   truth for scores, and there is money attached to getting their game counts
   right.
3. **Re-import with a diff, and the wall chart.** The scheduler is invisible
   until March, and these are the two things that make the spring survivable.

Close behind, and much cheaper than any of the three: **a map link on every
diamond**, and **a donate button on every public page**. Together they are
perhaps a day of work, and they address the most-asked question of the weekend
and the entire reason the weekend exists.
