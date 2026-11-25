// The Friday read shadow is wired, not just written: on the real Monday clients (fetch stubbed, nothing leaves the process),
// a READ Monday answered with data on the New Order Board (cash pay) or the Secondary Claims Board (coinsurance) is handed to
// Friday's /v2/shadow on a later turn, after the caller has Monday's answer unchanged, never awaited; only the final try of a
// retry, and never a mutation, a refusal or an answer with no data. And a scan: both clients hand their reads to the one
// instance in ../src/friday.js, after Monday's errors have been read. No payment is touched.
const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const read = (p) => readFileSync(join(__dirname, "..", p), "utf8");
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
const ORDERS = "18405457690";

Object.assign(process.env, { FRIDAY_SHADOW: "1", FRIDAY_URL: "https://friday.test", FRIDAY_API_KEY: "fk_live_test", MONDAY_TOKEN: "test" });
delete process.env.FRIDAY_FORWARD;
delete process.env.MONDAY_API_URL;
const answers = [];
const mondayCalls = [];
const shadow = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url) === "https://friday.test/v2/shadow") {
    shadow.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ outcome: "same" }), { status: 200 });
  }
  if (String(url) !== "https://api.monday.com/v2") throw new Error(`unexpected fetch ${url}`);
  mondayCalls.push(JSON.parse(init.body));
  const [status, body] = answers.shift();
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
};
const cashPay = require("../src/cashPay/monday");
const secondary = require("../src/monday");
const { fridayShadow, fridayForward } = require("../src/friday");
fridayForward.stop();
test.after(() => { globalThis.fetch = realFetch; });

test("a cash pay read reaches Friday after the caller has its answer; a write, a refusal and an empty answer never do", async () => {
  assert.equal(fridayShadow.enabled, true);
  const order = { data: { items: [{ id: "1", name: "x", board: { id: ORDERS }, column_values: [] }] } };
  answers.push([200, JSON.stringify(order)]);
  await cashPay.getOrder("1");
  assert.equal(shadow.length, 0, "nothing handed over in the caller's turn");
  await settle();
  assert.equal(shadow.length, 1);
  assert.equal(shadow[0].reader, "coins-form-payment");
  assert.equal(shadow[0].query, mondayCalls[0].query);
  assert.deepEqual(shadow[0].monday.body, order);
  assert.equal(shadow[0].api_version, "2024-10");

  answers.push([200, { data: { change_column_value: { id: "2" } } }]);
  await cashPay.stampCashPayLinkSent("2", "2026-11-06");
  answers.push([200, { errors: [{ message: "ColumnValueException" }] }]);
  await assert.rejects(() => cashPay.getOrder("3"), /ColumnValueException/);
  answers.push([200, { error_message: "Internal server error" }]);
  await cashPay.getOrder("4").catch(() => {});
  await settle();
  assert.equal(shadow.length, 1, "a write, a refused read and an answer with no data are never handed over");
});

test("a retried read is handed over once, with the final answer", async (t) => {
  const before = shadow.length;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const order = { data: { items: [{ id: "5", name: "x", board: { id: ORDERS }, column_values: [] }] } };
  answers.push([500, "busy"], [200, JSON.stringify(order)]);
  const p = cashPay.getOrder("5");
  await settle();
  t.mock.timers.tick(1600);
  await p;
  await settle();
  t.mock.timers.reset();
  assert.equal(shadow.length, before + 1, "one hand-off for the retried read");
  assert.equal(shadow.at(-1).monday.status, 200);
  assert.deepEqual(shadow.at(-1).monday.body, order);
});

test("a coinsurance read reaches Friday; a write never does", async () => {
  const before = shadow.length;
  answers.push([200, { data: { items: [] } }]);
  await secondary.getItemById("13100000021");
  answers.push([200, { data: { change_column_value: { id: "13100000022" } } }]);
  await secondary.writeDate("13100000022", "date_x", "2026-11-11");
  await settle();
  assert.equal(shadow.length, before + 1);
  assert.match(shadow.at(-1).query, /items/);
  assert.equal(fridayShadow.health().stats.same, shadow.length);
});

test("both clients hand their reads to the one instance, after Monday's errors, never awaited; /health shows it", () => {
  const friday = read("src/friday.js");
  assert.match(friday, /const fridayShadow = createFridayShadow\(\{ env: process\.env, log: console\.log, reader: "coins-form-payment" \}\);/);
  for (const [file, start, end] of [["src/monday.js", "async function mondayQuery(", "// ─── Write helpers"], ["src/cashPay/monday.js", "async function query(", "const WRITE"]]) {
    const src = read(file);
    const q = src.slice(src.indexOf(start), src.indexOf(end));
    const hook = q.indexOf("fridayShadow.onRead({");
    assert.ok(hook > q.indexOf("if (data.errors)"), `${file}: only after Monday's errors have been read`);
    assert.ok(hook > q.lastIndexOf("return " + (file.includes("cashPay") ? "query(" : "mondayQuery(")), `${file}: after every retry`);
    assert.ok(hook < q.lastIndexOf("return data.data;"), `${file}: before the answer is returned`);
    assert.equal((src.match(/fridayShadow\.onRead/g) || []).length, 1, `${file}: one hook`);
    assert.doesNotMatch(src, /await\s+fridayShadow|createFridayShadow/, `${file}: never awaited, and the service's one instance`);
    assert.equal((src.match(/await fetch\(/g) || []).length, 1, `${file}: still one Monday call`);
  }
  assert.doesNotMatch(read("src/fridayShadow.js"), /api\.monday\.com/, "the shadow names no Monday address");
  assert.match(read("src/index.js"), /friday_shadow: require\("\.\/friday"\)\.fridayShadow\.health\(\)/);
});
