# CLAUDE.md — coins-form-payment

The **patient coinsurance payment form** for **Medically Modern**, a diabetes-supplies / DME
provider. After a secondary claim adjudicates, the patient still owes a balance; this sends them a
link, shows the line items behind it, and **takes the payment through Stripe**.

**Monday is the database.** Redis holds tokens, sessions and the SMS queue only.

Everything here was read from this repo's own source. Re-verify against the code before trusting a
detail; nothing below is from memory.

---

## 1. ⚠️ This app takes real money

`POST /api/create-checkout-session` creates a Stripe Checkout session and `POST /webhook/stripe`
records the result on the patient's Monday item (`PATIENT_PAID_AMOUNT`, `PATIENT_PAID_DATE`,
`STRIPE_CHARGE_ID`). `GET /api/receipt` then renders a receipt PDF carrying the company's **NPI
and Tax ID** (`COMPANY` in `backend/src/config.js`).

**There are now TWO money paths, on two boards** — the coinsurance one above, and **cash pay**
(`backend/src/cashPay/`, §8), which mints a Stripe **Payment Link** for a patient with no
insurance and records the payment on the **New Order Board**. They share this service and the
Stripe account and nothing else; the Stripe webhook branches on `metadata.service`.

Treat every change to the amount shown, the amount charged, or the receipt as higher-stakes than
the code size suggests, and see §4 on what does and does not gate a change here.

---

## 2. Two halves, two hosts

| | Frontend | Backend |
|---|---|---|
| lives in | `src/` (+ `index.html`) | `backend/` |
| stack | Vite 5 + React 18 + TypeScript + Tailwind | Node + Express |
| served from | **GitHub Pages** at `invoice.medicallymodern.com` (`CNAME`) | **Railway**, `coins-form-payment-production.up.railway.app` |
| deployed by | `.github/workflows/deploy.yml` — builds and publishes `dist/` on every push to `main` | Railway |

`dist/` is **gitignored** — the workflow builds it fresh on every push, so what patients get is
always built from `src/`. A `dist/` in your working tree is your own local build and is not
tracked; don't hand-edit it expecting a change to ship.

The frontend reads `VITE_API_URL`, defaulting to the Railway URL above (`src/App.tsx`).

---

## 3. The boards

**TWO, and no file may reach both.** The coinsurance flow reads and writes **Secondary Claims
`18413019028`** through `backend/src/config.js` + `backend/src/monday.js`; the cash pay flow reads
and writes **New Order `18405457690`** through `backend/src/cashPay/config.js` +
`backend/src/cashPay/monday.js` (§8). The split is deliberate: `monday.js` hardcodes
`SECONDARY_BOARD_ID` into every write, which is right for what it does, and parameterising it
would put the order board one typo away from every coinsurance write.

⚠️ **A cross-board write is the live hazard here, not a theoretical one.** `smsQueue.enqueueSMS`
and `processQueue` write the Secondary board's SMS Status and Pay Link Sent Date using whatever
`itemId` they are handed — fed an order-board id they write the wrong board, and if an item with
that id happens to exist there they stamp a stranger's record. `cashPay/index.js` records this at
the point somebody would reach for it.

### Secondary Claims `18413019028`

Group **`group_mm3ba7x1`** ("Send Invoice"). Parent
columns are the patient, the claim and the payment; **subitems are the ERA line items**
(`SUBITEM_COLUMNS` — HCPC, modifiers, coinsurance, deductible, PR, copay). All IDs are in
`backend/src/config.js`, which is the contract.

✅ **`backend/.env.example`'s board comment was wrong and is fixed** (2026-09-22). It used to say
the Monday token was for "Subscription Board 18407459988" — a different repo's board entirely. It
now names both boards this service actually touches.

Two Monday webhooks drive it: `POST /webhook/monday` (mint a pay link) and
`POST /webhook/monday/send-text` (text it). Token TTL is **30 days**, JWT session 24h.

---

## 4. ⚠️ There is NO linter and NO typecheck script, and the tests cover ONE slice

`npm test` (`node --test`, no dependency added) runs **`backend/test/*.test.js`**, which today is
**the cash pay rules and nothing else** — the amounts, the refusals, the Stripe payload. It exists
because that slice decides whether a patient is charged and for how much (§8).

Everywhere else:

- **`npm run build` is still the entire gate.** It will catch a type error or a syntax error and
  nothing else. A logic mistake in the coinsurance path, the receipt, the SMS queue or the auth
  layer ships.
- There is no equivalent of the 4,400-test suite that protects `command-center-test`. Verify
  behaviour by hand, and be correspondingly conservative — especially around §1.
- ⚠️ Adding a test is cheap now: drop a `backend/test/<thing>.test.js` in, no new dependency. The
  reason the cash pay slice has them and the rest does not is that it was written after this
  paragraph, not that the rest is safer.

---

## 5. ⚠️ `src/components/OopEstimateCard.tsx` is DEAD CODE — but `src/lib/oopEstimator.ts` is still checked

Verified 2026-09-17: **nothing imports `OopEstimateCard`**, and its text is absent from the built
bundle (`dist/`), so Vite tree-shakes it out. It renders for nobody. `src/lib/oopEstimator.ts` is
reachable only through that dead component, so **the estimator in this repo currently affects no
patient-facing number**. Don't assume a bug there is live; equally, don't assume the file is
therefore free to drift, because:

**`src/lib/oopEstimator.ts` is a registered consumer of the org's canonical payer policy.**

- **Canonical:** `medically-modern/command-center-test` → `src/lib/shared/payerPolicy.json`
  (rate schedule, zero-OOP payers, coinsurance overrides, the Medicaid / Medicare-style /
  Aetna-style sets).
- **The check:** that repo's `scripts/check-payer-policy.mjs` reads **this file** and fails when it
  disagrees — on its CI, and on a weekday cron at 13:10 UTC.
- **The other copies:** command-center-test's `welcomeCall/oopEstimator.ts` and
  `profile/oopEstimate.ts`, and both copies in `reorder-patient-form` (`backend/src/` and `docs/`).

So a payer changed here and not there turns another repo's CI red, and vice versa. A **deliberate**
difference goes in that JSON under this consumer's `deviations` with a reason. As of 2026-09-17 this
copy has none — it matches canonical exactly.

⚠️ This repo had drifted furthest of the four: its zero-OOP set held **only** Medicare A&B, so
NYSHIP, Aetna Medicare and United Medicare were all run through the full deductible + coinsurance
path. Fixed 2026-09-17. If the card is ever mounted, that is the difference between quoting a
United Medicare CGM fill at **$105.93** and at **$0**.

⚠️ **The Python originals are checked by NOBODY.** `claim_assumptions.py` and `insurance_rules.py`
in `medicallymodern1/stedi-monday-integration` (a **different GitHub org**, FastAPI on Render) are
what this file's header cites as its source. Nothing can read them from this org. Sync by hand and
say so.

⚠️ The file header still says *"Out-of-Pocket Estimator for the Welcome Call page"* — it was ported
from command-center and the wording was never updated. There is no Welcome Call page here.

---

## 6. Conventions & gotchas

- **Push to `main`.** No feature branches or PRs unless asked.
- **PHI is everywhere**, plus payment data. Don't put either in logs, commits or artifacts.
- ⚠️ **Monday returns HTTP 200 with an `errors[]` body on a rejected write.** Nothing throws. Read
  `errors[]` or a failed write reports success.
- ⚠️ **Status columns are written by INDEX**, and Monday assigns those indexes itself (lowest free
  slot at label-creation time, not display order). A write to an index the column does not have is
  accepted at **200 and dropped**, silently. Read them off the live board; never infer one.
- ⚠️ **The Stripe webhook must stay above `express.json()`** in `backend/src/index.js` — it needs
  the raw body (`express.raw`) to verify the signature. It is mounted first on purpose; moving it
  below the JSON parser breaks signature verification.
- **This repo is PUBLIC.** No secrets, no keys, no tokens in the tree.

---

## 7. Where to look first

| Task | Start here |
|---|---|
| The amount charged is wrong | `src/App.tsx` (display) → `backend/src/index.js` `/api/create-checkout-session` → the board's subitem ERA columns |
| A payment didn't record on Monday | `POST /webhook/stripe` in `backend/src/index.js`, and §6 on the raw-body ordering |
| A patient can't open their link | `backend/src/auth.js`; token TTL is 30 days, JWT 24h |
| The receipt is wrong | `GET /api/receipt`, and `COMPANY` in `backend/src/config.js` |
| A payer is $0 on one screen and charged on another | §5. Run command-center-test's `node scripts/check-payer-policy.mjs` |
| "The OOP card is broken" | §5 — it is not mounted and not in the bundle; it renders for nobody |
| A link/text didn't go out | the two `POST /webhook/monday*` routes, then `backend/src/smsQueue.js` |
| A cash pay link wasn't minted / the button said no | §8 — `backend/src/cashPay/rules.js` `mintRefusal` (the order's state) and `lineRefusal` (the amount). A **503** means `CASH_PAY_SERVICE_TOKEN` is unset, which disables the route on purpose |
| A cash payment didn't record on Monday | §8 — the `metadata.service === "cash-pay"` branch in `/webhook/stripe`, then `cashPay/monday.js` `recordCashPayment`. It returns 500 so Stripe retries; check the logs for `[cash-pay]` |
| "Why is the cash pay link a Payment Link and not a Checkout Session?" | §8 — a Checkout Session expires in at most 24 hours and the link is texted and chased for a fortnight. Do not align the two flows |
| A card payment errors at Stripe on the cash pay link | §8 — check nothing has added `payment_intent_data.statement_descriptor`; Stripe rejects it for card charges. Pinned by a test |
| Something wrote the wrong board | §3 — `smsQueue` is bound to Secondary Claims and takes any itemId. Cash pay has its own client for exactly this reason |

---

## 8. Cash pay — a patient with no insurance, paying for one order

`backend/src/cashPay/` — **config.js** (the New Order Board's ids), **rules.js** (pure, tested),
**monday.js** (that board's reads and writes), **index.js** (the route and the webhook branch).
Mounted from `backend/src/index.js` in two places and touching nothing else.

The Command Center prices the order from Cardinal's costs, presses Generate, and this mints the
link. When the patient pays, Stripe's webhook records it and flips **Order Status → Paid Cash**,
which is what lets that order be placed with Cardinal at all. The whole path — intake, pricing,
the ordering gate, the card — is `command-center-test`'s CLAUDE.md §5.48.

### ⚠️⚠️ A Stripe PAYMENT LINK, not a Checkout Session

Verified against Stripe's API reference, 2026-09-22. A Checkout Session's `expires_at` *"can be
anywhere from 30 minutes to 24 hours after Checkout Session creation. By default, this value is 24
hours from creation"* — and cannot be set longer. A session URL texted to a patient is dead by the
next morning, and the reminder loop would spend a fortnight chasing a link nobody can pay.

A **Payment Link has no expiry at all**. It takes inline `line_items[].price_data`, it is retired
with `active: false` + `inactive_message` rather than deleted, and — the part the webhook depends
on — **Stripe copies a Payment Link's `metadata` onto every Checkout Session it creates**, so
`checkout.session.completed` arrives carrying `itemId` and `service`.

⚠️ **The coinsurance flow's Checkout Session is CORRECT and must not be "aligned" with this.**
There the patient is already on the page when it is minted, so 24 hours is ample.

### ⚠️⚠️ No `statement_descriptor` on the payment link

Stripe, on `payment_intent_data.statement_descriptor`: it is for a *non-card* charge, and
*"setting this value for a card charge returns an error"* — for cards the field is
`statement_descriptor_suffix`, concatenated onto the account's prefix inside a 22-character total.
Nearly every patient pays by card, so copying the coinsurance session's `statement_descriptor`
into a Payment Link would error on the one thing that matters. The account default applies. Pinned
by a test.

### The route

`POST /api/cash-pay/create-link` — `{ itemId, lines[], totalCents, regenerate? }`.

- ⚠️ **Service auth, not `requireAuth`.** That is the PATIENT's JWT, minted from a pay link; the
  caller here is the Command Center, which has no patient session and must not be given one.
  `CASH_PAY_SERVICE_TOKEN` is a shared bearer in the Railway environment, and **unset disables the
  route (503) rather than leaving it open** — an endpoint that mints Stripe links must never be
  reachable because somebody forgot to configure it.
- ⚠️ **Mounted after `express.json()` AND after `app.use(globalLimiter)`**, with a tighter limiter
  of its own. `register()` throws without one rather than mounting unthrottled.
- ⚠️ **THE CALLER SUPPLIES THE PRICE, deliberately.** The Command Center owns the pricing rule
  (Cardinal's cost x1.25, rounded per line, plus a $10 floor under $10 of markup) and this service
  does not re-implement it: a second copy of a money rule in a second repo is the hand-synced
  hazard, and its drift would be a patient charged an amount no screen ever showed. What this
  service owes instead is the ORDER's own state (`mintRefusal` — cash pay, unpaid, not already
  with Cardinal) and a sanity boundary on the number (`lineRefusal`).
- ⚠️ **The lines must ADD UP to the stated total.** Stripe charges the sum of what it is handed, so
  a total computed a second way can differ by a cent from the lines printed above it. A
  disagreement is a refusal, never a silent preference for one.
- ⚠️ **Idempotent by default.** An order that already has a link returns it; `regenerate: true` is
  the explicit way to replace one. Two live links for one order means the patient holds two, and
  paying the older one charges last week's price.
- ⚠️ **Single use** (`restrictions.completed_sessions.limit = 1`) — without it a patient who taps
  the text twice pays twice, and the second charge is refunded by hand.

### The webhook branch

In `backend/src/index.js`'s existing `/webhook/stripe`, first thing inside
`checkout.session.completed`: `metadata.service === "cash-pay"` → `cashPay.handleStripeSession`,
then **return**. The two branches must never both run on one session — one writes the New Order
Board, the other Secondary Claims, each with an item id that means nothing on the other.

⚠️ A failure returns **500 so Stripe retries**. A payment taken and not recorded is the worst state
this service has: the ordering gate then holds an order the patient has already paid for.

⚠️ **`recordCashPayment` writes the STATUS LAST** — Order Status → Paid Cash is what opens that
gate, so writing it before the charge id would open it against an order whose payment columns are
still empty.

### The text is the BOARD's job

The handoff says to reuse the monday texting automation, and the order board is where it belongs
(the Command Center's Send press is dark waiting on exactly that column and automation). There is
deliberately no text route here, and `cashPay/index.js` records the cross-board trap at the point
somebody would reach for `enqueueSMS`. `cashPayText()` is exported unused so the wording has one
home and whoever builds the automation has the exact string.

### ⚠️⚠️ The LIVE route is the monday webhook, not `/api/cash-pay/create-link`

`POST /webhook/monday/cash-pay` — the same shape the coinsurance flow has used for a year, and
Josh's explicit choice (2026-09-22: *"do that route, it works perfectly fine dont mess it up"*).
A rep presses **Generate** in the Command Center; the app writes **Cash Pay Amount**
`numeric_mm7devxs` and then flips **Cash Pay Action** `color_mm7e3rxj` to *Generate link*; a board
automation turns that into this request; this mints and writes **Cash Pay Link** `text_mm7dzgzd`
back. **No browser ever holds a token — the board is the trigger.**

⚠️ **Cash Pay Action's label ids are 0 / 3 / 2**, not 0 / 1 / 2 — monday derives a new label's id
from its COLOUR, never from the index asked for. Read back from the live `settings_str` the day the
column was created (2026-09-22) and pinned by a test. A write to an id the column does not have is
accepted at 200 and **dropped silently**, which here would look exactly like the feature failing.

⚠️⚠️ **THE AMOUNT COMES OFF THE ROW, AND THAT IS THE WHOLE COST OF THIS ROUTE.** A monday webhook
carries an item id and a status label — no line items — so the only price this service can see is
the one number the Command Center wrote. **The Stripe page therefore shows ONE line**
(`CASH_PAY_LINE_LABEL`, which names the goods and carries no figure) rather than the three products
the rep quoted. Rebuilding those lines here would mean re-implementing the pricing rule against the
board's product columns: the second copy of a money rule this whole design exists to avoid. The
itemisation lives where it is computed — the Command Center card the rep reads from.
`centsFromAmountText` parses the digits and **never multiplies a float by 100** (the Command
Center's own note records that costing a cent on a real order), and an unreadable amount is
**null, never 0** — zero is a price, "we could not read the price" is not.

⚠️ **`CASH_PAY_WEBHOOK_SECRET`, deliberately NOT `MONDAY_WEBHOOK_SECRET`.** That variable is
**unset** on this service, so the coinsurance webhook's own check is inert — and monday's
"send a webhook" automation sends no `authorization` header, so **setting it would start 401-ing
the live pay-secondary flow.** Sharing the name would make turning auth on here break something
else silently. Unset disables this route (503), as `CASH_PAY_SERVICE_TOKEN` does. Accepted from the
`authorization` header **or** `?key=`, because a board automation may not let you set a header; the
query form is the one that certainly works, the header is preferable where monday offers it.

⚠️ **The challenge handshake is answered BEFORE the secret check.** Monday posts it when the URL is
saved, before anything is configured on their side; checking first makes the webhook unsaveable.

⚠️ **The label guard is what stops a "Send to patient" press minting a second link.** The
automation should fire on a change *to* "Generate link" and nothing else, but automations get
rebuilt, and an endpoint that mints a payment link must not rest on somebody else's radio button.
An unreadable label reads as *not the trigger* and skips.

⚠️ **A live link is returned, never replaced.** Two live links means the patient holds two, and
paying the older one charges last week's price. Replacing one is a deliberate, visible act: clear
the Cash Pay Link cell on the board, then press Generate again. Nothing is re-written to the row on
that path — writing the current amount back would leave the board stating a price the existing link
does not charge.

⚠️ **It answers 200 once it has decided the request is ours, and writes the refusal to the BOARD**
(*Link failed*). Monday retries a non-2xx and eventually stops delivering; a refusal is a fact
about the order, not a broken endpoint — and the rep's only other signal is a link that never
appears. The trigger is **cleared last**, after the link is on the board: clearing re-arms the
button (monday takes a status write onto its own value at 200 and fires nothing, so a column parked
on *Generate link* makes every later press a silent no-op), and clearing early invites a second
press that mints a second link.

`/api/cash-pay/create-link` **stays**: it is correct, tested, and takes the itemised lines this
route cannot. It is not what the board calls.

### Not built

The **15-day reminder loop** and a **branded cash-pay page** on the frontend. The reminder is a
date-arrival automation on the order board (the same shape the Command Center's MR ladder uses);
the patient currently lands on Stripe's own hosted confirmation, which is why `after_completion`
sets a custom message rather than redirecting to a page that does not exist.
