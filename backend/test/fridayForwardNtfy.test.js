// Run: npm test  (node --test, no dependency added)
//
// The Friday forward's built-in ntfy push keeps its title, priority and warning
// tag and adds exactly one lvl-* tag (Command Center alerts page).

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ntfyAlert } = require("../src/fridayForward.js");

test("the ntfy push keeps its title, priority and warning tag and adds exactly one lvl-* tag", async () => {
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push({ url, headers: init.headers, body: init.body }); return new Response("{}", { status: 200 }); };
  const push = ntfyAlert({ NTFY_URL: "https://ntfy.test/", NTFY_TOPIC: "t" }, fetchImpl);
  await push("svc: a Friday forward gave up", "body", "error");
  await push("svc: queue full", "body", "warn");
  await push("svc: hello", "body");
  assert.deepEqual(sent.map((c) => c.headers.Tags), ["warning,lvl-error", "warning,lvl-warn", "warning,lvl-warn"]);
  assert.equal(sent[0].headers.Priority, "default"); assert.equal(sent[0].headers.Title, "svc: a Friday forward gave up");
  assert.equal(sent[0].url, "https://ntfy.test/t"); assert.equal(sent[0].body, "body");
  assert.equal(ntfyAlert({}, fetchImpl), null);
});
