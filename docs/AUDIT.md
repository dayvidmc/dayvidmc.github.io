# What was tested, what was wrong, and what is still open

A pass over the whole platform asking three questions: what should work and
does not, what works that should not, and what a person can reach who should
not be able to reach it.

Everything below was found by running it, not by reading it. The harness is
`.verify-authz.mjs` in the working tree — it is not committed, because it
harvests live action ids from a running build, but the checks it performs are
described precisely enough here to rebuild.

---

## How the authorization test works, and why the first version was worthless

A Next.js server action is a POST to the page's own URL carrying a hidden
`$ACTION_ID_<hash>` field. That id sits in the HTML of any page that renders the
form, it is stable for the life of a build, and none of it is secret. So the
question a page guard answers — "can you open this screen" — is the easy half.
The real question is what happens when somebody who saw the button once sends
the request again tomorrow, signed in as somebody else or not at all.

The harness signs in as the director, walks 42 screens, harvests every form,
and replays all **60 distinct actions**:

| Replayed as | Result |
|---|---|
| Nobody (no cookie) | 60/60 redirect to sign-in, nothing written |
| Concession volunteer | nothing written |
| Auction lead | nothing written |
| Volunteer coordinator | wrote only to volunteer tables — their own remit |
| HQ desk | wrote widely, but nothing director-only |
| **Director (the control)** | **wrote — which is what makes the five rows above mean anything** |

**The control is the important row.** The first version of this harness posted
`application/x-www-form-urlencoded` with no `Origin` header. Next rejected every
request before it reached a single guard, so every role "changed nothing", the
audit was entirely green, and it proved precisely nothing. Three details had to
be right — the forms are `multipart/form-data`, Next verifies `Origin` against
`Host`, and the action id is a field name rather than a header — and getting any
of them wrong looks exactly like a guard working.

That is the third time in this repository a check written so it could not fail
has passed while hiding the thing it was written for.

---

## Things that worked and should not have

### A staffed volunteer shift could be deleted, taking people's commitments with it

The shifts screen showed its Remove button only when nobody was assigned. The
action checked nothing. Replaying the form deleted a shift somebody had agreed
to work; the assignments went with it on the foreign key, silently, with no
event recorded — so a volunteer stopped being on the rota and nothing anywhere
said why.

**Fixed.** `deleteShift` refuses a staffed shift and says so, and the deletion
of an empty one is now recorded like every other change.

### The Gold Glove could be drawn twice

The draw record is append-only and the screen hides the button once a draw
exists. Neither of those stops a *second draw*. A double-tap on a bad
connection, a stale tab left open, or a replayed post appended a second winner
— and a tournament with one trophy then has two names in its own record with
nothing saying which is real. For an award that is the emotional centre of the
weekend and is chosen by random draw precisely so it is above argument, that is
the worst kind of quiet bug.

**Fixed.** A second draw needs a written reason, kept beside it. Not forbidden —
a winner really can decline — but no longer possible by accident.

### A signed-out stranger was told "not allowed" rather than "sign in"

Four concession actions redirected anonymous callers to a screen they also
could not open, with an error implying they had signed in as the wrong person.
Nothing leaked; it just made the system feel arbitrary at the moment somebody
was already confused. **Fixed.**

---

## Things that should have worked and did not

### Recording a coin flip

The public standings page has always ended an unbreakable tie with *"the order
shown is provisional until a director flips a coin and records the result."*
The engine reported the state, the `coin_flip` table had waited since the first
migration, and **there was nowhere to record one.** A sentence written for a
parent reading a table on Sunday morning was a promise the software could not
keep — about the placement that decides who plays that afternoon.

**Built.** `/hq/standings` lists every unsettled tie and records the order.
Director-only, re-recordable, and it appears on the board beside the unmatched
texts so nobody has to go looking.

---

## Confirmed working, and worth knowing why

- **Money cannot be double-counted.** `markReimbursed` carries
  `AND reimbursed_at IS NULL`; `refundOrder` locks the order and checks what
  remains. Both are idempotent at the database, not in the screen.
- **Magic links are the credential, and that is deliberate.** Posting a team's
  token writes to that team, wherever the form was loaded from. Holding the
  token *is* the permission — that is the whole design of a link a coach
  forwards to parents. An invented token 404s.
- **The API endpoints are shut.** The drain endpoint refuses a missing or wrong
  `SENDER_TOKEN` with a 401. The SMS webhook refuses an unsigned POST with a
  403.
- **`/setup` cannot be used to seed over real data.** It needs `DEMO_MODE`, it
  refuses when a tournament exists, and the PIN table it can show is gated on
  the same flag.
- **No public page leaks a PIN, a mobile number or anything token-shaped.**
  Checked on the home page, schedule, results, sponsors, contact and setup.

---

## Still open, in the order they matter

1. **Both message channels are dry runs.** SMS needs a number bought; email
   needs a verified sending domain, which needs SPF and DKIM on a domain whose
   administrator is still an open question in `ANSWERS.md`. Until then "sent"
   on screen means "written to a log file" — and for entries specifically, a
   coach who never receives their reference cannot pay.
2. **Nothing starts the score conversation.** `gamesNeedingNudge()` is built and
   called by nothing. The primary score path in the spec begins with a text the
   system sends, and it never sends it.
3. **The SMS webhook is not idempotent.** Twilio retries a webhook that times
   out; a retry creates a second `score_report`, and that table is append-only
   so the duplicate cannot be cleaned up. Store the `MessageSid` with a unique
   constraint. Ten lines, and much more expensive after the weekend than before.
4. **A list of ninety has no way to find one.** Teams filter by division;
   umpires, volunteers and entries have no filter at all.
5. **There is no bracket builder.** The map, the seeding and the propagation all
   work; creating the structure is done by the demo seed and by nothing else.
6. **`/setup` stays readable after setup.** It has to be reachable before
   anyone can sign in, which is its whole purpose, so it cannot simply be put
   behind the sign-in — but once a tournament exists it shows its name, dates
   and migration count to anybody. Low severity, and worth closing by requiring
   a session once `DEMO_MODE` is off and a tournament exists.

---

## What this pass does not cover

- **Load.** Nothing here says what happens when eighty games finish at once on
  Saturday evening (§11). That needs a load test against a real deployment.
- **The payment providers.** Both are in dry run, so the webhook paths that
  matter with real money have been exercised against a fake.
- **A real browser matrix.** Everything was Chromium. Safari on an old iPhone is
  the device this is actually used on and has never been tried.
