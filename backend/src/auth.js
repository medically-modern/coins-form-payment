const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { AUTH, SECONDARY_BOARD_ID } = require("./config");
const {
  storePaymentToken, getPaymentToken, getTokenForItem,
  checkAuthRateLimit, blacklistSession, isSessionBlacklisted,
  logEvent,
} = require("./redis");

const JWT_SECRET = process.env.JWT_SECRET;

// ═══════════════════════════════════════════════════════
// PAYMENT TOKEN AUTH FLOW (Secondary Board)
// ═══════════════════════════════════════════════════════
//
// 1. Operator clicks "Send to Patient" → admin endpoint creates token
//    mapped to Monday item ID → stored in Redis + Monday columns
// 2. Monday automation texts patient the link
// 3. Patient clicks link → token verified → JWT session issued
// 4. Patient sees ERA breakdown → pays via Stripe Checkout
//
// Idempotent: if a token already exists for the item, return it.
// Token is REUSABLE until TTL expires (30 days).

async function generatePaymentToken(itemId) {
  // Idempotent — check if item already has a token
  const existing = await getTokenForItem(itemId);
  if (existing) {
    console.log(`[auth] Returning existing token for item ${itemId}`);
    return existing;
  }

  const token = crypto.randomBytes(AUTH.TOKEN_BYTES).toString("hex");
  await storePaymentToken(token, itemId, SECONDARY_BOARD_ID, AUTH.TOKEN_TTL);
  console.log(`[auth] Payment token generated for item ${itemId}`);
  return token;
}

async function verifyPaymentToken(token) {
  if (!token || token.length !== AUTH.TOKEN_BYTES * 2) {
    return { error: "Invalid link", status: 400 };
  }

  const tokenPrefix = token.slice(0, 8);
  const allowed = await checkAuthRateLimit(`token:${tokenPrefix}`, AUTH.RATE_LIMIT_AUTH, AUTH.RATE_LIMIT_AUTH_WINDOW);
  if (!allowed) {
    return { error: "Too many attempts. Please try again later.", status: 429 };
  }

  const tokenData = await getPaymentToken(token);
  if (!tokenData) {
    return { error: "This link has expired or is invalid. Please contact us for a new one.", status: 401 };
  }

  const itemId = tokenData.mondayItemId || tokenData;
  const jti = crypto.randomUUID();
  const jwtToken = jwt.sign(
    { itemId, jti, purpose: "payment", paymentToken: token },
    JWT_SECRET,
    { expiresIn: AUTH.JWT_EXPIRY, issuer: "mm-pay-secondary" }
  );

  await logEvent(token, "token_verified", { itemId });
  console.log(`[auth] Payment session created for item ${itemId} (jti: ${jti})`);

  return {
    success: true,
    jwt: jwtToken,
    itemId,
    isPaid: !!tokenData.paidAt,
    expiresIn: AUTH.JWT_EXPIRY,
  };
}

function requireAuth(req, res, next) {
  let token = req.cookies?.session;
  if (!token) {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      token = authHeader.slice(7);
    }
  }
  if (!token) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET, { issuer: "mm-pay-secondary" });
    req.itemId = payload.itemId;
    // Backward compat: if old JWT has uid instead of itemId
    if (!req.itemId && payload.uid) req.itemId = payload.uid;
    req.jti = payload.jti;
    req.paymentToken = payload.paymentToken;

    isSessionBlacklisted(payload.jti).then((blacklisted) => {
      if (blacklisted) {
        return res.status(401).json({ error: "Session expired" });
      }
      next();
    });
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Session expired. Please use your original link to start a new session." });
    }
    return res.status(401).json({ error: "Invalid session" });
  }
}

async function logout(jti, exp) {
  const remaining = exp - Math.floor(Date.now() / 1000);
  if (remaining > 0) {
    await blacklistSession(jti, remaining);
  }
}

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "none",
  maxAge: 24 * 60 * 60 * 1000,
  path: "/",
};

module.exports = {
  generatePaymentToken,
  verifyPaymentToken,
  requireAuth,
  logout,
  COOKIE_OPTIONS,
};
