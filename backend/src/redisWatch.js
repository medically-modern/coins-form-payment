// ─── Redis watchdog: push an alert when this service can't reach its Redis ───
//
// Every pay link, every patient session, every rate limit and the SMS queue
// live in Redis (CLAUDE.md, top). On 2026-10-19 at 11:36pm ET Redis stopped
// answering after Railway re-attached its volume, every /webhook/monday call
// returned 500, and nobody knew until Brandon read the logs most of a day
// later: three rows sat in Send Invoice with no pay link, and Monday does not
// resend those webhooks. This is the alarm that was missing.
//
// It pings Redis on its own timer, with its own timeout, so it does not depend
// on a request arriving or on ioredis giving up. After `threshold` failed pings
// in a row it pushes one alert, again every `repeatMs` while it stays down,
// and one more when Redis answers again. Nothing in an alert names a patient:
// only times, counts and Redis's own error text.

const DEFAULTS = {
  intervalMs: 60_000,      // one ping a minute
  timeoutMs: 5_000,        // a ping that takes longer is a failure
  threshold: 3,            // three in a row (about two minutes) before alerting
  repeatMs: 60 * 60_000,   // remind every hour while it stays down
};

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * ping:   () => Promise — resolves when Redis answers
 * notify: ({ title, body, priority, tags }) => Promise — never expected to throw, but guarded
 * now:    () => ms
 */
function createRedisWatch({ ping, notify, now = Date.now, ...opts }) {
  const cfg = { ...DEFAULTS, ...opts };
  const state = {
    ok: null,             // null until the first ping
    failures: 0,          // failed pings in a row
    downSince: null,      // ms of the first failed ping in this run of failures
    lastError: null,
    lastOkAt: null,
    alertedAt: null,      // ms of the last "down" alert; null when none is outstanding
  };

  async function send(msg) {
    try { await notify(msg); } catch (e) { console.error("[redis-watch] alert failed:", e.message); }
  }

  async function check() {
    const t = now();
    try {
      await withTimeout(Promise.resolve().then(ping), cfg.timeoutMs);
    } catch (e) {
      state.ok = false;
      state.failures += 1;
      if (state.downSince === null) state.downSince = t;
      state.lastError = String(e?.message || e).split("\n")[0].slice(0, 200);
      const due = state.alertedAt === null
        ? state.failures >= cfg.threshold
        : t - state.alertedAt >= cfg.repeatMs;
      if (due) {
        state.alertedAt = t;
        const mins = Math.round((t - state.downSince) / 60_000);
        await send({
          title: "coins-form-payment can't reach Redis",
          body:
            `Down since ${new Date(state.downSince).toISOString()} (${mins} min, ${state.failures} failed pings). ` +
            `Pay links can't be minted, /webhook/monday answers 500 and Monday won't resend those webhooks, ` +
            `patients can't open their links, and texts can't be queued. ` +
            `Restart the Redis service in handsome-simplicity, then check this service reconnects. ` +
            `Last error: ${state.lastError}`,
          priority: "high",
          tags: "rotating_light",
        });
      }
      return state;
    }
    const wasDown = state.ok === false;
    const downFor = state.downSince === null ? 0 : t - state.downSince;
    const hadAlerted = state.alertedAt !== null;
    state.ok = true;
    state.failures = 0;
    state.downSince = null;
    state.lastError = null;
    state.lastOkAt = t;
    state.alertedAt = null;
    if (wasDown && hadAlerted) {
      await send({
        title: "coins-form-payment reached Redis again",
        body:
          `Redis answered after ${Math.round(downFor / 60_000)} min. ` +
          `Any row moved into Send Invoice while it was down still has no pay link: move it out and back in.`,
        priority: "default",
        tags: "white_check_mark",
      });
    }
    return state;
  }

  let timer = null;
  function start() {
    if (timer) return;
    check();
    timer = setInterval(check, cfg.intervalMs);
    timer.unref?.();
  }
  function stop() { clearInterval(timer); timer = null; }

  return { check, start, stop, state, timeoutMs: cfg.timeoutMs };
}

module.exports = { createRedisWatch, withTimeout, DEFAULTS };
