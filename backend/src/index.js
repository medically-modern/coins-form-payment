const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { RedisStore } = require("rate-limit-redis");
const cookieParser = require("cookie-parser");
const PDFDocument = require("pdfkit");
const { verifyPaymentToken, generatePaymentToken, requireAuth, logout, COOKIE_OPTIONS } = require("./auth");
const { getPatientPaymentData, storePaymentLinkInMonday, recordPaymentInMonday, writeLongText } = require("./monday");
const { redis, healthCheck, getPaymentToken, getTokenForItem, markTokenPaid, isChargeProcessed, markChargeProcessed, logEvent } = require("./redis");
const { COMPANY, COLUMNS, SECONDARY_BOARD_ID, SEND_INVOICE_GROUP_ID } = require("./config");
const { sendSMS, buildPaymentMessage, buildFollowUpMessage } = require("./ringcentral");

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app = express();

// ─── Security headers ───
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      "script-src": ["'self'", "https://js.stripe.com"],
      "frame-src": ["'self'", "https://js.stripe.com", "https://hooks.stripe.com"],
      "style-src": ["'self'", "https:", "'unsafe-inline'"],
      "font-src": ["'self'", "https:", "data:"],
      "img-src": ["'self'", "data:", "https:"],
    },
  },
}));

// ─── CORS ───
const ALLOWED_ORIGINS = [
  "https://invoice.medicallymodern.com",
  "https://medically-modern.github.io",
  process.env.PAYMENT_URL,
  "http://localhost:5173",
  "http://localhost:8080",
].filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.some((o) => origin.startsWith(o))) return cb(null, true);
    cb(new Error("Not allowed by CORS"));
  },
  credentials: true,
}));

// ═══════════════════════════════════════════════════════
// STRIPE WEBHOOK — raw body, BEFORE express.json()
// Handles: checkout.session.completed (Stripe Checkout)
// ═══════════════════════════════════════════════════════

app.post("/webhook/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    if (endpointSecret && sig) {
      event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } else {
      event = JSON.parse(req.body.toString());
      console.log("[stripe] WARNING: No webhook secret — skipping signature verification");
    }
  } catch (err) {
    console.error("[stripe] Webhook signature verification failed:", err.message);
    return res.status(400).json({ error: "Webhook signature verification failed" });
  }

  console.log(`[stripe] Event received: ${event.type}`);

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const itemId = session.metadata?.itemId;
    const paymentToken = session.metadata?.paymentToken;
    const chargeId = session.payment_intent; // PaymentIntent ID serves as charge ID

    if (!itemId) {
      console.warn("[stripe] checkout.session.completed but no itemId in metadata:", session.id);
      return res.json({ received: true });
    }

    // ─── Idempotency guard ───
    if (chargeId) {
      const alreadyProcessed = await isChargeProcessed(chargeId);
      if (alreadyProcessed) {
        console.log(`[stripe] Duplicate webhook for charge ${chargeId} — skipping`);
        return res.json({ received: true, duplicate: true });
      }
    }

    const amountPaid = (session.amount_total || 0) / 100; // cents → dollars

    try {
      // Write to Monday: amount, date, charge ID, status → "Review"
      await recordPaymentInMonday(itemId, {
        amount: amountPaid,
        stripeChargeId: chargeId || session.id,
      });

      // Mark token as paid in Redis
      if (paymentToken) {
        await markTokenPaid(paymentToken, {
          stripeSessionId: session.id,
          stripeChargeId: chargeId,
          paidAmount: amountPaid,
        });
      }

      // Mark charge as processed (idempotency)
      if (chargeId) {
        await markChargeProcessed(chargeId, itemId);
      }

      console.log(`[stripe] Payment recorded for item ${itemId}: $${amountPaid}`);
    } catch (err) {
      console.error("[stripe] Error recording payment:", err.message);
      // Return 500 so Stripe retries
      return res.status(500).json({ error: "Failed to record payment" });
    }
  }

  // Also handle payment_intent.payment_failed for logging
  if (event.type === "payment_intent.payment_failed") {
    const pi = event.data.object;
    const itemId = pi.metadata?.itemId;
    if (itemId) {
      console.warn(`[stripe] Payment failed for item ${itemId}: ${pi.last_payment_error?.message}`);
    }
  }

  res.json({ received: true });
});

app.use(express.json());
app.use(cookieParser());
app.set("trust proxy", 1);

// ─── Rate limiters ───
const redisStore = (prefix) => new RedisStore({ sendCommand: (...args) => redis.call(...args), prefix: `rl:payment:${prefix}:` });
const globalLimiter = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false, store: redisStore("global") });
const authLimiter = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false, store: redisStore("auth") });
const apiLimiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false, store: redisStore("api") });

app.use(globalLimiter);

// ─── Health check ───
app.get("/health", async (req, res) => {
  const redisOk = await healthCheck();
  res.json({
    status: "ok",
    service: "pay-secondary",
    redis: redisOk ? "connected" : "disconnected",
    stripe: !!process.env.STRIPE_SECRET_KEY,
    timestamp: new Date().toISOString(),
  });
});

// ═══════════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════════

app.get("/auth/verify/:token", authLimiter, async (req, res) => {
  try {
    const { token } = req.params;
    const result = await verifyPaymentToken(token);
    if (result.error) {
      return res.status(result.status).json({ error: result.error });
    }
    res.cookie("session", result.jwt, COOKIE_OPTIONS);
    res.json({ success: true, itemId: result.itemId, token: result.jwt, isPaid: result.isPaid });
  } catch (err) {
    console.error("[auth] Error verifying payment token:", err.message);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

app.get("/auth/check", requireAuth, (req, res) => {
  res.json({ authenticated: true, itemId: req.itemId });
});

app.post("/auth/logout", requireAuth, async (req, res) => {
  try {
    const jwt = require("jsonwebtoken");
    const sessionToken = req.cookies?.session || req.headers.authorization?.slice(7);
    const decoded = jwt.decode(sessionToken);
    if (decoded?.jti && decoded?.exp) {
      await logout(decoded.jti, decoded.exp);
    }
    res.clearCookie("session", { ...COOKIE_OPTIONS, maxAge: 0 });
    res.json({ success: true });
  } catch (err) {
    console.error("[auth] Logout error:", err.message);
    res.clearCookie("session", { ...COOKIE_OPTIONS, maxAge: 0 });
    res.json({ success: true });
  }
});

// ═══════════════════════════════════════════════════════
// ADMIN ROUTES
// ═══════════════════════════════════════════════════════

// POST /admin/generate-token — Create payment link for a Monday item
// Accepts: { itemId } (Monday item ID from Secondary Claims Board)
app.post("/admin/generate-token", async (req, res) => {
  try {
    const apiKey = req.headers["x-api-key"];
    if (apiKey !== process.env.ADMIN_API_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { itemId } = req.body;
    if (!itemId) {
      return res.status(400).json({ error: "itemId required (Monday item ID from Secondary Claims Board)" });
    }

    // Verify item exists and get patient data
    const patientData = await getPatientPaymentData(String(itemId));
    if (!patientData) {
      return res.status(404).json({ error: "Item not found on Secondary Claims Board" });
    }

    if (patientData.totalPatientOwes <= 0) {
      return res.status(400).json({
        error: "No patient balance found",
        detail: "Subitems show $0 owed. Check that ERA line items have coinsurance/deductible amounts.",
      });
    }

    // Generate token (idempotent — returns existing if present)
    const token = await generatePaymentToken(String(itemId));
    const paymentUrl = process.env.PAYMENT_URL || "https://medically-modern.github.io/coins-form-payment";
    const link = `${paymentUrl}?token=${token}`;

    // Write token + link + sent date to Monday + set status
    await storePaymentLinkInMonday(String(itemId), token, link);
    console.log(`[admin] Payment token generated for item ${itemId} (${patientData.name})`);

    res.json({
      success: true,
      itemId: String(itemId),
      patientName: patientData.name,
      totalOwed: patientData.totalPatientOwes,
      link,
      token,
      expiresIn: "30 days",
    });
  } catch (err) {
    console.error("[admin] Error generating token:", err.message, err.stack);
    res.status(500).json({ error: "Failed to generate payment token" });
  }
});

// ═══════════════════════════════════════════════════════
// MONDAY WEBHOOK — auto-generate pay link on "Send Invoice"
// ═══════════════════════════════════════════════════════
//
// Monday automation: "When item moves to Send Invoice group → send webhook"
// Payload contains event.pulseId (item ID). We generate the token
// and write it back to the Monday item columns.

app.post("/webhook/monday", async (req, res) => {
  // ─── Monday challenge handshake ───
  if (req.body.challenge) {
    console.log("[monday-wh] Challenge received");
    return res.json({ challenge: req.body.challenge });
  }

  // ─── Validate webhook secret (optional but recommended) ───
  const webhookSecret = process.env.MONDAY_WEBHOOK_SECRET;
  if (webhookSecret) {
    const authHeader = req.headers.authorization;
    if (authHeader !== webhookSecret) {
      console.warn("[monday-wh] Invalid webhook secret");
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  const event = req.body.event;
  if (!event) {
    return res.status(400).json({ error: "No event in payload" });
  }

  const itemId = String(event.pulseId);
  const boardId = String(event.boardId || "");
  const groupId = event.groupId || event.destGroupId;

  console.log(`[monday-wh] Event received: item=${itemId} board=${boardId} group=${groupId}`);

  // ─── Guard: only process items on the correct board + group ───
  if (boardId && boardId !== SECONDARY_BOARD_ID) {
    console.log(`[monday-wh] Ignoring — wrong board (${boardId})`);
    return res.json({ ok: true, skipped: true, reason: "wrong board" });
  }

  if (groupId && groupId !== SEND_INVOICE_GROUP_ID) {
    console.log(`[monday-wh] Ignoring — wrong group (${groupId})`);
    return res.json({ ok: true, skipped: true, reason: "wrong group" });
  }

  if (!itemId || itemId === "undefined") {
    return res.status(400).json({ error: "Missing pulseId" });
  }

  try {
    // ─── Idempotent: skip if token already exists ───
    const existingToken = await getTokenForItem(itemId);
    if (existingToken) {
      console.log(`[monday-wh] Item ${itemId} already has a token — skipping`);
      return res.json({ ok: true, skipped: true, reason: "token exists" });
    }

    // ─── Verify item exists and has a balance ───
    const patientData = await getPatientPaymentData(itemId);
    if (!patientData) {
      console.warn(`[monday-wh] Item ${itemId} not found on board`);
      return res.status(404).json({ error: "Item not found" });
    }

    if (patientData.totalPatientOwes <= 0) {
      console.warn(`[monday-wh] Item ${itemId} (${patientData.name}) has $0 balance — skipping`);
      return res.json({ ok: true, skipped: true, reason: "zero balance" });
    }

    // ─── Generate token + write to Monday ───
    const token = await generatePaymentToken(itemId);
    const paymentUrl = process.env.PAYMENT_URL || "https://medically-modern.github.io/coins-form-payment";
    const link = `${paymentUrl}?token=${token}`;

    await storePaymentLinkInMonday(itemId, token, link);

    console.log(`[monday-wh] Payment link generated for item ${itemId} (${patientData.name}): $${patientData.totalPatientOwes}`);

    res.json({
      ok: true,
      itemId,
      patientName: patientData.name,
      totalOwed: patientData.totalPatientOwes,
      link,
    });
  } catch (err) {
    console.error(`[monday-wh] Error processing item ${itemId}:`, err.message, err.stack);
    // Return 200 so Monday doesn't retry endlessly — log the error
    res.json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════
// MONDAY WEBHOOK — send payment text via RingCentral
// ═══════════════════════════════════════════════════════
//
// Monday automations:
//   1. "When Secondary Status changes to 'Sent to Patient'" → initial text
//   2. "When Secondary Status changes to 'Follow Up'" → follow-up reminder
// Looks up item → gets phone + pay link → sends SMS via RingCentral.

app.post("/webhook/monday/send-text", async (req, res) => {
  // ─── Monday challenge handshake ───
  if (req.body.challenge) {
    console.log("[send-text] Challenge received");
    return res.json({ challenge: req.body.challenge });
  }

  const event = req.body.event;
  if (!event) {
    return res.status(400).json({ error: "No event in payload" });
  }

  const itemId = String(event.pulseId);
  console.log(`[send-text] Event received: item=${itemId}`);

  if (!itemId || itemId === "undefined") {
    return res.status(400).json({ error: "Missing pulseId" });
  }

  try {
    // ─── Detect status type from event payload ───
    // Monday sends status changes in various formats depending on automation type
    const statusLabel = event.value?.label?.text
      || event.value?.label
      || event.columnValues?.[COLUMNS.SECONDARY_STATUS]?.label?.text
      || event.columnValues?.[COLUMNS.SECONDARY_STATUS]?.label
      || "";
    console.log(`[send-text] Status label detected: "${statusLabel}" (raw value: ${JSON.stringify(event.value)})`);
    const isFollowUp = typeof statusLabel === "string" && statusLabel.toLowerCase().includes("follow up");
    const textType = isFollowUp ? "followup" : "initial";

    // ─── Idempotent: check per status type ───
    const smsSentKey = `pay-secondary:sms-sent:${itemId}:${textType}`;
    const alreadySent = await redis.get(smsSentKey);
    if (alreadySent) {
      console.log(`[send-text] Item ${itemId} already sent ${textType} text — skipping`);
      return res.json({ ok: true, skipped: true, reason: `${textType} already sent` });
    }

    // ─── Get patient data ───
    const patientData = await getPatientPaymentData(itemId);
    if (!patientData) {
      console.warn(`[send-text] Item ${itemId} not found`);
      return res.status(404).json({ error: "Item not found" });
    }

    // ─── TEST GUARD: controlled by SMS_LIVE env var ───
    // SMS_LIVE=true → sends to all patients
    // SMS_LIVE unset or anything else → only sends to items with [TEST] in name
    const smsLive = process.env.SMS_LIVE === "true";
    if (!smsLive && !patientData.name.includes("[TEST]")) {
      console.log(`[send-text] Item ${itemId} (${patientData.name}) skipped — SMS_LIVE is off and name missing [TEST]`);
      return res.json({ ok: true, skipped: true, reason: "SMS_LIVE is off — only [TEST] patients receive texts" });
    }

    // ─── Validate phone + pay link ───
    if (!patientData.phone) {
      console.warn(`[send-text] Item ${itemId} (${patientData.name}) has no phone number`);
      return res.json({ ok: false, error: "No phone number on file" });
    }

    // Look up existing token to build the link
    const token = await getTokenForItem(itemId);
    if (!token) {
      console.warn(`[send-text] Item ${itemId} has no payment token — generate link first`);
      return res.json({ ok: false, error: "No payment link generated yet" });
    }

    const paymentUrl = process.env.PAYMENT_URL || "https://medically-modern.github.io/coins-form-payment";
    const link = `${paymentUrl}?token=${token}`;

    // ─── Send SMS ───
    const message = isFollowUp
      ? buildFollowUpMessage(patientData.name, link)
      : buildPaymentMessage(patientData.name, link, patientData.totalPatientOwes);
    await sendSMS(patientData.phone, message);

    // ─── Mark as sent (90-day TTL) ───
    await redis.set(smsSentKey, new Date().toISOString(), "EX", 86400 * 90);

    // ─── Write sent date to Monday ───
    const { writeDate } = require("./monday");
    const today = new Date().toISOString().split("T")[0];
    await writeDate(itemId, COLUMNS.PAY_LINK_SENT_DATE, today);

    await logEvent(token, "sms_sent", {
      itemId,
      phone: patientData.phone.slice(-4), // log last 4 only
    });

    console.log(`[send-text] SMS sent for item ${itemId} (${patientData.name})`);

    res.json({
      ok: true,
      itemId,
      patientName: patientData.name,
    });
  } catch (err) {
    console.error(`[send-text] Error for item ${itemId}:`, err.message, err.stack);
    res.json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════
// PATIENT API ROUTES (all require auth)
// ═══════════════════════════════════════════════════════

// GET /api/me — Patient-safe payment data (ERA breakdown + amounts)
app.get("/api/me", apiLimiter, requireAuth, async (req, res) => {
  try {
    const data = await getPatientPaymentData(req.itemId);
    if (!data) {
      return res.status(404).json({ error: "Patient not found" });
    }
    // Strip internal fields
    const { itemId, ...safeData } = data;
    res.json(safeData);
  } catch (err) {
    console.error("[api] Error fetching patient data:", err.message);
    res.status(500).json({ error: "Unable to load your data. Please try again." });
  }
});

// POST /api/create-checkout-session — Stripe Checkout (hosted)
app.post("/api/create-checkout-session", apiLimiter, requireAuth, async (req, res) => {
  try {
    const data = await getPatientPaymentData(req.itemId);
    if (!data) {
      return res.status(404).json({ error: "Patient not found" });
    }

    if (data.isPaid) {
      return res.status(400).json({ error: "This balance has already been paid." });
    }

    if (data.totalPatientOwes <= 0) {
      return res.status(400).json({ error: "No balance owed." });
    }

    const amountCents = Math.round(data.totalPatientOwes * 100);
    const paymentUrl = process.env.PAYMENT_URL || "https://medically-modern.github.io/coins-form-payment";

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: {
            name: data.name,
            description: data.dos ? `Date of Service: ${data.dos}` : undefined,
          },
          unit_amount: amountCents,
        },
        quantity: 1,
      }],
      metadata: {
        itemId: req.itemId,
        paymentToken: req.paymentToken,
        patientName: data.name,
        dos: data.dos,
        service: "pay-secondary",
      },
      payment_intent_data: {
        metadata: {
          itemId: req.itemId,
          patientName: data.name,
          service: "pay-secondary",
        },
        statement_descriptor: "MID-ISLAND MEDICAL",
      },
      customer_email: undefined, // Patient pays via text link, no email required
      success_url: `${paymentUrl}?token=${req.paymentToken}&status=success`,
      cancel_url: `${paymentUrl}?token=${req.paymentToken}`,
    });

    await logEvent(req.paymentToken, "checkout_session_created", {
      sessionId: session.id,
      amount: data.totalPatientOwes,
    });

    console.log(`[stripe] Checkout session created for item ${req.itemId}: $${data.totalPatientOwes} (${session.id})`);

    res.json({ checkoutUrl: session.url, sessionId: session.id });
  } catch (err) {
    console.error("[stripe] Error creating checkout session:", err.message);
    res.status(500).json({ error: "Unable to initiate payment. Please try again." });
  }
});

// POST /api/send-message — Patient sends a question about their statement
app.post("/api/send-message", apiLimiter, requireAuth, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ error: "Message is required." });
    }

    const trimmed = message.trim().slice(0, 2000); // cap length
    const timestamp = new Date().toISOString().split("T")[0];
    const formatted = `[${timestamp}] ${trimmed}`;

    await writeLongText(req.itemId, COLUMNS.PATIENT_MESSAGE, formatted);

    await logEvent(req.paymentToken, "patient_message_sent", {
      itemId: req.itemId,
      messageLength: trimmed.length,
    });

    console.log(`[api] Patient message saved for item ${req.itemId} (${trimmed.length} chars)`);
    res.json({ success: true });
  } catch (err) {
    console.error("[api] Error saving patient message:", err.message);
    res.status(500).json({ error: "Unable to send message. Please try again." });
  }
});

// GET /api/receipt — Generate FSA/HSA-suitable PDF receipt
app.get("/api/receipt", apiLimiter, requireAuth, async (req, res) => {
  try {
    const data = await getPatientPaymentData(req.itemId);
    if (!data) {
      return res.status(404).json({ error: "Patient not found" });
    }

    if (!data.isPaid) {
      return res.status(400).json({ error: "No payment has been recorded for this balance." });
    }

    // Fetch payment method details from Stripe
    let paymentMethodSummary = "Card";
    try {
      if (data.stripeChargeId && data.stripeChargeId.startsWith("pi_")) {
        const pi = await stripe.paymentIntents.retrieve(data.stripeChargeId, {
          expand: ["payment_method"],
        });
        if (pi.payment_method?.card) {
          const card = pi.payment_method.card;
          const brand = (card.brand || "Card").charAt(0).toUpperCase() + (card.brand || "card").slice(1);
          paymentMethodSummary = `${brand} ending in ${card.last4}`;
        }
      }
    } catch (stripeErr) {
      console.warn("[receipt] Could not fetch payment method from Stripe:", stripeErr.message);
    }

    // Generate receipt number: REC-<itemId last 6>-<date YYMMDD>
    const paidDateStr = data.paidDate || new Date().toISOString().split("T")[0];
    const dateCompact = paidDateStr.replace(/-/g, "").slice(2); // YYMMDD
    const receiptNumber = `REC-${String(req.itemId).slice(-6)}-${dateCompact}`;

    // Generate PDF
    const doc = new PDFDocument({ size: "LETTER", margin: 50 });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="receipt-${data.name.replace(/\s+/g, "-")}-${data.dos || "payment"}.pdf"`);
    doc.pipe(res);

    // ─── Company Header ───
    doc.fontSize(15).font("Helvetica-Bold").text(COMPANY.name, { align: "center" });
    doc.fontSize(10).font("Helvetica").text(COMPANY.address, { align: "center" });
    doc.text(`NPI: ${COMPANY.npi}  \u00b7  Tax ID: ${COMPANY.taxId}`, { align: "center" });
    doc.moveDown(1.5);

    // ─── Title + Receipt Number ───
    doc.fontSize(18).font("Helvetica-Bold").text("PATIENT RECEIPT", { align: "center" });
    doc.fontSize(10).font("Helvetica").text(`Receipt #: ${receiptNumber}`, { align: "center" });
    doc.moveDown(1.5);

    // ─── Patient & Claim Info (two-column layout) ───
    const infoTop = doc.y;
    const leftCol = 60;
    const rightCol = 320;

    doc.fontSize(10).font("Helvetica-Bold").text("Patient:", leftCol, infoTop);
    doc.font("Helvetica").text(data.name, leftCol + 55, infoTop);

    doc.font("Helvetica-Bold").text("Date of Service:", leftCol, infoTop + 18);
    doc.font("Helvetica").text(data.dos || "N/A", leftCol + 100, infoTop + 18);

    doc.font("Helvetica-Bold").text("Date Paid:", leftCol, infoTop + 36);
    doc.font("Helvetica").text(paidDateStr, leftCol + 68, infoTop + 36);

    // Right column
    doc.font("Helvetica-Bold").text("Primary Payor:", rightCol, infoTop);
    doc.font("Helvetica").text(data.primaryPayor || "N/A", rightCol + 90, infoTop);

    if (data.secondaryPayer) {
      doc.font("Helvetica-Bold").text("Secondary Payor:", rightCol, infoTop + 18);
      doc.font("Helvetica").text(data.secondaryPayer, rightCol + 105, infoTop + 18);
    }

    doc.font("Helvetica-Bold").text("Confirmation:", rightCol, infoTop + 36);
    doc.fontSize(8).font("Helvetica").text(data.stripeChargeId || "N/A", rightCol + 80, infoTop + 37);

    doc.y = infoTop + 60;
    doc.moveDown(1);

    // ─── Divider ───
    doc.moveTo(50, doc.y).lineTo(562, doc.y).stroke();
    doc.moveDown(0.8);

    // ─── Itemized Charges Header ───
    doc.fontSize(11).font("Helvetica-Bold").text("AMOUNT PAID BY PATIENT AFTER INSURANCE", leftCol);
    doc.moveDown(0.6);

    // Column headers
    const tableLeft = 60;
    const tableRight = 540;
    const amountCol = 470;
    doc.fontSize(9).font("Helvetica-Bold");
    doc.text("Item", tableLeft, doc.y);
    doc.text("HCPCS", 280, doc.y);
    doc.text("Amount", amountCol, doc.y);
    doc.moveDown(0.3);
    doc.moveTo(tableLeft, doc.y).lineTo(tableRight, doc.y).lineWidth(0.5).stroke();
    doc.moveDown(0.4);

    // Line items
    doc.fontSize(10).font("Helvetica");
    for (const li of data.lineItems) {
      const modStr = li.modifiers ? ` ${li.modifiers}` : "";
      const y = doc.y;
      doc.text(li.name, tableLeft, y, { width: 210 });
      doc.text(`${li.hcpcCode}${modStr}`, 280, y, { width: 150 });
      doc.text(li.patientOwes > 0 ? `$${li.patientOwes.toFixed(2)}` : "$0.00", amountCol, y, { width: 70, align: "right" });
      doc.moveDown(0.3);
    }

    doc.moveDown(0.3);
    doc.moveTo(tableLeft, doc.y).lineTo(tableRight, doc.y).lineWidth(0.5).stroke();
    doc.moveDown(0.5);

    // ─── Total ───
    doc.fontSize(12).font("Helvetica-Bold");
    doc.text("TOTAL PAID", tableLeft, doc.y, { width: 400 });
    doc.fontSize(14).text(`$${data.paidAmount.toFixed(2)}`, amountCol - 20, doc.y - 16, { width: 90, align: "right" });
    doc.moveDown(1);

    // ─── Payment Method ───
    doc.fontSize(10).font("Helvetica-Bold").text("Payment Method:", tableLeft, doc.y);
    doc.font("Helvetica").text(paymentMethodSummary, tableLeft + 100, doc.y);
    doc.moveDown(2);

    // ─── Divider ───
    doc.moveTo(50, doc.y).lineTo(562, doc.y).lineWidth(0.5).stroke();
    doc.moveDown(1);

    // ─── FSA/HSA Notice ───
    doc.fontSize(9).font("Helvetica-Oblique")
      .text("This receipt is suitable for FSA / HSA reimbursement under IRS 213(d).", { align: "center" });
    doc.moveDown(0.5);
    doc.fontSize(8).font("Helvetica")
      .text(`Receipt #${receiptNumber}  \u00b7  Generated ${new Date().toISOString().split("T")[0]}`, { align: "center" });

    doc.end();
  } catch (err) {
    console.error("[receipt] Error generating PDF:", err.message);
    res.status(500).json({ error: "Unable to generate receipt." });
  }
});

// ─── Backward-compat: keep old stripe-config + create-payment-intent for any in-flight sessions ───
app.get("/api/stripe-config", apiLimiter, requireAuth, (req, res) => {
  res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY });
});

// ─── Start server ───
const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`[pay-secondary] Payment API running on port ${PORT}`);
});
