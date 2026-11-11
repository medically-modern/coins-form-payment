// The Friday forward is wired, not just written: on the real Monday clients (fetch stubbed, nothing leaves the process), a
// write Monday accepted on the New Order Board (cash pay) or the Secondary Claims Board (the coinsurance pay link and
// payment, which Friday copies from 2026-11-11) is queued for Friday, as sent, and Monday's answer comes back unchanged; a
// read, a refused write and an answer with no data never are. And a scan: every Monday write path hands its accepted
// writes to the one instance in ../src/friday.js, after Monday's errors have been read.
const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const read = (p) => readFileSync(join(__dirname, "..", p), "utf8");
const ORDERS = "18405457690", SECONDARY = "18413019028";

Object.assign(process.env, { FRIDAY_FORWARD: "1", FRIDAY_URL: "https://friday.test", FRIDAY_API_KEY: "fk_live_test", FRIDAY_BOARD_IDS: `${ORDERS},${SECONDARY}`, MONDAY_TOKEN: "test" });
const mondayAnswers = [];
const fridayCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url) === "https://api.monday.com/v2") return new Response(JSON.stringify(mondayAnswers.shift()(JSON.parse(init.body))), { status: 200, headers: { "content-type": "application/json" } });
  fridayCalls.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
  return new Response(JSON.stringify({ applied: 1, operations: [] }), { status: 200, headers: { "content-type": "application/json" } });
};
const monday = require("../src/cashPay/monday");
const fwd = monday.fridayForward;
fwd.stop();
const drain = async () => { for (let i = 0; i < 20 && fwd.queue.length; i++) await fwd.tick(); };
test.after(() => { globalThis.fetch = realFetch; fwd.stop(); });

test("a write Monday accepted on the order board reaches Friday as sent, with Monday's answer", async () => {
  assert.equal(fwd.enabled, true);
  mondayAnswers.push((body) => ({ data: { change_column_value: { id: body.variables.itemId } } }));
  await monday.stampCashPayLinkSent("13100000001", "2026-11-06");
  assert.equal(fwd.queue.length, 1);
  await drain();
  assert.equal(fridayCalls.length, 1);
  assert.equal(fridayCalls[0].url, "https://friday.test/v1/monday/write");
  assert.equal(fridayCalls[0].body.variables.boardId, ORDERS);
  assert.deepEqual(fridayCalls[0].body.data, { change_column_value: { id: "13100000001" } });
  assert.match(fridayCalls[0].headers["idempotency-key"], /^coins-form-payment-/);
});

test("a read, a refused write and an answer with no data never reach Friday; the refusal still throws", async () => {
  fridayCalls.length = 0;
  mondayAnswers.push(() => ({ data: { items: [{ id: "1", name: "x", board: { id: ORDERS }, column_values: [] }] } }));
  await monday.getOrder("1");
  mondayAnswers.push(() => ({ errors: [{ message: "ColumnValueException" }] }));
  await assert.rejects(() => monday.stampCashPayLinkSent("2", "2026-11-06"), /ColumnValueException/);
  mondayAnswers.push(() => ({ error_message: "Internal server error" }));
  await monday.stampCashPayLinkSent("3", "2026-11-06");
  assert.equal(fwd.queue.length, 0);
  await drain();
  assert.equal(fridayCalls.length, 0);
});

test("the coinsurance writes Monday accepted on Secondary Claims reach Friday as sent; a read and a refusal never do", async () => {
  const secondary = require("../src/monday");
  fridayCalls.length = 0;
  const ok = (body) => ({ data: { change_column_value: { id: body.variables.itemId } } });
  for (let i = 0; i < 6; i++) mondayAnswers.push(ok);
  await secondary.storePaymentLinkInMonday("13100000021", "tok", "https://invoice.example/pay/tok");
  await secondary.recordPaymentInMonday("13100000021", { amount: 12.5, stripeChargeId: "ch_test", email: "" });
  assert.equal(fwd.queue.length, 6, "two pay-link writes and four payment writes");
  mondayAnswers.push(() => ({ data: { items: [] } }));
  await secondary.getItemById("13100000021");
  mondayAnswers.push(() => ({ errors: [{ message: "ColumnValueException" }] }));
  await assert.rejects(() => secondary.writeDate("13100000022", "date_x", "2026-11-11"), /ColumnValueException/);
  assert.equal(fwd.queue.length, 6);
  mondayAnswers.length = 0;
  await drain();
  assert.equal(fridayCalls.length, 6);
  assert.ok(fridayCalls.every((c) => c.url === "https://friday.test/v1/monday/write" && c.body.variables.boardId === SECONDARY && c.body.variables.itemId === "13100000021"));
  assert.ok(fridayCalls.every((c) => /change_column_value/.test(c.body.query)));
  assert.equal(secondary.fridayForward ?? require("../src/friday").fridayForward, fwd, "one instance for the whole service");
});

test("every Monday write path hands its accepted writes to the one forward, after Monday's errors are read", () => {
  const src = read("src/cashPay/monday.js");
  assert.equal((src.match(/await fetch\(/g) || []).length, 1, "query() is the one call");
  const q = src.slice(src.indexOf("async function query("), src.indexOf("const WRITE"));
  const hook = q.indexOf("fridayForward.onMutation({ query: gql, variables, data: data.data })");
  assert.ok(hook > q.indexOf("if (data.errors) throw"), "only after Monday's errors have been read");
  assert.ok(hook < q.lastIndexOf("return data.data;"), "and before the answer is returned");
  assert.match(src, /require\("\.\.\/friday"\)/, "cash pay uses the service's one instance");
  const m = read("src/monday.js");
  assert.equal((m.match(/await fetch\(/g) || []).length, 1, "mondayQuery() is the coinsurance client's one call");
  const mq = m.slice(m.indexOf("async function mondayQuery("), m.indexOf("// ─── Write helpers"));
  const mh = mq.indexOf("fridayForward.onMutation({ query, variables, data: data.data })");
  assert.ok(mh > mq.indexOf("if (data.errors)") && mh < mq.lastIndexOf("return data.data;"), "the coinsurance client forwards after Monday's errors");
  const sq = read("src/smsQueue.js");
  const ws = sq.slice(sq.indexOf("async function writeSmsStatus("), sq.indexOf("// ─── Enqueue a text"));
  const sh = ws.indexOf("fridayForward.onMutation({ query, variables, data: data.data })");
  assert.ok(sh > ws.indexOf("if (data.errors)"), "the SMS status write forwards only what Monday accepted");
  assert.equal((sq.match(/fetch\("https:\/\/api\.monday\.com/g) || []).length, 1, "writeSmsStatus is the SMS queue's one Monday call");
  for (const f of ["src/monday.js", "src/cashPay/monday.js"]) assert.doesNotMatch(read(f), /createFridayForward/, `${f} uses ../friday.js, never an instance of its own`);
  assert.match(read("src/index.js"), /friday: require\("\.\/cashPay\/monday"\)\.fridayForward\.status\(\)/, "/health says whether it is on");
});
