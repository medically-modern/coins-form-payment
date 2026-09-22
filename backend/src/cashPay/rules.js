// ─── Cash Pay: the pure rules ───
//
// Everything here is a function of its arguments — no Stripe, no monday, no
// Redis — so it can be tested, and it IS (`backend/test/cashPayRules.test.js`).
// That matters more here than anywhere else in this repo: it decides whether a
// patient is charged, and for how much, in a codebase whose only other gate is
// `npm run build` (CLAUDE.md §4).

const { LIMITS, CASH_PAY_LABEL } = require("./config");

/** Is this order's payer Cash Pay? An EXACT match on the trimmed label. */
function isCashPayOrder(payerLabel) {
  return String(payerLabel ?? "").trim().toLowerCase() === CASH_PAY_LABEL.toLowerCase();
}

const filled = (v) => String(v ?? "").trim() !== "";

/**
 * Why this order may not have a link minted for it — or "" when it may.
 *
 * ⚠️ Ordered in the sequence a person would ask the questions, and every
 * branch is a REFUSAL rather than a silent skip: minting a link for an order
 * that is already paid, or one Cardinal has already shipped, takes money for
 * something twice.
 */
function mintRefusal(order) {
  if (!order) return "That order is not on the board.";
  if (!isCashPayOrder(order.primaryInsurance)) {
    return "That order's payer is not Cash Pay, so it has no cash pay link.";
  }
  if (filled(order.stripeChargeId) || filled(order.cashPayPaidDate)) {
    return "That order has already been paid.";
  }
  /* Positive evidence it has been to Cardinal, whatever the status says — the
     same rule the Command Center's ordering gate uses, and what refuses the
     historical cash orders whose status was set to Paid Cash by hand. */
  if (filled(order.cahOrderNumber)) {
    return "That order has already been placed with Cardinal.";
  }
  return "";
}

/**
 * Why these line items cannot be charged — or "" when they can.
 *
 * ⚠️ **The cents are summed from the LINES and must equal the total the caller
 * states.** Stripe charges the sum of what it is handed, so a total computed a
 * second way can differ by a cent from the lines printed above it — and a
 * receipt whose lines do not add up to its total is the kind of thing a patient
 * telephones about. Disagreement is a refusal, never a silent preference for
 * one of the two.
 */
function lineRefusal(lines, totalCents) {
  if (!Array.isArray(lines) || lines.length === 0) return "No line items were sent.";
  if (lines.length > LIMITS.MAX_LINES) {
    return `Too many line items (${lines.length}); Stripe allows ${LIMITS.MAX_LINES}.`;
  }
  for (const l of lines) {
    if (!l || typeof l !== "object") return "A line item was not an object.";
    const label = String(l.label ?? "").trim();
    if (!label) return "A line item has no label.";
    if (label.length > LIMITS.MAX_LABEL_CHARS) return `A line item's label is too long: "${label.slice(0, 40)}…".`;
    if (!Number.isInteger(l.quantity) || l.quantity < 1) {
      return `"${label}" has an invalid quantity.`;
    }
    /* ⚠️ Whole cents, checked as an INTEGER. A float here is a rounding rule
       arriving from somewhere this service cannot see, and Stripe takes
       integers regardless — accepting 269.775 would charge 269 or 270 with
       nothing saying which. */
    if (!Number.isInteger(l.amountCents) || l.amountCents < 1) {
      return `"${label}" has an invalid amount.`;
    }
  }
  const sum = lines.reduce((s, l) => s + l.amountCents * l.quantity, 0);
  if (!Number.isInteger(totalCents)) return "The total is not a whole number of cents.";
  if (sum !== totalCents) {
    return `The line items come to ${money(sum)} but the total says ${money(totalCents)}.`;
  }
  if (totalCents < LIMITS.MIN_TOTAL_CENTS) return `${money(totalCents)} is below the minimum this can charge.`;
  if (totalCents > LIMITS.MAX_TOTAL_CENTS) {
    return `${money(totalCents)} is over the ${money(LIMITS.MAX_TOTAL_CENTS)} ceiling — check the quote before sending it.`;
  }
  return "";
}

/** Cents → "$1,030.69", for a refusal a person reads. */
function money(cents) {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/**
 * The Stripe Payment Link payload.
 *
 * ⚠️⚠️ **A PAYMENT LINK, NOT A CHECKOUT SESSION.** A Checkout Session's
 * `expires_at` can be at most 24 hours after creation (Stripe's API reference,
 * verified 2026-09-22), so a session URL texted to a patient is dead by the
 * next morning and the 15-day reminder loop would be chasing a link nobody can
 * pay. A Payment Link has no expiry at all.
 *
 * ⚠️ `metadata` is what makes the webhook work: Stripe copies a Payment Link's
 * metadata onto every Checkout Session the link creates, so
 * `checkout.session.completed` arrives carrying `itemId` and `service`. Without
 * it the webhook sees a payment it cannot attribute to an order.
 *
 * ⚠️ `service: "cash-pay"` is the DISCRIMINATOR against the existing
 * pay-secondary flow, which sets `service: "pay-secondary"` on its own
 * sessions. The webhook must branch on it rather than on the presence of a
 * field, or a cash payment would be recorded on the Secondary Claims board.
 */
function paymentLinkPayload({ itemId, patientName, lines, orderNumber }) {
  return {
    line_items: lines.map((l) => ({
      quantity: l.quantity,
      price_data: {
        currency: "usd",
        unit_amount: l.amountCents,
        product_data: { name: l.label.slice(0, LIMITS.MAX_LABEL_CHARS) },
      },
    })),
    metadata: {
      itemId: String(itemId),
      service: "cash-pay",
      patientName: String(patientName ?? "").slice(0, 200),
      ...(orderNumber ? { orderNumber: String(orderNumber) } : {}),
    },
    /* Copied onto the PaymentIntent so the charge itself is attributable in
       the Stripe dashboard, not only the session.
       ⚠️⚠️ **NO `statement_descriptor` HERE, and that is not an omission.**
       Stripe's API reference on `payment_intent_data.statement_descriptor`
       (verified 2026-09-22): it is for a *non-card* charge, and "setting this
       value for a card charge returns an error" — for cards the field is
       `statement_descriptor_suffix`, which is concatenated onto the account's
       prefix within a 22-character total. Nearly every patient pays by card,
       so copying the pay-secondary Checkout Session's `statement_descriptor`
       into a Payment Link would error on the one thing that matters. The
       account's own default descriptor applies, which is what the handoff
       asks for; adding a suffix is a separate decision with a character
       budget to get right. */
    payment_intent_data: {
      metadata: { itemId: String(itemId), service: "cash-pay" },
    },
    /* Stripe's own confirmation page. No redirect, because this repo's
       frontend has no cash-pay page — a redirect to one that does not exist
       is worse than the page Stripe already renders. */
    after_completion: {
      type: "hosted_confirmation",
      hosted_confirmation: {
        custom_message: "Thank you — your payment is received and your order is on its way. "
          + "Any questions, call us on (347) 503-7148.",
      },
    },
    /* ⚠️ Single use. Without this a patient who taps the text twice pays
       twice, and the second charge has to be refunded by hand. */
    restrictions: { completed_sessions: { limit: 1 } },
    /* A dead link that explains itself beats a 404 for somebody tapping an old
       text weeks later. */
    inactive_message: "This payment link has been used or cancelled. Please call us on (347) 503-7148 if you still need to pay.",
  };
}

/** The Eastern calendar day, as monday's date columns want it (YYYY-MM-DD). */
function etDateString(now = new Date()) {
  /* ⚠️ Eastern, never UTC. Every date on these boards is Eastern wall clock,
     and a payment taken at 9pm ET would otherwise be stamped tomorrow. */
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

module.exports = {
  isCashPayOrder,
  mintRefusal,
  lineRefusal,
  money,
  paymentLinkPayload,
  etDateString,
};
