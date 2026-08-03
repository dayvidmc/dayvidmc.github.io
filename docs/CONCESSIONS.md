# Concessions: what was built, and the card payment question

## The constraint that shapes everything

**Tapping a card on a phone screen requires a native app.** Apple and Google
expose the NFC reader only to signed native apps holding a specific entitlement
— Tap to Pay on iPhone and Tap to Pay on Android are both native SDK features.
No browser can do it, on any platform, and no amount of web work changes that.

The same is true of a Square or Stripe reader paired over Bluetooth: those live
in native SDKs too.

So there are exactly four routes to taking a card, and it is worth being clear
about what each costs.

| Route | Tap on phone? | Native app to build? | Notes |
|---|---|---|---|
| **Square POS app alone** | Yes | No | Already does item grid, cart, cash, multi-device and per-volunteer permissions. This is what §8 recommended. |
| **This till + hand off to Square** ← built | Yes | No | Our cart, cash, permissions and reconciliation; the card tap happens in the Square app. |
| **Square Terminal API** | No — needs a Terminal | No | Web app drives a physical Square Terminal (~$299/stand). |
| **Native app + Square Mobile Payments SDK** | Yes | Yes | Everything in one app. App store distribution, two codebases, months of work. |

What is built is the second row. The handoff is a Square Point of Sale deep
link, and **it has not been tested against a real Square account** — the code is
written to Square's documented parameters but nobody has run it with a real
reader. Test it before the weekend. The manual "card approved — record this"
button is the fallback and works regardless.

## What this till does that Square does not

This is the honest justification for building anything at all here, since §8's
reasoning against a POS still stands for the card rail.

- **Cash reconciliation across seven volunteer-run stands.** Float in, cash
  taken, refunds out, counted at close, variance reported. Square tracks cash
  tenders but does not model a drawer that a fifteen-year-old opens at noon and
  a different volunteer closes at eight.
- **Concession revenue in the director's dashboard**, live, next to registration
  and auction rather than in a January spreadsheet.
- **Selling with no signal.** Deevy Pines and March Central are parks.
- **One permission model** shared with the rest of the tournament tooling —
  the same tile-and-PIN, no second system to set up.

## Why offline is safe here

Offline sync is usually hard because two devices edit the same thing and you
have to decide who wins. **That problem does not exist here**, and it is worth
understanding why before anyone "improves" this:

A completed sale is an **immutable event**, not shared mutable state. No two
tills ever touch the same order. So there is nothing to merge and no conflict to
resolve — only a delivery problem.

The delivery problem is solved with an idempotency key. The device generates the
order id *before* the sale is finished, and the server inserts with
`ON CONFLICT (id) DO NOTHING`. A retry after a timeout, a double-tap, or a
second tab replaying the queue all land on the same row. The upload response
names exactly which ids are stored, and the till clears only those — anything
unmentioned stays queued and is retried, never dropped on the assumption that it
worked.

**Current limit:** sales are held in `localStorage`, which survives a network
drop but not a browser reload while still offline, because the page itself has
to come from the server. Making the till survive a reload with no signal needs a
service worker. Worth adding before the weekend; the note in the app tells
volunteers not to close the tab in the meantime.

## Money decisions

- **Integer cents everywhere.** No float ever touches a price.
- **Canadian nickel rounding.** Cash settles to the nearest 5¢ (1,2 down · 3,4
  up · 6,7 down · 8,9 up); card is charged to the exact cent. Applying the
  rounding to card too would skim a cent per sale off a charity's takings, in
  the wrong direction about half the time. The rounding applied is stored per
  order so the difference is auditable.
- **Line items copy the name and price at the time of sale.** Repricing a hot
  dog next week must not rewrite last Saturday's receipts.
- **Items are deactivated, never deleted.**
- **Refunds are their own append-only rows**, never edits to the sale. What was
  rung in stays exactly as it was rung in.
- **Cash variance is derived, never stored** — computed from float + cash sales
  − cash refunds every time it is asked for, so it cannot drift away from the
  sales behind it.
- **The expected cash figure is hidden until after counting.** A volunteer who
  can see the target counts until they reach it, which makes the whole exercise
  worthless.

## Permissions

| Role | Sell | Refund | Edit menu | Close drawer |
|---|---|---|---|---|
| Concession volunteer | ✅ | ❌ | ❌ | ❌ |
| Concession lead | ✅ | ✅ | ✅ | ✅ |
| HQ | ✅ | ❌ | ❌ | ❌ |
| Director | ✅ | ✅ | ✅ | ✅ |

Refunds and price edits are the two ways a till leaks, and they are the two
things someone on their first shift should not be able to do by tapping the
wrong button.

## Open questions before this handles real money

1. **Does HST apply?** Prices are treated as the final amount paid, with no tax
   calculated or separated. Whether a registered charity's fundraising sales
   attract HST is an accounting question in the same category as the receipting
   question in §8A.4. Separating tax retrospectively is painful — get an answer
   first.
2. **Does the Square deep link actually work on your devices?** Untested. Needs
   a Square developer application id and a real reader.
3. **Is this worth running at all**, given Square's own app already covers the
   card path and has its own permissions? The cash reconciliation and the live
   revenue rollup are the real wins. If those do not matter to the committee,
   §8's original advice — use Square, build nothing — is still the cheaper
   answer.
4. **Float amounts and who counts.** The till assumes a lead opens and closes.
   Confirm that matches how the stands are actually staffed.
