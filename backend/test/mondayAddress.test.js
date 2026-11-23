// Monday's address is a setting (MONDAY_API_URL) whose default is today's address, so the January
// cutover to Friday is one variable and nothing changes until then. The two clients run for real
// with fetch stubbed (nothing leaves the process); smsQueue needs Redis to load, so it is read as source.
const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const CLIENTS = {
  "src/monday.js": (m) => m.writeDate("13100000001", "date_x", "2026-11-23"),
  "src/cashPay/monday.js": (m) => m.stampCashPayLinkSent("13100000001", "2026-11-23"),
};

async function urlsUsed(env) {
  const saved = { a: process.env.MONDAY_API_URL, ff: process.env.FRIDAY_FORWARD };
  delete process.env.MONDAY_API_URL; delete process.env.FRIDAY_FORWARD;
  Object.assign(process.env, { MONDAY_TOKEN: process.env.MONDAY_TOKEN || "test" }, env);
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push(String(url));
    const body = JSON.parse(init.body);
    return new Response(JSON.stringify({ data: { change_column_value: { id: body.variables.itemId } } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    for (const [file, call] of Object.entries(CLIENTS)) {
      const path = require.resolve(join("..", file));
      delete require.cache[path];
      await call(require(path));
      delete require.cache[path];
    }
    return seen;
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of [["MONDAY_API_URL", saved.a], ["FRIDAY_FORWARD", saved.ff]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test("unset, both clients call Monday's own address", async () => {
  assert.deepEqual(await urlsUsed({}), ["https://api.monday.com/v2", "https://api.monday.com/v2"]);
});

test("MONDAY_API_URL is read", async () => {
  assert.deepEqual(await urlsUsed({ MONDAY_API_URL: "https://friday.example/v2" }), ["https://friday.example/v2", "https://friday.example/v2"]);
});

test("the SMS queue's status write reads the same setting", () => {
  const src = readFileSync(join(__dirname, "..", "src", "smsQueue.js"), "utf8");
  assert.ok(src.includes('const MONDAY_API_URL = process.env.MONDAY_API_URL || "https://api.monday.com/v2";'));
  assert.deepEqual([...src.matchAll(/await fetch\(([^,]+),/g)].map((m) => m[1]), ["MONDAY_API_URL"]);
});
