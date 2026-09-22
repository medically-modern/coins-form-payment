// ─── Cash Pay: the New Order Board, and what this flow touches on it ───
//
// ⚠️ A DIFFERENT BOARD from the rest of this repo. Everything else here reads
// and writes the Secondary Claims Board (`../config.js`); cash pay is an ORDER
// being paid for up front, so it lives on the **New Order Board**. That is why
// this flow has its own config, its own board-parameterised writes
// (`./monday.js`) and its own routes — nothing in the pay-secondary path
// changes, and neither board's column map can be reached by the other's code.
//
// Column ids and label ids below were read off the LIVE board on 2026-09-22.
// The Command Center's own map is `src/lib/orders/mondayApi.ts` COL in
// medically-modern/command-center-test; the two must agree.

const ORDER_BOARD_ID = "18405457690";

const ORDER_COLUMNS = {
  ORDER_STATUS:       "status",              // Order Status
  PRIMARY_INSURANCE:  "color_mm18jhq5",      // Primary Insurance
  PRIMARY_PHONE:      "phone_mm18rr9v",      // Primary Phone
  CAH_ORDER_NUMBER:   "text_mm3z47x2",       // CAH Order Number (Cardinal writes it)
  NOTES:              "long_text_mm60y0ap",  // Notes

  // The five cash pay columns, added 2026-09-21.
  CASH_PAY_LINK:      "text_mm7dzgzd",       // Cash Pay Link
  CASH_PAY_AMOUNT:    "numeric_mm7devxs",    // Cash Pay Amount
  CASH_PAY_LINK_SENT: "date_mm7d7wxe",       // Cash Pay Link Sent
  CASH_PAY_PAID_DATE: "date_mm7dejzt",       // Cash Pay Paid Date
  STRIPE_CHARGE_ID:   "text_mm7dkma5",       // Stripe Charge ID

  // The trigger column, added 2026-09-22. The Command Center flips it; a board
  // automation turns that into the webhook below. See CASH_PAY_ACTION_INDEX.
  CASH_PAY_ACTION:    "color_mm7e3rxj",      // Cash Pay Action
};

// ⚠️ Status columns are written by label INDEX, and monday assigns those
// itself — lowest free slot at label-creation time, never display order. A
// write to an index the column does not have is accepted at 200 and DROPPED,
// silently. Both of these were read back from `settings_str` on 2026-09-22.
//
// ⚠️ `PAID_CASH` and `CASH_PAY_PAYER` are 6 and 152 on THIS board and mean
// nothing on any other. The Command Center's `CASH_PAY_LABEL_ID` carries one
// id per board for the same reason.
const ORDER_STATUS_INDEX = {
  ORDER: 0,
  ORDERED: 1,
  PAID_CASH: 6,
};
const CASH_PAY_PAYER_INDEX = 152;

// ⚠️ Read back from the live `settings_str` on 2026-09-22, the day the column
// was created. Monday derives a new label's id from its COLOUR, not from the
// index asked for, so these are 0 / 3 / 2 rather than 0 / 1 / 2 — read them,
// never infer them.
const CASH_PAY_ACTION_INDEX = {
  GENERATE: 0,   // "Generate link"   — written by the Command Center, mints below
  SEND: 3,       // "Send to patient" — written by the Command Center, texts (board automation)
  FAILED: 2,     // "Link failed"     — written by THIS service when a mint refuses
  TEXT_FAILED: 1, // "Text failed"    — written by THIS service when a send refuses
};
/** The board's own spelling of the two triggers, for reading an event back.
 *  ⚠️ Matched against the LABEL monday sends, so these are the board's strings,
 *  not ours — change them only against `settings_str`. */
const CASH_PAY_ACTION_GENERATE_LABEL = "Generate link";
const CASH_PAY_ACTION_SEND_LABEL = "Send to patient";
/** The board's own spelling, for reads. Written by index, never by text. */
const CASH_PAY_LABEL = "Cash Pay";

// ─── Bounds on what a link may be minted for ───
//
// ⚠️ THE CALLER SUPPLIES THE AMOUNT. The Command Center owns the pricing rule
// (`lib/orders/cashPayPricing.ts` — Cardinal's cost x1.25, rounded per line,
// plus a $10 floor) and this service deliberately does NOT re-implement it: a
// second copy of a money rule in a second repo is the hand-synced hazard, and
// its drift would be a patient charged an amount no screen ever showed.
//
// What this service owes instead is a sanity boundary, because an endpoint
// that mints a Stripe link for an arbitrary number is exactly the endpoint to
// be careful with. These are deliberately wide — they exist to catch a bug or
// a misplaced decimal, not to second-guess a real quote. The largest real cash
// pay order to date is $1,030.69.
const LIMITS = {
  MIN_TOTAL_CENTS: 100,          // $1 — below this something has gone wrong
  MAX_TOTAL_CENTS: 2_000_00,     // $2,000 — ~2x the largest real order
  MAX_LINES: 20,                 // Stripe's own ceiling on a payment link
  MAX_LABEL_CHARS: 250,
};

/**
 * What the patient sees on the Stripe page when the link is minted from the
 * BOARD rather than from an itemised request.
 *
 * ⚠️⚠️ **ONE LINE, AND THAT IS THE WHOLE COST OF THE WEBHOOK ROUTE.** A monday
 * webhook carries an item id and nothing else, so the only price this service
 * can see is **Cash Pay Amount** on the row — one number. Rebuilding the three
 * product lines here would mean re-implementing the Command Center's pricing
 * rule against the board's product columns, which is precisely the second copy
 * of a money rule that must not exist. The itemisation lives where it is
 * computed: on the Command Center card the rep reads from, and in the text the
 * patient receives.
 *
 * The label therefore names what is being bought and never prices it, so it
 * cannot be wrong about the amount however the quote was built.
 */
const CASH_PAY_LINE_LABEL = "Medically Modern — diabetes supplies";

module.exports = {
  ORDER_BOARD_ID,
  ORDER_COLUMNS,
  ORDER_STATUS_INDEX,
  CASH_PAY_PAYER_INDEX,
  CASH_PAY_ACTION_INDEX,
  CASH_PAY_ACTION_GENERATE_LABEL,
  CASH_PAY_ACTION_SEND_LABEL,
  CASH_PAY_LABEL,
  CASH_PAY_LINE_LABEL,
  LIMITS,
};
