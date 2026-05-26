const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { AUTH } = require("./config");
const {
  storePaymentToken, getPaymentToken,
  checkAuthRateLimit, blacklistSession, isSessionBlacklisted,
} = require("./redis");

const JWT_SECRET = process.env.JWT_SECRET;

// ═══════════════════════════════════════════════════════
// PAYMENT TOKEN AUTH FLOW
// ═══════════════════════════════════════════════════════
//
// Same pattern as the reorder service:
// 1. Admin generates a payment token → stored in Redis + Monday
// 2. Link is sent to patient (via Monday automation, text, etc.)
// 3. Patient clicks link → token verified → JWT session issued
// 4. Patient sees their pre-populated OOP estimate and pays
//
// Token is REUSABLE until TTL expires (30 days).

async function generatePaymentToken(uid) {
  const token = crypto.randomBytes(AUTH.TOKEN_BYTES).toString("hex");
  await storePaymentToken(token, uid, AUTH.TOKEN_TTL);
  console.log(`[auth] Payment token generated for UID ${uid}`);
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

  const uid = await getPaymentToken(token);
  if (!uid) {
    return { error: "This link has expired or is invalid. Please contact us for a new one.", status: 401 };
  }

  const jti = crypto.randomUUID();
  const jwtToken = jwt.sign(
    { uid, jti, purpose: "payment", paymentToken: token },
    JWT_SECRET,
    { expiresIn: AUTH.JWT_EXPIRY, issuer: "mm-coins-payment" }
  );

  console.log(`[auth] Payment session created for UID ${uid} (jti: ${jti})`);

  return {
    success: true,
    jwt: jwtToken,
    uid,
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
    const payload = jwt.verify(token, JWT_SECRET, { issuer: "mm-coins-payment" });
    req.uid = payload.uid;
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
