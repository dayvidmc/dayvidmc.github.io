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

1. **What are the affiliate limits?** A maximum per game, only from a lower
   division, same association only, none in playoffs? "Not sure" was the
   answer, so it needs somebody who has read the rules. Belongs in the division
   rules where an umpire can see it.
2. **Which payment rails for 2027?** Committee decision. Owed to them: a
   one-page brief with the fee arithmetic — roughly 2.9% + 30¢ per transaction,
   about $2,000 off the ward across ninety teams — set against the cost of
   chasing e-transfers by hand.
3. **Is a donation to the tournament receiptable at all**, and under whose
   registration number? CHEO issuing them answers *who*, not *whether*. The
   donate page says "a receipt" rather than "a tax receipt" until this is
   settled.
4. **Is the signed-sheet requirement KBA/Little League or local custom?**
   Determines whether the photo-of-the-sheet field ever becomes more than
   optional.
5. **Does the director want an approval queue at all**, or would he rather
   personally see every score? The whole HQ flow assumes the queue.
6. **Cell coverage at each diamond.** If it is bad anywhere, score intake path
   1 needs a fallback there specifically.
7. **Can results be pushed back into RAMP?** Affects the end-of-weekend export.
8. **Who owns sponsor and auction donor relationships?**
9. **The real per-division rules** — time limits, run rules, pitching — checked
   against this year's documents. The rules screen exists and every division
   currently carries the same imported defaults.

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
