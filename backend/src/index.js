const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { RedisStore } = require("rate-limit-redis");
const cookieParser = require("cookie-parser");
const { verifyPaymentToken, generatePaymentToken, requireAuth, logout, COOKIE_OPTIONS } = require("./auth");
const { getPatientPaymentData, findPatientByPhone, storePaymentLinkInMonday, recordPaymentInMonday } = require("./monday");
const { redis, healthCheck } = require("./redis");

const app = express();

// ─── Security headers ───
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      "script-src": ["'self'"],
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
  "http://localhost:5173",   // local dev
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
    timestamp: new Date().toISOString(),
  });
});

// ═══════════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════════

// GET /auth/verify/:token — Verify payment token, issue session
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

// GET /auth/check — Check if session is valid
app.get("/auth/check", requireAuth, (req, res) => {
  res.json({ authenticated: true, uid: req.uid });
});

// POST /auth/logout — End session
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
// ADMIN ROUTE — Generate payment link for a patient
// Called by command center / automation to create the link
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

    // If phone provided, look up the patient
    if (phone && !uid) {
      const patient = await findPatientByPhone(phone);
      if (!patient || !patient.uid) {
        return res.status(404).json({ error: "Patient not found" });
      }
      patientUid = patient.uid;
    }

    // Generate token
    const token = await generatePaymentToken(patientUid);
    const paymentUrl = process.env.PAYMENT_URL || "https://medically-modern.github.io/coins-form-payment";
    const link = `${paymentUrl}?token=${token}`;

    // Store token + link in Monday
    await storePaymentLinkInMonday(patientUid, token, link);

    console.log(`[admin] Payment token generated for UID ${patientUid}`);

    res.json({
      success: true,
      uid: patientUid,
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
// PATIENT API ROUTES (all require auth)
// ═══════════════════════════════════════════════════════

// GET /api/me — Patient OOP data for the payment form
app.get("/api/me", apiLimiter, requireAuth, async (req, res) => {
  try {
    const data = await getPatientPaymentData(req.uid);
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

// ═══════════════════════════════════════════════════════
// STRIPE WEBHOOK STUB (future)
// ═══════════════════════════════════════════════════════

// POST /webhook/stripe — Handle Stripe payment events
app.post("/webhook/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  // TODO: Implement Stripe webhook verification + payment recording
  // 1. Verify Stripe signature (req.headers["stripe-signature"])
  // 2. Extract payment intent from event
  // 3. Match to patient via metadata.uid
  // 4. Call recordPaymentInMonday(uid, { amount, stripeId })
  // 5. Optionally invalidate the payment token

  console.log("[stripe] Webhook received (stub — not yet implemented)");
  res.json({ received: true });
});

// ─── Start server ───
const PORT = process.env.PORT || 3002;

app.listen(PORT, () => {
  console.log(`[payment-api] Co-insurance payment API running on port ${PORT}`);
});
