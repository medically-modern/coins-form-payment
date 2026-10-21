// Run: npm test  (node --test, no dependency added)
//
// The Redis watchdog (backend/src/redisWatch.js): one alert after three failed
// pings in a row, a reminder an hour later while it stays down, one "back"
// alert when Redis answers again, nothing at all for a blip under the
// threshold, and a ping that never answers counted as a failure.

const test = require("node:test");
const assert = require("node:assert/strict");

const { createRedisWatch } = require("../src/redisWatch");

function harness({ threshold = 3, repeatMs = 60 * 60_000, timeoutMs = 50 } = {}) {
  let t = Date.UTC(2026, 9, 20, 3, 36);
  let up = true;
  let hang = false;
  const sent = [];
  const watch = createRedisWatch({
    ping: () => (hang ? new Promise(() => {}) : up ? Promise.resolve("PONG") : Promise.reject(new Error("connect ETIMEDOUT"))),
    notify: async (m) => { sent.push(m); },
    now: () => t,
    threshold, repeatMs, timeoutMs,
  });
  return {
    watch, sent,
    down() { up = false; hang = false; },
    hangs() { hang = true; },
    upAgain() { up = true; hang = false; },
    advance(ms) { t += ms; },
  };
}

test("a blip under the threshold sends nothing", async () => {
  const h = harness();
  h.down();
  await h.watch.check(); h.advance(60_000);
  await h.watch.check(); h.advance(60_000);
  h.upAgain();
  await h.watch.check();
  assert.equal(h.sent.length, 0);
  assert.equal(h.watch.state.ok, true);
});

test("three failures in a row send one alert, with the time it went down", async () => {
  const h = harness();
  h.down();
  for (let i = 0; i < 5; i++) { await h.watch.check(); h.advance(60_000); }
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].title, /can't reach Redis/);
  assert.match(h.sent[0].body, /2026-10-20T03:36:00\.000Z/);
  assert.match(h.sent[0].body, /connect ETIMEDOUT/);
  assert.equal(h.sent[0].priority, "high");
});

test("it reminds every repeatMs while Redis stays down", async () => {
  const h = harness();
  h.down();
  for (let i = 0; i < 3; i++) { await h.watch.check(); h.advance(60_000); }
  assert.equal(h.sent.length, 1);
  for (let i = 0; i < 60; i++) { await h.watch.check(); h.advance(60_000); }
  assert.equal(h.sent.length, 2);
});

test("Redis answering again after an alert sends one recovery alert", async () => {
  const h = harness();
  h.down();
  for (let i = 0; i < 3; i++) { await h.watch.check(); h.advance(60_000); }
  h.upAgain();
  await h.watch.check(); h.advance(60_000);
  await h.watch.check();
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[1].title, /reached Redis again/);
  assert.equal(h.watch.state.downSince, null);
});

test("a ping that never answers counts as a failure", async () => {
  const h = harness({ threshold: 1 });
  h.hangs();
  await h.watch.check();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].body, /no answer in 50 ms/);
});

test("a failing notify never throws into the check", async () => {
  const watch = createRedisWatch({
    ping: () => Promise.reject(new Error("down")),
    notify: async () => { throw new Error("ntfy unreachable"); },
    threshold: 1, timeoutMs: 50,
  });
  await assert.doesNotReject(watch.check());
});

test("no alert carries more than Redis's own error text", async () => {
  const h = harness({ threshold: 1 });
  h.down();
  await h.watch.check();
  // Fixed wording plus times, counts and the error: nothing about a patient.
  assert.doesNotMatch(h.sent[0].body, /item|pulse|\$\d/i);
});
