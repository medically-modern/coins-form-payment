// Run: npm test  (node --test, no dependency added)
//
// ⚠️ This repo has NO out-of-pocket estimator, on purpose. CLAUDE.md §5: the
// Stedi backend owns every OOP number and writes it to Monday; this page shows
// the adjudicated ERA and takes the payment. The estimator that used to live in
// src/lib/oopEstimator.ts was a hand-synced copy of the backend's rate table
// and payer sets, reachable only through a card nothing mounted — removed
// 2026-10-07. This test fails the moment somebody ports one back.

const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, readdirSync, readFileSync, statSync } = require("node:fs");
const { join, relative } = require("node:path");

const SRC = join(__dirname, "..", "..", "src");

/* The three files the overhaul deleted. A path is cheaper to assert than a
   token, and a reappearance under the old name is the likeliest shape of a
   re-port. */
const REMOVED = [
  "lib/oopEstimator.ts",
  "components/OopEstimateCard.tsx",
  "lib/types.ts",
];

/* Identifiers from the deleted estimator — the rate table, the payer sets,
   the override map, the entry point — plus the rate-table key shape itself.
   Deliberately NOT the words "coinsurance" or "deductible": the ERA display
   legitimately shows both, as columns the secondary payer adjudicated. */
const FORBIDDEN = [
  /PAYER_RATE_SCHEDULE/,
  /ZERO_OOP_PAYERS/,
  /PRIMARY_MEDICAID_LABELS/,
  /COINSURANCE_OVERRIDES/,
  /MEDICARE_STYLE_INFUSION_PAYERS/,
  /AETNA_STYLE_PAYERS/,
  /SUPPLIES_ROUTE_TO_MEDICAID/,
  /\bestimateOop\b/,
  /oopEstimator/,
  /OopEstimateCard/,
  /\b(pump|infusion|cartridge|monitor|sensor)_rate\b/,
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|jsx)$/.test(name)) out.push(p);
  }
  return out;
}

/* Comments stripped first, so a note explaining what must NOT be here does not
   itself trip the scan (the same convention as cashPayWebhookRoute.test.js). */
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("the estimator, its card and its Patient type stay deleted", () => {
  for (const rel of REMOVED) {
    assert.equal(existsSync(join(SRC, rel)), false, `src/${rel} is back`);
  }
});

test("nothing under src/ carries a rate table, a payer set or an estimator", () => {
  const files = walk(SRC);
  assert.ok(files.length > 0, "src/ scan found no source files — wrong path?");
  for (const file of files) {
    const code = stripComments(readFileSync(file, "utf8"));
    for (const re of FORBIDDEN) {
      assert.equal(
        re.test(code), false,
        `${relative(SRC, file)} matches ${re} — OOP math belongs in the Stedi backend, not here (CLAUDE.md §5)`,
      );
    }
  }
});
