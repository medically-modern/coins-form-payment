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

const { getOrder, storeCashPayLink, recordCashPayment, setCashPayAction } = require("./monday");
const {
  mintRefusal, lineRefusal, money, paymentLinkPayload, etDateString,
  centsFromAmountText, eventStatusLabel, boardLineItems,
} = require("./rules");
const {
  ORDER_BOARD_ID, ORDER_COLUMNS, CASH_PAY_ACTION_INDEX, CASH_PAY_ACTION_GENERATE_LABEL,
} = require("./config");

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

/**
 * The cash pay webhook's shared secret.
 *
 * ⚠️⚠️ **DELIBERATELY NOT `MONDAY_WEBHOOK_SECRET`.** That variable is unset on
 * this service, so the coinsurance webhook's own check is inert — and monday's
 * "send a webhook" automation sends no `authorization` header, so *setting* it
 * would start 401-ing the live pay-secondary flow. Reusing the name would make
 * turning auth on here break something else silently.
 *
 * ⚠️ **Unset disables the route**, exactly as `requireService` does above. An
 * endpoint that mints Stripe payment links must never be open because somebody
 * forgot to configure it.
 *
 * Accepted from the `authorization` header **or** a `?key=` query parameter,
 * because a monday board automation may not let you set a header. The query
 * form is the one that certainly works; prefer the header where monday offers
 * it, since a URL can end up in a log.
 */
function requireWebhookSecret(req, res) {
  const expected = process.env.CASH_PAY_WEBHOOK_SECRET;
  if (!expected) {
    console.warn("[cash-pay/wh] Refused — CASH_PAY_WEBHOOK_SECRET is not set");
    res.status(503).json({ error: "The cash pay webhook is not configured on this server." });
    return false;
  }
  /* ⚠️⚠️ **MONDAY SENDS ITS OWN `Authorization` HEADER, so the secret must be
     looked for in ALL THREE places rather than the first one present.** Monday
     signs every webhook delivery with a JWT in `Authorization`; an
     `a || b || c` chain therefore always resolves to that JWT, and the real key
     — in the query string or the path — is never even compared. The delivery is
     refused 401 with a correctly-configured webhook, which looks exactly like a
     wrong secret.

     Measured against production, 2026-09-22, on the New Order Board:
       · `?key=<secret>`            → 401
       · `/cash-pay/<secret>`       → 401
       · `/cash-pay/<secret>` with no Authorization header → 200
     An earlier fix here read the first two failures as "monday drops the query
     string" and added the path form to work around it. That diagnosis was
     wrong: the path was being delivered intact and shadowed just the same.
     Railway's HTTP log strips query strings, which is what made the wrong
     explanation look plausible — you cannot see from it whether `?key=`
     arrived.

     All three forms are kept. The header is what curl and a UI-built automation
     can use; the query and path are what an API-created webhook can carry past
     monday's own header. */
  const candidates = [
    String(req.headers.authorization || "").replace(/^Bearer\s+/i, ""),
    String(req.query?.key || ""),
    String(req.params?.secret || ""),
  ];
  if (!candidates.some((got) => got.length === expected.length && got === expected)) {
    console.warn("[cash-pay/wh] Refused — bad secret");
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

  /**
   * POST /webhook/monday/cash-pay
   *
   * The live route. A rep presses **Generate** in the Command Center; the app
   * writes **Cash Pay Amount** and then flips **Cash Pay Action** to "Generate
   * link"; a board automation turns that into this request; this mints the
   * Stripe link and writes it back. Exactly the shape the coinsurance flow has
   * used for a year — the board is the trigger, and no browser ever holds a
   * token.
   *
   * ⚠️⚠️ **THE AMOUNT COMES OFF THE ROW, NOT OUT OF THIS REQUEST.** A monday
   * webhook carries an item id and a status label, so the Command Center has to
   * put the price somewhere this service can read it, and that somewhere is
   * Cash Pay Amount. The pricing rule stays in one repo; what crosses is a
   * number the rep has already seen on screen.
   *
   * ⚠️ **It always answers 200 once it has decided the request is ours.**
   * Monday retries a non-2xx and eventually stops delivering altogether, and a
   * refusal here is a fact about the order rather than a broken endpoint — so
   * the refusal is written to the BOARD ("Link failed") where a rep sees it,
   * and the response only tells monday not to try again.
   */
  /* ⚠️ TWO paths, ONE handler. `/:secret` is what an API-created monday webhook
     must use — see requireWebhookSecret for why the query string does not
     survive. The bare path still works when the secret comes in a header or a
     query string. */
  const cashPayWebhook = async (req, res) => {
    /* Monday posts this once when the webhook URL is saved and expects it
       echoed. It arrives before any secret is configured on their side, so the
       handshake is answered before the auth check — the same order the
       coinsurance webhook uses. */
    if (req.body?.challenge) {
      console.log("[cash-pay/wh] Challenge received");
      return res.json({ challenge: req.body.challenge });
    }

    if (!requireWebhookSecret(req, res)) return;

    const event = req.body?.event;
    if (!event) return res.status(400).json({ error: "No event in payload" });

    const itemId = String(event.pulseId ?? "");
    const boardId = String(event.boardId ?? "");
    if (!itemId || itemId === "undefined") return res.status(400).json({ error: "Missing pulseId" });

    /* ⚠️ The board guard is not ceremony. `getOrder` refuses an item on another
       board, but refusing here means a stray automation on some other board
       never reaches monday at all. */
    if (boardId && boardId !== ORDER_BOARD_ID) {
      console.log(`[cash-pay/wh] Ignoring — wrong board (${boardId})`);
      return res.json({ ok: true, skipped: true, reason: "wrong board" });
    }

    /* ⚠️⚠️ **THE LABEL GUARD IS WHAT STOPS A "SEND TO PATIENT" PRESS MINTING A
       SECOND LINK.** The automation should fire on a change *to* "Generate
       link" and nothing else, but automations get rebuilt, and an endpoint that
       mints a payment link must not rely on somebody else's radio button. An
       unreadable label reads as "not the generate trigger" and skips. */
    const label = eventStatusLabel(event, ORDER_COLUMNS.CASH_PAY_ACTION);
    if (label !== CASH_PAY_ACTION_GENERATE_LABEL) {
      console.log(`[cash-pay/wh] Ignoring item ${itemId} — label "${label}" is not the mint trigger`);
      return res.json({ ok: true, skipped: true, reason: "not the generate trigger" });
    }

    /* Written to the board on every refusal below, because the rep's only other
       signal is a link that never appears. Swallows its own failure: a board
       write that fails must not turn a refusal into a monday retry. */
    const markFailed = async (why) => {
      console.warn(`[cash-pay/wh] Item ${itemId} refused: ${why}`);
      try { await setCashPayAction(itemId, CASH_PAY_ACTION_INDEX.FAILED); }
      catch (err) { console.error("[cash-pay/wh] Could not write Link failed:", err.message); }
      return res.json({ ok: true, skipped: true, reason: why });
    };

    try {
      const order = await getOrder(itemId);
      const refusal = mintRefusal(order);
      if (refusal) return await markFailed(refusal);

      /* ⚠️ **A LIVE LINK IS NEVER REPLACED HERE, and that is the rule rather
         than a missing feature.** Two live links means the patient holds two,
         and paying the older one charges last week's price. Pressing Generate
         on an order that already has one returns it and clears the trigger.
         Replacing a link is a deliberate, visible act: clear the Cash Pay Link
         cell on the board, then press Generate again.
         ⚠️ Nothing is re-written to the row on this path — writing the current
         Cash Pay Amount back would leave the board stating a price the existing
         link does not charge. */
      if (order.cashPayLink) {
        console.log(`[cash-pay/wh] Item ${itemId} already has a link — leaving it`);
        await setCashPayAction(itemId, null);
        return res.json({ ok: true, itemId, url: order.cashPayLink, existing: true });
      }

      const totalCents = centsFromAmountText(order.cashPayAmount);
      if (totalCents === null) {
        return await markFailed("Cash Pay Amount is blank or unreadable on this order.");
      }

      const lines = boardLineItems(totalCents);
      const badLines = lineRefusal(lines, totalCents);
      if (badLines) return await markFailed(badLines);

      const link = await stripe.paymentLinks.create(paymentLinkPayload({
        itemId: order.itemId,
        patientName: order.name,
        lines,
        orderNumber: order.cahOrderNumber,
      }));

      await storeCashPayLink(order.itemId, { url: link.url, totalCents });
      /* Clear LAST: it is what re-arms the button, and re-arming it before the
         link is on the board would invite a second press that mints a second
         link. */
      await setCashPayAction(order.itemId, null);

      console.log(`[cash-pay/wh] Link minted for order ${order.itemId}: ${money(totalCents)} (${link.id})`);
      res.json({ ok: true, itemId: order.itemId, url: link.url, amount: (totalCents / 100).toFixed(2) });
    } catch (err) {
      console.error("[cash-pay/wh] Mint failed:", err.message);
      return await markFailed("The payment service could not mint the link — try again.");
    }
  };

  app.post("/webhook/monday/cash-pay", cashPayWebhook);
  app.post("/webhook/monday/cash-pay/:secret", cashPayWebhook);

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
