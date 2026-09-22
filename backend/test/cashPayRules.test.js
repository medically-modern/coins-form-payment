// Run: npm test  (node --test, no dependency added)
//
// ⚠️ These are the FIRST tests in this repo. CLAUDE.md §4 records that
// `npm run build` is the entire gate here and that a logic mistake ships — and
// the cash pay rules decide whether a patient is charged and for how much, so
// they are where that stops being acceptable. Everything under test is pure.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isCashPayOrder, mintRefusal, lineRefusal, money, paymentLinkPayload, etDateString,
} = require("../src/cashPay/rules");
const { LIMITS } = require("../src/cashPay/config");

const cashOrder = (over = {}) => ({
  itemId: "12848746815", name: "Debbie Hinze",
  primaryInsurance: "Cash Pay",
  stripeChargeId: "", cashPayPaidDate: "", cahOrderNumber: "",
  ...over,
});

/* Debbie Hinze's real order, as the Command Center prices it: 3 x t:slim at
   $116.06, 3 x AutoSoft XC at $269.78, 9 x Dexcom G7 at $644.85 — except the
   Command Center sends ONE line per product at the line price with quantity 1,
   so these are its `cashPayLineItems()` output shape. */
const debbieLines = [
  { label: "Dexcom G7 (CGM sensors)", quantity: 1, amountCents: 64485 },
  { label: "t:slim (Cartridges)", quantity: 1, amountCents: 11606 },
  { label: 'AutoSoft XC 9 mm 43" (Infusion sets)', quantity: 1, amountCents: 26978 },
];
const DEBBIE_TOTAL = 64485 + 11606 + 26978; // 103069 — $1,030.69

test("isCashPayOrder is an exact match, never a substring", () => {
  assert.equal(isCashPayOrder("Cash Pay"), true);
  assert.equal(isCashPayOrder("  cash pay  "), true);
  /* A future "Cash Pay Plan" must not silently become a cash pay order —
     the same call the Command Center's shared rule makes. */
  assert.equal(isCashPayOrder("Cash Pay Plan"), false);
  assert.equal(isCashPayOrder("Aetna Commercial"), false);
  assert.equal(isCashPayOrder(""), false);
  assert.equal(isCashPayOrder(undefined), false);
});

test("a cash pay order with nothing paid may be minted", () => {
  assert.equal(mintRefusal(cashOrder()), "");
});

test("⚠️ an already-paid order is refused — either payment column alone", () => {
  assert.match(mintRefusal(cashOrder({ stripeChargeId: "pi_3abc" })), /already been paid/);
  assert.match(mintRefusal(cashOrder({ cashPayPaidDate: "2026-08-19" })), /already been paid/);
});

test("⚠️ an order Cardinal has already taken is refused by its CAH number", () => {
  /* Debbie's historical order sits at Order Status "Paid Cash" while the order
     is Delivered. The CAH number is positive evidence it has been placed,
     where the status label is ambiguous. */
  assert.match(mintRefusal(cashOrder({ cahOrderNumber: "1120157406" })), /already been placed/);
});

test("an insured order is refused, and a missing one says so", () => {
  assert.match(mintRefusal(cashOrder({ primaryInsurance: "Aetna Commercial" })), /not Cash Pay/);
  assert.match(mintRefusal(null), /not on the board/);
});

test("Debbie's real quote passes", () => {
  assert.equal(lineRefusal(debbieLines, DEBBIE_TOTAL), "");
  assert.equal(money(DEBBIE_TOTAL), "$1,030.69");
});

test("⚠️ the lines must ADD UP to the stated total", () => {
  /* Stripe charges the sum of what it is handed, so a total computed a second
     way can differ by a cent from the lines printed above it. A disagreement
     is a refusal, never a silent preference for one of the two. */
  const r = lineRefusal(debbieLines, DEBBIE_TOTAL + 1);
  assert.match(r, /come to \$1,030\.69 but the total says \$1,030\.70/);
});

test("⚠️ the sum respects quantity, not just the unit amount", () => {
  const lines = [{ label: "Sensors", quantity: 3, amountCents: 1000 }];
  assert.equal(lineRefusal(lines, 3000), "");
  assert.match(lineRefusal(lines, 1000), /come to \$30\.00 but the total says \$10\.00/);
});

test("⚠️ amounts are whole cents, checked as integers", () => {
  /* A float is a rounding rule arriving from somewhere this service cannot
     see, and Stripe takes integers regardless — 269.775 would charge 269 or
     270 with nothing saying which. */
  assert.match(lineRefusal([{ label: "x", quantity: 1, amountCents: 269.775 }], 269.775), /invalid amount/);
  assert.match(lineRefusal([{ label: "x", quantity: 1, amountCents: 0 }], 0), /invalid amount/);
  assert.match(lineRefusal([{ label: "x", quantity: 1, amountCents: -500 }], -500), /invalid amount/);
});

test("quantities are positive integers, and labels are required", () => {
  assert.match(lineRefusal([{ label: "x", quantity: 0, amountCents: 100 }], 0), /invalid quantity/);
  assert.match(lineRefusal([{ label: "x", quantity: 1.5, amountCents: 100 }], 150), /invalid quantity/);
  assert.match(lineRefusal([{ label: "   ", quantity: 1, amountCents: 100 }], 100), /no label/);
});

test("an empty or oversized set of lines is refused", () => {
  assert.match(lineRefusal([], 0), /No line items/);
  assert.match(lineRefusal(null, 0), /No line items/);
  const many = Array.from({ length: LIMITS.MAX_LINES + 1 },
    () => ({ label: "x", quantity: 1, amountCents: 100 }));
  assert.match(lineRefusal(many, many.length * 100), /Too many line items/);
});

test("⚠️ the sanity ceiling catches a misplaced decimal", () => {
  /* Wide on purpose — it exists to catch a bug, not to second-guess a quote.
     The largest real cash pay order to date is $1,030.69. */
  const huge = [{ label: "x", quantity: 1, amountCents: LIMITS.MAX_TOTAL_CENTS + 1 }];
  assert.match(lineRefusal(huge, LIMITS.MAX_TOTAL_CENTS + 1), /over the .* ceiling/);
  const tiny = [{ label: "x", quantity: 1, amountCents: 1 }];
  assert.match(lineRefusal(tiny, 1), /below the minimum/);
  /* and Debbie's real order is comfortably inside both */
  assert.equal(lineRefusal(debbieLines, DEBBIE_TOTAL), "");
});

test("⚠️ the payload carries the metadata the webhook branches on", () => {
  const p = paymentLinkPayload({ itemId: "12848746815", patientName: "Debbie Hinze", lines: debbieLines });
  /* Stripe copies a Payment Link's metadata onto every Checkout Session it
     creates — this is the only thing that lets `checkout.session.completed`
     find the order, and `service` is what keeps it out of pay-secondary. */
  assert.equal(p.metadata.service, "cash-pay");
  assert.equal(p.metadata.itemId, "12848746815");
  assert.equal(p.payment_intent_data.metadata.service, "cash-pay");
});

test("⚠️ the payload sets NO statement_descriptor", () => {
  /* Stripe: `payment_intent_data.statement_descriptor` is for a non-card
     charge and "setting this value for a card charge returns an error".
     Nearly every patient pays by card, so copying pay-secondary's Checkout
     Session field here would error on the one thing that matters. */
  const p = paymentLinkPayload({ itemId: "1", patientName: "X", lines: debbieLines });
  assert.equal("statement_descriptor" in p.payment_intent_data, false);
});

test("⚠️ the link is SINGLE USE", () => {
  /* Without it a patient who taps the text twice pays twice, and the second
     charge is refunded by hand. */
  const p = paymentLinkPayload({ itemId: "1", patientName: "X", lines: debbieLines });
  assert.equal(p.restrictions.completed_sessions.limit, 1);
});

test("the payload's line items are inline prices in whole cents", () => {
  const p = paymentLinkPayload({ itemId: "1", patientName: "X", lines: debbieLines });
  assert.equal(p.line_items.length, 3);
  assert.equal(p.line_items[0].price_data.unit_amount, 64485);
  assert.equal(p.line_items[0].price_data.currency, "usd");
  assert.equal(p.line_items[0].price_data.product_data.name, "Dexcom G7 (CGM sensors)");
  const sum = p.line_items.reduce((s, l) => s + l.price_data.unit_amount * l.quantity, 0);
  assert.equal(sum, DEBBIE_TOTAL);
});

test("⚠️ etDateString is EASTERN, not UTC", () => {
  /* A payment taken at 9pm ET is still that day on these boards. Read as UTC
     it would be stamped tomorrow. */
  assert.equal(etDateString(new Date("2026-09-23T01:30:00Z")), "2026-09-22");
  assert.equal(etDateString(new Date("2026-09-22T16:00:00Z")), "2026-09-22");
  // and across the DST boundary, where a fixed offset would be wrong
  assert.equal(etDateString(new Date("2026-01-15T04:30:00Z")), "2026-01-14");
});
