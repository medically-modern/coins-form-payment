const Redis = require("ioredis");

const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    return Math.min(times * 200, 5000);
  },
});

redis.on("error", (err) => console.error("[redis] Error:", err.message));
redis.on("connect", () => console.log("[redis] Connected"));

// ─── Payment token storage ───

async function storePaymentToken(token, uid, ttl) {
  await redis.set(`payment:${token}`, uid, "EX", ttl);
}

async function getPaymentToken(token) {
  return redis.get(`payment:${token}`);
}

async function deletePaymentToken(token) {
  await redis.del(`payment:${token}`);
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
  storePaymentToken, getPaymentToken, deletePaymentToken,
  checkAuthRateLimit,
  blacklistSession, isSessionBlacklisted,
  healthCheck,
};
