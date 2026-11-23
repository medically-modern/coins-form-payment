// Run: npm test  (node --test, no dependency added)
//
// backend/src/ntfy.js: every push keeps its title, priority and tags and adds
// exactly one lvl-error / lvl-warn / lvl-info tag for the Command Center alerts page.

const test = require("node:test");
const assert = require("node:assert/strict");

const { notify, levelFor, tagsWithLevel } = require("../src/ntfy");

test("level follows priority unless given", () => {
  assert.equal(levelFor("high"), "warn");
  assert.equal(levelFor("5"), "error");
  assert.equal(levelFor("default"), "info");
  assert.equal(levelFor("high", "error"), "error");
  assert.equal(tagsWithLevel("rotating_light", "high", "error"), "rotating_light,lvl-error");
  assert.equal(tagsWithLevel("", "default"), "lvl-info");
});

test("notify appends the lvl tag and changes nothing else", async () => {
  const saved = { url: process.env.NTFY_URL, topic: process.env.NTFY_TOPIC, fetch: globalThis.fetch };
  const calls = [];
  process.env.NTFY_URL = "https://ntfy.invalid";
  process.env.NTFY_TOPIC = "t";
  globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200 }; };
  try {
    await notify({ title: "x", body: "b", priority: "high", tags: "rotating_light", level: "error" });
    await notify({ title: "y", body: "b", priority: "default", tags: "white_check_mark", level: "info" });
    assert.equal(calls[0].url, "https://ntfy.invalid/t");
    assert.deepEqual(calls[0].opts.headers, { Title: "x", Priority: "high", Tags: "rotating_light,lvl-error" });
    assert.equal(calls[1].opts.headers.Tags, "white_check_mark,lvl-info");
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.url === undefined) delete process.env.NTFY_URL; else process.env.NTFY_URL = saved.url;
    if (saved.topic === undefined) delete process.env.NTFY_TOPIC; else process.env.NTFY_TOPIC = saved.topic;
  }
});
