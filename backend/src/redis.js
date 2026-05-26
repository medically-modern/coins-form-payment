const Redis = require("ioredis");

const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    return Math.min(times * 200, 5000);
  },
});

redis.on("error", (err) => console.error("[redis] Error:", err.message));
redis.on("connect", () => console.log("[redis] Connected"));

// ─── Payment token storage (PRD key pattern) ───
// pay-secondary:token:<uuid> → JSON { mondayItemId, boardId, createdAt, stripeSessionId?, paidAt?, paidAmount?, stripeChargeId? }
// pay-secondary:item:<itemId> → token (reverse lookup, idempotent — same item always gets same token)
// pay-secondary:log:<token>  → list of events (90d TTL)

const TOKEN_PREFIX = "pay-secondary:token:";
const ITEM_PREFIX = "pay-secondary:item:";
const LOG_PREFIX = "pay-secondary:log:";
const LOG_TTL = 86400 * 90; // 90 days

async function storePaymentToken(token, itemId, boardId, ttl) {
  const data = JSON.stringify({
    mondayItemId: String(itemId),
    boardId: String(boardId),
    createdAt: new Date().toISOString(),
  });

  // Store token → data + reverse lookup item → token
  await Promise.all([
    redis.set(`${TOKEN_PREFIX}${token}`, data, "EX", ttl),
    redis.set(`${ITEM_PREFIX}${itemId}`, token, "EX", ttl),
  ]);

  await logEvent(token, "token_created", { itemId, boardId });
}

async function getPaymentToken(token) {
  const raw = await redis.get(`${TOKEN_PREFIX}${token}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // Legacy format: plain string UID — treat as itemId
    return { mondayItemId: raw };
  }
}

async function getTokenForItem(itemId) {
  return redis.get(`${ITEM_PREFIX}${itemId}`);
}

async function markTokenPaid(token, { stripeSessionId, stripeChargeId, paidAmount }) {
  const raw = await redis.get(`${TOKEN_PREFIX}${token}`);
  if (!raw) return false;

  let data;
  try { data = JSON.parse(raw); } catch { data = { mondayItemId: raw }; }

  data.stripeSessionId = stripeSessionId;
  data.stripeChargeId = stripeChargeId;
  data.paidAmount = paidAmount;
  data.paidAt = new Date().toISOString();

  // Keep original TTL
  const ttl = await redis.ttl(`${TOKEN_PREFIX}${token}`);
  await redis.set(`${TOKEN_PREFIX}${token}`, JSON.stringify(data), "EX", ttl > 0 ? ttl : 86400 * 30);

  await logEvent(token, "payment_completed", { stripeChargeId, paidAmount });
  return true;
}

// ─── Idempotency: check if charge ID already processed ───

async function isChargeProcessed(stripeChargeId) {
  const raw = await redis.get(`pay-secondary:charge:${stripeChargeId}`);
  return !!raw;
}

async function markChargeProcessed(stripeChargeId, itemId) {
  await redis.set(`pay-secondary:charge:${stripeChargeId}`, String(itemId), "EX", 86400 * 90);
}

// ─── Event logging ───

async function logEvent(token, event, data = {}) {
  const entry = JSON.stringify({ event, ...data, timestamp: new Date().toISOString() });
  const key = `${LOG_PREFIX}${token}`;
  await redis.rpush(key, entry);
  await redis.expire(key, LOG_TTL);
}

// ─── Auth rate limiting ───

async function checkAuthRateLimit(key, maxRequests, windowSeconds) {
  const redisKey = `auth_rate:${key}`;
  const current = await redis.incr(redisKey);
  if (current === 1) {
    await redis.expire(redisKey, windowSeconds);
  }
  return current <= maxRequests;
}

// ─── Session blacklist (for logout) ───

async function blacklistSession(jti, expiresInSeconds) {
  await redis.set(`blacklist:${jti}`, "1", "EX", expiresInSeconds);
}

async function isSessionBlacklisted(jti) {
  const val = await redis.get(`blacklist:${jti}`);
  return val === "1";
}

// ─── Health check ───

async function healthCheck() {
  try {
    await redis.ping();
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  redis,
  storePaymentToken, getPaymentToken, getTokenForItem, markTokenPaid,
  isChargeProcessed, markChargeProcessed,
  logEvent,
  checkAuthRateLimit,
  blacklistSession, isSessionBlacklisted,
  healthCheck,
};
