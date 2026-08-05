# What we have been told

**Read this before asking the committee anything.**

Every question put to the family, and the answer. Kept because three of the
questions asked on 3 August 2026 had already been answered — and the answers
were sitting in this repository, written into a migration comment and a
decision record by an earlier session. Asking a volunteer something they have
already explained is a small rudeness that adds up, and it spends the goodwill
needed for the questions that genuinely are open.

The rule: **before asking, grep this file, then grep `DECISIONS.md`, then grep
the migrations.** A fact that shaped a schema is usually recorded next to the
column it shaped.

When a new answer arrives, add it here in the same turn it is given.

---

## Who answers what

| Person | Their part of it |
|---|---|
| **David's father** | Game operations — rosters, scheduling, brackets, umpires, rules, rain, the diamonds |
| **David's mother** | Concessions, some sponsors including Montana's, and the treasurer's work |
| **The committee** | Anything with money or risk attached: payment rails, whether to ask for donations, receipting |

---

## The tournament itself

| Fact | Source |
|---|---|
| Founded **1996**, in memory of Scott Tokessy | The tournament's website |
| Scott was **twelve**; he died suddenly of an irregular heartbeat after hitting a home run for his Kanata house league team, in May 1996 | The tournament's website |
| Every dollar goes to the **Cardiology department at CHEO** | Throughout |
| **$536,000** raised since 1996 | The tournament's website |
| The Tokessy family still help plan it, and are at the main field during the weekend | The tournament's website |
| Run **entirely by volunteers** — no paid staff at all | The tournament's website |
| Three days: **all teams play Friday and Saturday, playoffs Sunday** | The tournament's website, confirmed by David |
| 2026 was the 29th, 31 July – 2 August, **90+ teams** planned | The tournament's website |
| 2025 was the 28th, 1–3 August, 74 teams | The tournament's website |
| **13 divisions**: Rookie A/B, Minor A/B/All Star/Girls, Major A/B/All Star/Girls, Junior A/B/Girls | Earlier session, encoded in `demoData.ts` |
| Junior Girls was new in 2026 | The tournament's website |
| Major plays at **Scott Tokessy field and Walter Baker East and West** | The tournament's website |
| **Opening ceremonies: Saturday, 10am** | David, 3 Aug 2026 |
| The Gold Glove is drawn at opening ceremonies | Earlier session |
| Sponsorship enquiries go to the tournament's fundraising manager | The tournament's website |

> The website could not be fetched directly — this environment's network policy
> refuses arbitrary hosts — so those rows come from search result summaries
> rather than the pages themselves. Treat them as good but not verbatim.

---

## Game operations

| Question | Answer | When |
|---|---|---|
| How is the **Gold Glove** winner chosen? | **A random draw from every registered player.** Not a vote, not a family choice, not a skills competition. | 3 Aug 2026 |
| How is the **playoff bracket** built? | **By hand on Saturday night**, from the standings. So the software should propose one and let the director move any team anywhere. | 3 Aug 2026 |
| Should the system **text a supervisor** for a score? | **Yes — but make it a toggle, and only text when the score has not already been submitted.** Nobody wants a text about a game they have already reported. | 3 Aug 2026 |
| Are **rosters** submitted in advance? | **Yes, submitted in advance and then locked.** This is what makes the Gold Glove pool a real pool. | 3 Aug 2026 |
| Are **affiliate players** allowed? | **Yes, with limits.** The limits themselves are not known — see the open list. | 3 Aug 2026 |
| What happens when it **rains**? | **It varies; the director decides on the day.** So the rain button should offer drop / slide / shorten and get out of the way. | 3 Aug 2026 |
| Who are the **umpires**, and are they paid? | **A mix — some paid, some not.** So the rate belongs on the umpire, not on the tournament. | 3 Aug 2026 |
| How many **sites and diamonds**? | **It changes year to year**, depending which parks the city allocates. So nothing should assume a shape. | 3 Aug 2026 |
| What gets **engraved**? | **A perpetual trophy per division that comes back each year** — so it is a new plate, not a new trophy. The software's job is the engraving list only; somebody else knows where the trophies are. | 3 Aug 2026 |
| Does a **per-diamond volunteer role** exist? | Superseded. The signed sheet goes to a **site supervisor** covering two or three diamonds, and *they* text it in. | Earlier session |
| Does the director want a **score approval queue**? | **Yes — nothing moves a standing without a human check.** Confirms the design: a texted score sits as a proposal until somebody approves it. | 3 Aug 2026 |
| Where do the **per-division rules** come from? | **One document covering all of them**, with exceptions. So most divisions share values and only the exceptions need typing — the rules screen should gain an "apply to every division" action like the entry fee has. | 3 Aug 2026 |
| Is keeping the **signed scoresheet** a formal requirement? | **No — it is how it has always been done.** So the paper is a backstop for arguments and photographing it stays optional. | 3 Aug 2026 |
| What is the **mobile coverage** at the diamonds? | **Bad at one of the outlying parks** — Mike Channing, Roland Michener, Kinsmen or March Central. Which one is not yet known. The score path needs an offline queue there. | 3 Aug 2026 |
| Do results need to go **back into RAMP**? | **Yes.** So the end-of-weekend export has to match whatever RAMP will accept, and somebody has to find out what that is. | 3 Aug 2026 |

---

## Money, concessions and sponsors

| Question | Answer | When |
|---|---|---|
| **Montana's** — is the food donated or discounted? | **Given outright — the food *and* the labour.** This was already in `DECISIONS.md` §2.18 before it was asked again. | Earlier session, re-confirmed 3 Aug 2026 |
| Do **sponsors** have named tiers? | **No — mostly in kind, negotiated one conversation at a time.** Already in the `sponsor` table's own comment before it was asked again. | Earlier session, re-confirmed 3 Aug 2026 |
| Does the **canteen take cards**? | **Yes, Square readers already.** So the Square hand-off matters and must be tested on a real device before July — it is written and has never touched a real reader. | 3 Aug 2026 |
| How many **concession tickets** per team? | **One per player, once** — not a flat number per team. Should be derived from the roster. | 3 Aug 2026 |
| What happens to the **cash on Saturday night**? | **It varies; nobody has a rule.** So the screen records what happened rather than enforcing a routine. | 3 Aug 2026 |
| Who issues **charitable receipts** for donations? | **CHEO issues them.** So the tournament needs an export of donor name, address and amount — and the donate page must collect a postal address, which it does not yet. | 3 Aug 2026 |
| Should the **donate button** go on every public page? | **No — a dedicated page only.** Not on the schedule and bracket pages. | 3 Aug 2026 |
| Was last year's **$45,000** net or gross? | **Nobody is certain.** So the public comparison must be labelled honestly rather than implying a precision that is not there. | 3 Aug 2026 |
| Does **HST** apply to concession sales? | **No — exempt fundraising sales.** So the till is right as built: a price is the final amount paid, with no tax calculated or separated. This had been open in `docs/CONCESSIONS.md` since the till was written. | 3 Aug 2026 |
| Is the **entry fee** similar across age groups? | **He sets it fresh each year.** So what matters is the screen being quick to fill in rather than what last year's figure was. The one-number-plus-overrides design stands. | 3 Aug 2026 |
| What is the **refund policy** when a team withdraws? | **Full refund before a cutoff date, nothing after.** The `refund_cutoff_date` field exists for exactly this, and the terms are stated before anybody pays. | 3 Aug 2026 |
| Does a **concession lead** open and close each till? | **Yes.** Confirms the design — the volunteer selling cannot close the till, which is what makes the count mean anything. Also open in `docs/CONCESSIONS.md` until now. | 3 Aug 2026 |
| Is the **till worth running at all**, given Square? | **Show the committee both and let them pick.** So the demo has to make the difference visible: Square does not reconcile a cash drawer, does not know what stock cost, and cannot say what the weekend raised. | 3 Aug 2026 |
| When is the **cheque presented**, and is it final? | **At opening ceremonies, Saturday 10am, and it is this year's money, estimated.** Only Friday has been played by then, so most of it is projection and the screen must say so. | 3 Aug 2026 |
| Which **payment rails** for 2027 entries? | **The committee's call.** They want a written decision with the fee arithmetic. Not yet delivered. | 3 Aug 2026 |
| Is the **raffle / 50-50** licensed? | Unresolved — likely needs an AGCO or municipal licence. No draw functionality is built. | Earlier session |

---

## People and communication

| Question | Answer | When |
|---|---|---|
| How do **coaches** hear from the tournament today? | **Email.** Not text, not WhatsApp, not Facebook. This is the most consequential answer of the twenty: the messaging spine is SMS-only, so an email channel is not an enhancement, it is the channel they actually use. | 3 Aug 2026 |
| Is volunteer staffing organised? | "A mix, and it is a struggle every year." | Earlier session |

---

## The website and the organisation

| Question | Answer | When |
|---|---|---|
| Where is the **test deployment**? | **https://tokessy.up.railway.app** — recorded in `docs/DEPLOY.md`. No session can reach it: the agent environment refuses arbitrary hosts, so whether it is up, and which branch it serves, has to be checked by a person. | 3 Aug 2026 |
| What happens to **tokessytournament.com**? | **Point it at this.** One address, one system. Needs whoever controls the DNS, and a redirect map so old links — `/2024-results/`, `/scotts-story/`, `/links-and-info/maps/` — land somewhere sensible rather than on a 404. | 3 Aug 2026 |
| What **images** exist? | **A logo, photographs and sponsor logos — take them from the current site.** See the note below: this environment cannot reach that site, and there is no image hosting built yet. | 3 Aug 2026 |
| Where should **children's names** appear? | **The committee should decide.** Current position, to be confirmed rather than assumed: rosters are visible on a team's own link and inside HQ only, nothing is on a public page, and the Gold Glove winner's name is HQ-only. | 3 Aug 2026 |
| Does anything need to be in **French**? | **Worth asking the committee.** Open. Ottawa is officially bilingual and teams travel in from across the region; the current site is English only. | 3 Aug 2026 |
| Who needs **HQ access**? | **Nobody has thought about it.** Open, and worth settling before July — a PIN handed out on the Saturday to somebody who needed one is how the auction screen ends up open on a phone in a car park. | 3 Aug 2026 |

### The images cannot be fetched from here

The answer was "grab them from the current website". This environment's network
policy refuses arbitrary hosts — `tokessytournament.com` returns 403 on CONNECT,
which is why the site's content was reconstructed from search results rather
than read. So the images have to arrive another way: somebody downloads them and
puts them in the repository, or they are attached to a session.

There is also a prerequisite. **Nothing in this repository can host an image
yet** — no upload path, no object store, no size limit. That is a real piece of
work rather than an afternoon, and it has to exist before any logo can go in a
header. Recorded in `docs/IDEAS.md` §13.

And photographs of children run into the unanswered question above. That
decision should come first.

---

## Contradictions to resolve

**Last year's total.** Search summaries of the tournament's own site say last
year raised **$30,000**, bringing the lifetime figure to $536,000. David said
**$45,000**. Both are editable settings so nothing is baked in, but the number
is what the whole public site is built around and somebody should reconcile it
before it goes in front of anybody. It is possible the two refer to different
years.

**Team count.** The site says 74 teams in 2025 and 90+ planned for 2026;
earlier notes said ~90. Probably the same fact at different points in a
planning cycle, but worth confirming before a page says a number.

---

## Still open

Genuinely unanswered. These are worth asking.

1. **May children be named on a public page?** The committee's call, and it
   gates the honour roll's future, any photograph, and whether the Gold Glove
   winner can be announced anywhere but a park. Current position is the
   cautious one; it should be confirmed rather than inherited.
2. **Which outlying park has the bad signal?** Mike Channing, Roland Michener,
   Kinsmen or March Central. Ten minutes with a phone at each answers it, and
   the score path needs an offline queue wherever it is.
3. **What are the affiliate limits?** A maximum per game, only from a lower
   division, same association only, none in playoffs? Belongs in the division
   rules where an umpire can see them.
4. **Which payment rails for 2027?** Committee decision. Owed to them: a
   one-page brief with the fee arithmetic — roughly 2.9% + 30¢ per transaction,
   about $2,000 off the ward across ninety teams — against the cost of chasing
   e-transfers by hand.
5. **Is a donation to the tournament receiptable at all**, and under whose
   registration number? CHEO issuing them answers *who*, not *whether*. The
   donate page says "a receipt" rather than "a tax receipt" until this is
   settled.
6. **What format will RAMP accept** for results going back in? Possibly the
   same shape the schedule came out in, which would make this easy.
7. **Does anything need to be in French?**
8. **Who needs HQ access, and how many of them?** Seven accounts exist. If
   every site supervisor needs their own site's board, that is another eight
   and a narrower permission than any that exists today.
9. **Who controls the DNS for tokessytournament.com?** Needed before the domain
   can point anywhere, and worth knowing regardless — a renewal nobody is
   watching is how a tournament loses its address.
10. **Who owns sponsor and auction donor relationships?**
11. **The real per-division rules.** One document covers them all; somebody has
    to read it out while somebody types.

---

## Answered, and then asked again anyway

Recorded so it stops happening. Each of these was already in the repository
when it was put to the family on 3 August 2026.

| Re-asked | Where the answer already was |
|---|---|
| Is Montana's food donated or discounted? | `DECISIONS.md` §2.18 — "Montana's donate the food and the labour for the main-field BBQ" |
| Do sponsors have named tiers? | `017_purchases_sponsors_markdowns.sql` — "a tier enum would be a lie about how it actually works" |
| Are affiliate players allowed? | `domain/roster.ts` — the affiliate flag and its warnings only exist because somebody said they are permitted |

The near-misses, which were reasonable to ask but should have been framed as
confirmations rather than open questions: rosters being locked in advance
(`roster_locked_at` existed), and umpires being paid (the honorarium report
existed). Both turned out to carry new information — "a mix, some paid, some
not" changed the design — so asking was right; asking as though nothing was
known was not.
