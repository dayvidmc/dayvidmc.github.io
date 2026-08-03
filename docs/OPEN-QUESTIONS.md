# Open questions

Two sets. The first is from the spec (§13) and is unchanged. The second came
out of writing the domain core — places where the published rules or the spec
are genuinely ambiguous, and where the code currently makes an assumption that
somebody should confirm.

Nothing here blocks the current code. Everything here could change it.

---

## From the spec (§13) — answer before Phase 2

1. Does a per-diamond volunteer role already exist (field marshal, convenor)?
   If yes, §5.2 is a small change. If no, it is a recruitment ask that must
   reach the committee by spring.
2. Is the signed-sheet requirement a KBA or Little League obligation, or just
   custom? Determines what is negotiable later.
3. Does the director want an approval queue, or does he want to keep personally
   knowing every score? Build to his preference.
4. How does he actually build the schedule today — spreadsheet, software,
   paper? Determines the import format.
5. Cell coverage at each diamond. Offline queueing is only needed where it is
   genuinely bad.
6. What is the tournament licensed for regarding raffles / 50-50?
7. Who owns the relationship with sponsors and auction donors, and what do they
   use now?
8. Can final results be pushed back into RAMP, or is it manual re-entry?

---

## Found while building the domain core

### A. Four or more teams tied on points

**The published rules cover two teams and three teams. They do not cover four.**

With ~90 teams across pools this is not hypothetical — a four-way tie at 2
points in a small pool is entirely plausible.

*Current behaviour:* groups of four or more run the three-team ladder (wins →
head-to-head record → runs allowed → capped run differential → coin flip).
Because the ladder recurses, a group of four that splits 1/3 resolves the
remaining three by the three-team rule, and a group that splits 2/2 resolves
each pair by the two-team rule. That is the most faithful reading, but it is an
inference, not a published rule.

*Needs:* a ruling from the director, ideally written into the 2027 PDFs.

### B. Does a forfeit count as a game played, for refund purposes?

§5.8 makes per-team completed-game counts a financial record, and §8A.3 keys
the refund tier off them. A team that forfeited was registered, showed up (or
did not), and occupied a slot.

*Current behaviour:* a forfeit counts as a game played, so a team with one
forfeit and one washed-out game gets the one-game refund tier, not the
zero-game tier.

*Needs:* treasurer + director confirmation. This one moves money.

### C. "All games" vs "all round robin games"

§5.5 step 4 for two teams says fewest runs allowed *"all games"*; step 5 says
run differential *"all round robin games"*.

*Current behaviour:* both are computed over all round robin games. Before
playoffs begin there is no other kind of game, so the two readings only diverge
if a tiebreaker is ever recomputed after Sunday.

*Needs:* confirmation that the distinction is stylistic, not substantive.

### D. "Most points" as the first two-team tiebreaker

§5.5 lists "most points" as step 1 of the two-team ladder, but a tie group is
by definition level on points, so the step can never fire when reached from the
standings.

*Current behaviour:* implemented faithfully and harmlessly. It does fire if
`resolveTieGroup` is called directly with teams that are not level, which is
useful for seeding.

*Needs:* nothing. Noted so nobody "fixes" it later.

### E. The §9 data model contradicts §8 on concessions

§9 sketches `concession_location → stock_count` and `cash_reconciliation`.
§8 says explicitly: build no POS, no inventory tracking, no restock alerts, and
do not impose inventory on volunteers.

*Current behaviour:* §8 wins. The schema has `location` (carrying a
`square_location_id`) and `concession_daily_total` for the optional read-only
Square rollup. There are no stock or cash-reconciliation tables.

*Needs:* confirmation that §8 is the intended scope and §9 is a stale sketch.

### F. Registration: ship for 2027 or defer to 2028?

Spec §12 flags this as the one module with no shadow mode, and recommends
deferring on the 30th anniversary if in doubt.

**This is the single highest-leverage decision in the project** and it gates
Phase 1 entirely. It should be answered at the Phase 0 debrief, not later.

If deferred, the 2027 game-ops modules need coach contact data imported from
the existing system rather than collected natively — which is a different piece
of work that has to be scheduled.

### G. What ends a tie group when a coin flip is required?

The code reports `coinFlips` and refuses to pick a winner. Someone has to
record the outcome.

*Needs:* a decision on where the flip result is stored. Presumably an `event`
row plus a manual override on the bracket slot (§5.6 already requires manual
override on every slot), but it should be explicit.
