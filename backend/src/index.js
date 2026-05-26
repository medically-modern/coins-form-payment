const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { RedisStore } = require("rate-limit-redis");
const cookieParser = require("cookie-parser");
const { verifyPaymentToken, generatePaymentToken, requireAuth, logout, COOKIE_OPTIONS } = require("./auth");
const { getPatientPaymentData, findPatientByPhone, storePaymentLinkInMonday, recordPaymentInMonday } = require("./monday");
const { redis, healthCheck } = require("./redis");

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

// ─── Stripe webhook needs raw body — MUST be before express.json() ───
app.post("/webhook/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    if (endpointSecret && sig) {
      event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } else {
      // In test mode without webhook secret, parse directly
      event = JSON.parse(req.body.toString());
      console.log("[stripe] WARNING: No webhook secret configured — skipping signature verification");
    }
  } catch (err) {
    console.error("[stripe] Webhook signature verification failed:", err.message);
    return res.status(400).json({ error: "Webhook signature verification failed" });
  }

  console.log(`[stripe] Event received: ${event.type}`);

  if (event.type === "payment_intent.succeeded") {
    const pi = event.data.object;
    const uid = pi.metadata?.uid;
    const amount = pi.amount / 100; // cents to dollars

    if (uid) {
      try {
        await recordPaymentInMonday(uid, {
          amount,
          stripeId: pi.id,
          status: "Paid",
        });
        console.log(`[stripe] Payment recorded for UID ${uid}: $${amount}`);
      } catch (err) {
        console.error("[stripe] Error recording payment in Monday:", err.message);
      }
    } else {
      console.warn("[stripe] Payment succeeded but no UID in metadata:", pi.id);
    }
  }

  if (event.type === "payment_intent.payment_failed") {
    const pi = event.data.object;
    const uid = pi.metadata?.uid;
    if (uid) {
      try {
        await recordPaymentInMonday(uid, {
          amount: pi.amount / 100,
          stripeId: pi.id,
          status: "Failed",
        });
      } catch (err) {
        console.error("[stripe] Error recording failed payment:", err.message);
      }
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
    service: "coins-form-payment",
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
    res.json({ success: true, uid: result.uid, token: result.jwt });
  } catch (err) {
    console.error("[auth] Error verifying payment token:", err.message);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

app.get("/auth/check", requireAuth, (req, res) => {
  res.json({ authenticated: true, uid: req.uid });
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
// ADMIN ROUTE
// ═══════════════════════════════════════════════════════

app.post("/admin/generate-token", async (req, res) => {
  try {
    const apiKey = req.headers["x-api-key"];
    if (apiKey !== process.env.ADMIN_API_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { phone, uid } = req.body;
    if (!phone && !uid) {
      return res.status(400).json({ error: "Phone or UID required" });
    }

    let patientUid = uid;
    if (phone && !uid) {
      const patient = await findPatientByPhone(phone);
      if (!patient || !patient.uid) {
        return res.status(404).json({ error: "Patient not found" });
      }
      patientUid = patient.uid;
    }

    const token = await generatePaymentToken(patientUid);
    const paymentUrl = process.env.PAYMENT_URL || "https://medically-modern.github.io/coins-form-payment";
    const link = `${paymentUrl}?token=${token}`;

    await storePaymentLinkInMonday(patientUid, token, link);
    console.log(`[admin] Payment token generated for UID ${patientUid}`);

    res.json({ success: true, uid: patientUid, link, token, expiresIn: "30 days" });
  } catch (err) {
    console.error("[admin] Error generating token:", err.message, err.stack);
    res.status(500).json({ error: "Failed to generate payment token" });
  }
});

// ═══════════════════════════════════════════════════════
// PATIENT API ROUTES (all require auth)
// ═══════════════════════════════════════════════════════

app.get("/api/me", apiLimiter, requireAuth, async (req, res) => {
  try {
    const data = await getPatientPaymentData(req.uid);
    if (!data) {
      return res.status(404).json({ error: "Patient not found" });
    }
    const { itemId, ...safeData } = data;
    res.json(safeData);
  } catch (err) {
    console.error("[api] Error fetching patient data:", err.message);
    res.status(500).json({ error: "Unable to load your data. Please try again." });
  }
});

// GET /api/stripe-config — Return publishable key to frontend
app.get("/api/stripe-config", apiLimiter, requireAuth, (req, res) => {
  res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY });
});

// POST /api/create-payment-intent — Create Stripe PaymentIntent
app.post("/api/create-payment-intent", apiLimiter, requireAuth, async (req, res) => {
  try {
    const { amount } = req.body; // amount in dollars
    if (!amount || amount <= 0 || amount > 50000) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    const amountCents = Math.round(amount * 100);

    // Get patient name for Stripe metadata
    const patientData = await getPatientPaymentData(req.uid);
    const patientName = patientData?.name || "Unknown";

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: "usd",
      metadata: {
        uid: req.uid,
        patientName,
        service: "coins-form-payment",
      },
      description: `Co-insurance payment for ${patientName}`,
      automatic_payment_methods: { enabled: true },
    });

    console.log(`[stripe] PaymentIntent created for UID ${req.uid}: $${amount} (${paymentIntent.id})`);

    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error("[stripe] Error creating PaymentIntent:", err.message);
    res.status(500).json({ error: "Unable to initiate payment. Please try again." });
  }
});

// ─── Start server ───
const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`[payment-api] Co-insurance payment API running on port ${PORT}`);
});
