// The Friday forward is wired, not just written: on the real cash pay Monday client (fetch stubbed, nothing leaves the
// process), a write Monday accepted on the New Order Board is queued for Friday and Monday's answer comes back
// unchanged; a read, a refused write and an answer with no data never are. And a scan: cash pay has one Monday path, and
// the Secondary Claims modules (../monday.js, ../smsQueue.js) carry no forward, since Friday doesn't copy that board.
const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const read = (p) => readFileSync(join(__dirname, "..", p), "utf8");
const ORDERS = "18405457690";

Object.assign(process.env, { FRIDAY_FORWARD: "1", FRIDAY_URL: "https://friday.test", FRIDAY_API_KEY: "fk_live_test", FRIDAY_BOARD_IDS: ORDERS, MONDAY_TOKEN: "test" });
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

test("cash pay has one Monday path, and the Secondary Claims modules carry no forward", () => {
  const src = read("src/cashPay/monday.js");
  assert.equal((src.match(/await fetch\(/g) || []).length, 1, "query() is the one call");
  const q = src.slice(src.indexOf("async function query("), src.indexOf("const WRITE"));
  const hook = q.indexOf("fridayForward.onMutation({ query: gql, variables, data: data.data })");
  assert.ok(hook > q.indexOf("if (data.errors) throw"), "only after Monday's errors have been read");
  assert.ok(hook < q.lastIndexOf("return data.data;"), "and before the answer is returned");
  for (const f of ["src/monday.js", "src/smsQueue.js"]) assert.doesNotMatch(read(f), /fridayForward/, `${f} writes Secondary Claims, which Friday doesn't copy`);
  assert.match(read("src/index.js"), /friday: require\("\.\/cashPay\/monday"\)\.fridayForward\.status\(\)/, "/health says whether it is on");
});
