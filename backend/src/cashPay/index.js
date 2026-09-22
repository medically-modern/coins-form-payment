// ─── Cash Pay: the two routes and the webhook branch ───
//
// A patient with no insurance is quoted from Cardinal's costs in the Command
// Center, pays through a Stripe link minted here, and only then may their order
// be placed with Cardinal. This file is everything the SPA and Stripe touch;
// the rules are pure in `./rules.js` and tested.
//
// ⚠️ **Nothing in the pay-secondary flow changes.** This mounts its own routes,
// reads its own board, and the Stripe webhook branch keys on
// `metadata.service === "cash-pay"` — a discriminator the existing flow already
// sets on its own sessions as "pay-secondary".

const { getOrder, storeCashPayLink, recordCashPayment } = require("./monday");
const { mintRefusal, lineRefusal, money, paymentLinkPayload, etDateString } = require("./rules");

/**
 * Service auth.
 *
 * ⚠️ NOT `requireAuth`. That is the PATIENT's JWT, minted from a pay link; this
 * caller is the Command Center, which has no patient session and must not be
 * given one. A shared bearer token in the Railway environment is the same
 * device the rest of this org uses for service-to-service calls.
 *
 * ⚠️ An UNSET token disables the route rather than leaving it open. An endpoint
 * that mints Stripe payment links must never be reachable because somebody
 * forgot to configure it — the same call the gateway's Calendly day route
 * makes.
 */
function requireService(req, res) {
  const expected = process.env.CASH_PAY_SERVICE_TOKEN;
  if (!expected) {
    res.status(503).json({ error: "Cash pay links are not configured on this server." });
    return false;
  }
  const got = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  /* Length-then-value: a mismatch of length leaks nothing a timing attack can
     use, and both sides are configuration rather than user input. */
  if (got.length !== expected.length || got !== expected) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

function register(app, { stripe, limiter }) {
  /* An absent limiter is a programming error, not a configuration one — this
     route mints Stripe payment links and must never be mounted unthrottled. */
  if (typeof limiter !== "function") {
    throw new Error("cashPay.register needs a rate limiter — see backend/src/index.js");
  }

  /**
   * POST /api/cash-pay/create-link
   *
   * Body: { itemId, lines: [{label, quantity, amountCents}], totalCents,
   *         regenerate?: boolean }
   *
   * ⚠️ **THE CALLER SUPPLIES THE PRICE, and that is deliberate.** The Command
   * Center owns the pricing rule (Cardinal's cost x1.25, rounded per line, plus
   * a $10 floor under $10 of markup) and re-implementing it here would be a
   * second copy of a money rule in a second repo — the drift would be a patient
   * charged an amount no screen ever showed. What this route owes instead is
   * the order's own state and a sanity boundary on the number.
   */
  app.post("/api/cash-pay/create-link", limiter, async (req, res) => {
    if (!requireService(req, res)) return;

    const { itemId, lines, totalCents, regenerate } = req.body || {};
    if (!itemId) return res.status(400).json({ error: "itemId is required." });

    const badLines = lineRefusal(lines, totalCents);
    if (badLines) return res.status(400).json({ error: badLines });

    try {
      const order = await getOrder(itemId);
      const refusal = mintRefusal(order);
      if (refusal) return res.status(409).json({ error: refusal });

      /* ⚠️ Idempotent by default. A rep pressing Generate twice, or a retried
         request, must not leave two live links for one order — the patient
         would then hold two, and paying the older one charges last week's
         price. `regenerate` is the explicit way to replace one. */
      if (order.cashPayLink && !regenerate) {
        return res.json({
          url: order.cashPayLink,
          amount: order.cashPayAmount,
          existing: true,
        });
      }

      const link = await stripe.paymentLinks.create(paymentLinkPayload({
        itemId: order.itemId,
        patientName: order.name,
        lines,
        orderNumber: order.cahOrderNumber,
      }));

      await storeCashPayLink(order.itemId, { url: link.url, totalCents });

      console.log(`[cash-pay] Link minted for order ${order.itemId}: ${money(totalCents)} (${link.id})`);
      res.json({ url: link.url, amount: (totalCents / 100).toFixed(2), paymentLinkId: link.id });
    } catch (err) {
      console.error("[cash-pay] create-link failed:", err.message);
      res.status(500).json({ error: "Could not create the payment link. Please try again." });
    }
  });

  /* ⚠️⚠️ **THE TEXT IS THE BOARD'S JOB, NOT THIS SERVICE'S — and the obvious
     shortcut is a cross-board write.** The handoff says to reuse the monday
     texting automation, and the order board is where that automation belongs
     (the Command Center's Send press is dark waiting on exactly that column
     and automation). There is deliberately no `/webhook/monday/cash-pay-text`
     here.

     The trap, if somebody adds one: `smsQueue.enqueueSMS` looks like the thing
     to call and is bound to the SECONDARY CLAIMS BOARD. It writes that board's
     SMS Status on enqueue, and `processQueue` writes that board's SMS Status
     and Pay Link Sent Date on send — all with whatever `itemId` it was handed.
     Fed an ORDER board id it writes the wrong board, and if an item with that
     id happens to exist there it stamps a stranger's record. Reusing it needs
     it parameterised by board first, which is a change to the pay-secondary
     path. */
}

/**
 * The text a patient receives — their own name, the amount, the link.
 *
 * Exported but not called here: the board automation sends it (above). It
 * lives in code so the wording has one home and can be tested, and so
 * whoever builds the automation has the exact string to paste.
 */
function cashPayText(order) {
  const first = String(order.name || "").trim().split(/\s+/)[0] || "there";
  const amount = order.cashPayAmount ? `$${Number(order.cashPayAmount).toFixed(2)}` : "your order";
  return `Hi ${first}, this is Medically Modern. Your supplies come to ${amount}. `
    + `You can pay securely here: ${order.cashPayLink}\n\n`
    + `Questions? Call us on (347) 503-7148.`;
}

/**
 * The `checkout.session.completed` branch for a cash payment.
 *
 * Returns true when it handled the event, so the existing pay-secondary branch
 * can be skipped — the two must never both run on one session.
 */
async function handleStripeSession(session) {
  if (session?.metadata?.service !== "cash-pay") return false;

  const itemId = session.metadata?.itemId;
  const chargeId = session.payment_intent || session.id;
  if (!itemId) {
    console.warn("[cash-pay] completed session carries no itemId:", session.id);
    return true; // ours, and unattributable — but NOT the other flow's
  }

  await recordCashPayment(itemId, { chargeId, date: etDateString() });
  console.log(`[cash-pay] Payment recorded for order ${itemId}: ${chargeId}`);
  return true;
}

module.exports = { register, handleStripeSession, cashPayText, requireService };
