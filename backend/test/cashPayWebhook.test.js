// The one behavioural guarantee of the integration: a cash pay session is
// handled here and a coinsurance session is NOT — and the coinsurance branch
// in `backend/src/index.js` runs only when this one declines.
//
// ⚠️ The two must never both run on one session: this flow writes the New Order
// Board, that one writes Secondary Claims, and each would be writing the
// other's board with an item id that means nothing on it.

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const { handleStripeSession } = require("../src/cashPay");

const read = (p) => readFileSync(join(__dirname, "..", p), "utf8");

test("⚠️ it declines a pay-secondary session, without touching Monday", async () => {
  /* No monday mock is needed and that is the point: the discriminator is
     checked before anything is read or written, so a coinsurance session
     cannot reach the order board even by accident. */
  assert.equal(await handleStripeSession({
    id: "cs_1", metadata: { service: "pay-secondary", itemId: "999" },
  }), false);
});

test("⚠️ it declines a session with no service at all", async () => {
  /* A session minted before this flow existed, or by hand in the dashboard.
     Silence is right: it belongs to whatever made it, not to us. */
  assert.equal(await handleStripeSession({ id: "cs_2", metadata: {} }), false);
  assert.equal(await handleStripeSession({ id: "cs_3" }), false);
  assert.equal(await handleStripeSession(null), false);
});

test("⚠️ a cash pay session with no itemId is CLAIMED, not passed on", async () => {
  /* It is unattributable and that is worth a log line — but handing it to the
     coinsurance branch would have that branch write Secondary Claims for a
     cash payment. Ours, and stuck, beats theirs and wrong. */
  assert.equal(await handleStripeSession({
    id: "cs_4", metadata: { service: "cash-pay" },
  }), true);
});

test("⚠️ index.js branches on the service and RETURNS", () => {
  /* Source scan: without the return, both branches run on one session. */
  const src = read("src/index.js");
  const at = src.indexOf('if (session.metadata?.service === "cash-pay")');
  assert.ok(at > -1, "the cash pay branch is missing from /webhook/stripe");
  const branch = src.slice(at, at + 900);
  assert.match(branch, /cashPay\.handleStripeSession\(session\)/);
  assert.match(branch, /return res\.json\(\{ received: true, service: "cash-pay" \}\)/);
  /* A failure must be a 500 so Stripe retries — a payment taken and not
     recorded leaves the ordering gate holding an order already paid for. */
  assert.match(branch, /return res\.status\(500\)/);
  /* And it must come BEFORE the coinsurance branch reads its itemId. */
  const secondary = src.indexOf("const itemId = session.metadata?.itemId;", at);
  assert.ok(secondary > at, "the cash pay branch must come first");
});

test("⚠️ the route is mounted behind the rate limiters", () => {
  /* An endpoint that mints Stripe payment links must not be the one route in
     this service that skips rate limiting. */
  const src = read("src/index.js");
  const globalAt = src.indexOf("app.use(globalLimiter);");
  const jsonAt = src.indexOf("app.use(express.json());");
  const mountAt = src.indexOf("cashPay.register(app,");
  assert.ok(globalAt > -1 && jsonAt > -1 && mountAt > -1);
  assert.ok(mountAt > globalAt, "mounted before the global limiter");
  assert.ok(mountAt > jsonAt, "mounted before express.json(), so req.body is unparsed");
  assert.match(src.slice(mountAt, mountAt + 120), /limiter: cashPayLimiter/);
});

test("⚠️ the Stripe webhook still sits ABOVE express.json()", () => {
  /* It needs the raw body to verify a signature (CLAUDE.md §6). Adding the
     cash pay branch inside it must not have moved it. */
  const src = read("src/index.js");
  assert.ok(src.indexOf('app.post("/webhook/stripe"') < src.indexOf("app.use(express.json());"));
});

test("⚠️ the cash pay flow never reaches the Secondary Claims board", () => {
  /* `smsQueue` and `monday.js` are bound to that board and take any itemId;
     feeding either an order-board id writes the wrong board. */
  for (const f of ["src/cashPay/index.js", "src/cashPay/monday.js", "src/cashPay/rules.js", "src/cashPay/config.js"]) {
    const src = read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.equal(/SECONDARY_BOARD_ID|require\("\.\.\/monday"\)|require\("\.\.\/smsQueue"\)/.test(src), false,
      `${f} reaches the Secondary Claims board`);
  }
});
