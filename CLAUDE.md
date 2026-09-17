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

Treat every change to the amount shown, the amount charged, or the receipt as higher-stakes than
the code size suggests, and remember there is **no test suite here at all** (§4).

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

## 3. The board

**Secondary Claims Board `18413019028`**, group **`group_mm3ba7x1`** ("Send Invoice"). Parent
columns are the patient, the claim and the payment; **subitems are the ERA line items**
(`SUBITEM_COLUMNS` — HCPC, modifiers, coinsurance, deductible, PR, copay). All IDs are in
`backend/src/config.js`, which is the contract.

⚠️ **`backend/.env.example` is WRONG about the board.** Its first comment says the Monday token is
for "Subscription Board 18407459988" — that is the *reorder* repo's board. This app reads and
writes the Secondary Claims board above. The comment is stale; the code is right.

Two Monday webhooks drive it: `POST /webhook/monday` (mint a pay link) and
`POST /webhook/monday/send-text` (text it). Token TTL is **30 days**, JWT session 24h.

---

## 4. ⚠️ There is NO test suite, NO linter and NO typecheck script

`package.json` has exactly `dev`, `build`, `preview`. So:

- **`npm run build` is the entire gate.** It will catch a type error or a syntax error and nothing
  else. A logic mistake ships.
- There is no equivalent of the 3,600-test suite that protects `command-center-test`. Verify
  behaviour by hand, and be correspondingly conservative — especially around §1.

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
