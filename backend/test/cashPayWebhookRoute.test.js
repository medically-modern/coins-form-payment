// The monday-webhook route: the pure rules it rests on, and the guards that
// are correctness rather than tidiness.
//
// ⚠️ This route MINTS A STRIPE PAYMENT LINK from a request nobody in this repo
// authored — a monday automation fires it. Every guard below is the difference
// between that being safe and being an open endpoint that charges patients, so
// each one is asserted against the source as well as the logic.

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const {
  centsFromAmountText, eventStatusLabel, boardLineItems, lineRefusal,
} = require("../src/cashPay/rules");
const {
  CASH_PAY_ACTION_INDEX, CASH_PAY_ACTION_GENERATE_LABEL, CASH_PAY_LINE_LABEL,
  ORDER_COLUMNS, LIMITS,
} = require("../src/cashPay/config");

const raw = readFileSync(join(__dirname, "..", "src/cashPay/index.js"), "utf8");

/* ⚠️ COMMENTS ARE STRIPPED BEFORE ANY SCAN. This file documents the very
   variable it must not use and the very ordering it must keep, so a raw-text
   scan fails on its own prose — and the only way to pass it would be to delete
   the explanation. */
const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/* Just the webhook handler, so an assertion about ordering inside it cannot
   match the helper declared above it. */
/* ⚠️ Anchored on the HANDLER, not on `app.post`. The route is registered twice —
   once bare and once as `/:secret`, because an API-created monday webhook does
   not deliver the query string it was registered with (see requireWebhookSecret).
   Slicing from `app.post` would start at whichever registration came first and
   read none of the handler. */
const routeBody = src.slice(src.indexOf("const cashPayWebhook = async"));

// ─── The amount, read off the row ───

test("it reads a two-decimal amount exactly, without ever floating it", () => {
  /* Debbie Hinze's real order. The Command Center's own note records that
     `Math.round(n * 100)` loses a cent on her infusion-set line, so this path
     never multiplies at all. */
  assert.equal(centsFromAmountText("1030.69"), 103069);
  assert.equal(centsFromAmountText("269.78"), 26978);
  assert.equal(centsFromAmountText("1,030.69"), 103069);
  assert.equal(centsFromAmountText("$1030.69"), 103069);
  assert.equal(centsFromAmountText(" 1030.69 "), 103069);
  assert.equal(centsFromAmountText("1030"), 103000);
  assert.equal(centsFromAmountText("1030.6"), 103060);
  assert.equal(centsFromAmountText(1030.69), 103069);
});

test("⚠️ an unreadable amount is null, NEVER zero", () => {
  /* Zero is a price. "We could not read the price" is not, and the two must
     not collapse — minting for a misread blank takes the wrong money. */
  for (const bad of ["", "   ", "—", "-", "abc", null, undefined, "1030.695", "1e3", "-5.00", {}]) {
    assert.equal(centsFromAmountText(bad), null, `should refuse ${JSON.stringify(bad)}`);
  }
  /* A genuine zero parses, and is then refused by the bounds — a different
     answer from "unreadable", reported differently to the rep. */
  assert.equal(centsFromAmountText("0"), 0);
  assert.notEqual(lineRefusal(boardLineItems(0), 0), "");
});

// ─── The single line ───

test("the board-minted link is one line that names the goods and never prices them", () => {
  const lines = boardLineItems(103069);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].label, CASH_PAY_LINE_LABEL);
  assert.equal(lines[0].quantity, 1);
  assert.equal(lines[0].amountCents, 103069);
  /* The label carries no number, so it cannot disagree with the amount however
     the quote was built. */
  assert.ok(!/\d/.test(CASH_PAY_LINE_LABEL), "the line label must not carry a figure");
  assert.equal(lineRefusal(lines, 103069), "");
  /* And the sum-equals-total rule still runs on it. */
  assert.notEqual(lineRefusal(lines, 103070), "");
});

test("the bounds still apply to a board-minted amount", () => {
  assert.notEqual(lineRefusal(boardLineItems(50), 50), "", "below the floor");
  assert.notEqual(
    lineRefusal(boardLineItems(LIMITS.MAX_TOTAL_CENTS + 1), LIMITS.MAX_TOTAL_CENTS + 1),
    "", "over the ceiling",
  );
});

// ─── The event's status label ───

test("it reads the status label out of monday's several payload shapes", () => {
  const col = ORDER_COLUMNS.CASH_PAY_ACTION;
  assert.equal(eventStatusLabel({ value: { label: { text: "Generate link" } } }, col), "Generate link");
  assert.equal(eventStatusLabel({ value: { label: "Generate link" } }, col), "Generate link");
  assert.equal(eventStatusLabel({ columnValues: { [col]: { label: { text: "Generate link" } } } }, col), "Generate link");
  assert.equal(eventStatusLabel({ columnValues: { [col]: { label: "Generate link" } } }, col), "Generate link");
});

test("⚠️ an unrecognised shape reads as NO label, so it cannot mint", () => {
  /* The caller mints on a match. Guessing in the permissive direction is how a
     "Send to patient" press mints a second link. */
  for (const e of [{}, { value: {} }, { value: { label: {} } }, { value: { label: 7 } }, null, undefined]) {
    assert.equal(eventStatusLabel(e, ORDER_COLUMNS.CASH_PAY_ACTION), "");
  }
  assert.notEqual(eventStatusLabel({ value: { label: "Send to patient" } }), CASH_PAY_ACTION_GENERATE_LABEL);
});

// ─── The label ids, which monday assigned ───

test("⚠️ the trigger label ids are the ones monday gave, not the ones asked for", () => {
  /* Read back from the live `settings_str`: monday derives a new label's id
     from its COLOUR, so these are 0 / 3 / 2 / 1 rather than 0 / 1 / 2 / 3. A
     write to an id the column does not have is accepted at 200 and dropped,
     silently.
     ⚠️ TEXT_FAILED is its own label, not a reuse of FAILED. "Stripe never gave
     us a link" and "the link exists and the patient did not get it" are
     different facts with different fixes; showing a rep the wrong one sends
     them to re-generate a link that is perfectly fine. */
  assert.deepEqual(CASH_PAY_ACTION_INDEX,
    { GENERATE: 0, SEND: 3, FAILED: 2, TEXT_FAILED: 1 });
  assert.equal(ORDER_COLUMNS.CASH_PAY_ACTION, "color_mm7e3rxj");
});

// ─── The guards, asserted against the source ───

test("the route is mounted, and inside register() where its deps are", () => {
  assert.match(src, /app\.post\(\s*"\/webhook\/monday\/cash-pay"/);
});

test("⚠️ the secret is required, and is NOT the coinsurance webhook's", () => {
  /* `MONDAY_WEBHOOK_SECRET` is unset on this service, so pay-secondary's own
     check is inert — and monday's automation sends no authorization header, so
     setting it would 401 the live coinsurance flow. Sharing the name would
     make turning auth on here break something else. */
  assert.match(src, /CASH_PAY_WEBHOOK_SECRET/);
  assert.ok(!/MONDAY_WEBHOOK_SECRET/.test(src), "must not reuse the coinsurance webhook's variable");
  /* Unset disables the route rather than leaving it open. */
  assert.match(src, /if \(!expected\) \{[\s\S]{0,300}?503/);
});

test("⚠️ the challenge handshake is answered before the secret check", () => {
  /* Monday posts it when the URL is saved, before anything is configured on
     their side; checking first would make the webhook unsaveable. */
  const challengeAt = routeBody.indexOf("req.body?.challenge");
  const secretAt = routeBody.indexOf("requireWebhookSecret(req, res)");
  assert.ok(challengeAt > -1 && secretAt > challengeAt, "challenge must come first");
});

test("⚠️ the label guard stops anything but the mint trigger", () => {
  assert.match(src, /label !== CASH_PAY_ACTION_GENERATE_LABEL/);
});

test("⚠️ a live link is returned, never replaced", () => {
  /* Two live links means the patient holds two, and paying the older one
     charges last week's price. */
  assert.match(routeBody, /if \(order\.cashPayLink\)/);
  const existingAt = routeBody.indexOf("if (order.cashPayLink)");
  const mintAt = routeBody.indexOf("stripe.paymentLinks.create", existingAt);
  assert.ok(mintAt > existingAt, "the existing-link branch must come before the mint");
});

test("⚠️ a refusal is written to the board and answered 200", () => {
  /* Monday retries a non-2xx and eventually stops delivering; a refusal is a
     fact about the order, not a broken endpoint. And a rep's only other signal
     is a link that never appears. */
  assert.match(src, /setCashPayAction\(itemId, CASH_PAY_ACTION_INDEX\.FAILED\)/);
  assert.match(src, /markFailed[\s\S]{0,400}?res\.json\(\{ ok: true, skipped: true/);
});

test("⚠️ the trigger is cleared only after the link is on the board", () => {
  /* Clearing is what re-arms the button — monday takes a status write onto its
     own value at 200 and fires nothing, so a column parked on "Generate link"
     makes every later press a silent no-op. Clearing early invites a second
     press that mints a second link. */
  const storeAt = routeBody.indexOf("await storeCashPayLink(order.itemId");
  const clearAt = routeBody.indexOf("await setCashPayAction(order.itemId, null)", storeAt);
  assert.ok(storeAt > -1 && clearAt > storeAt, "clear must follow the store");
});

/* ──────────────────────────────────────────────────────────────────────────
   Where the secret may arrive.

   ⚠️⚠️ Monday signs every webhook delivery with a JWT in `Authorization`. So a
   `header || query || path` chain always resolves to that JWT and the real key
   is never compared — a correctly-configured webhook is refused 401, looking
   for all the world like a wrong secret. Measured in production 2026-09-22:
   `?key=<secret>` → 401, `/cash-pay/<secret>` → 401, and the same path with no
   Authorization header → 200.

   An earlier pass read the first two as "monday drops the query string" and
   added the path form to work around it. Wrong — the path was delivered intact
   and shadowed just the same. Railway's HTTP log strips query strings, which is
   what made the wrong explanation fit.
   ────────────────────────────────────────────────────────────────────────── */

test("the route is registered on BOTH the bare path and /:secret", () => {
  assert.match(src, /app\.post\("\/webhook\/monday\/cash-pay",\s*cashPayWebhook\)/);
  assert.match(src, /app\.post\("\/webhook\/monday\/cash-pay\/:secret",\s*cashPayWebhook\)/);
});

test("both registrations share ONE handler", () => {
  // Two copies would drift, and the drift would be an auth check on one path
  // and not the other. ⚠️ Anchored with the closing quote/slash so it does not
  // also count the cash-pay-text pair.
  assert.equal((src.match(/const cashPayWebhook = async/g) || []).length, 1);
  assert.equal((src.match(/app\.post\("\/webhook\/monday\/cash-pay(?:"|\/:secret")/g) || []).length, 2);
});

test("⚠️⚠️ all three locations are CHECKED — none may shadow another", () => {
  // ⚠️ Comments are stripped FIRST: the ones on this function describe the very
  // shadowing it must not do, so a raw-text scan fails on its own explanation
  // and the only way to pass it is to delete the warning.
  const fn = src.slice(src.indexOf("function requireWebhookSecret"));
  const body = fn.slice(0, fn.indexOf("\n}"))
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  // All three are read into one list...
  const list = body.slice(body.indexOf("const candidates"), body.indexOf("];") + 2);
  assert.match(list, /req\.headers\.authorization/, "the header form must stay");
  assert.match(list, /req\.query\?\.key/, "the query form must stay");
  assert.match(list, /req\.params\?\.secret/, "the path form must stay");

  // ...and EVERY entry is compared. `.some` is the whole fix: the shape this
  // replaced was `const got = header || query`, which monday's own
  // Authorization JWT always won.
  assert.match(body, /candidates\.some\(/, "every candidate must be compared");
  assert.ok(!/const got\s*=/.test(body), "a single first-one-present variable is the bug");
});

test("⚠️ an absent secret is still a 503, not a 401", () => {
  // A route that mints Stripe payment links must fail loudly when it is
  // unconfigured, never look like a wrong password.
  const fn = src.slice(src.indexOf("function requireWebhookSecret"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  const notSet = body.indexOf("if (!expected)");
  const five03 = body.indexOf("503", notSet);
  const four01 = body.indexOf("401");
  assert.ok(notSet >= 0 && five03 > notSet, "unset secret must 503");
  assert.ok(four01 > five03, "the 401 is the wrong-secret case, and comes after");
});

/* ──────────────────────────────────────────────────────────────────────────
   The text route — POST /webhook/monday/cash-pay-text
   ────────────────────────────────────────────────────────────────────────── */

const textBody = src.slice(src.indexOf("const cashPayTextWebhook = async"));

test("the text route is registered on both paths, sharing one handler", () => {
  assert.equal((src.match(/const cashPayTextWebhook = async/g) || []).length, 1);
  assert.match(src, /app\.post\("\/webhook\/monday\/cash-pay-text",\s*cashPayTextWebhook\)/);
  assert.match(src, /app\.post\("\/webhook\/monday\/cash-pay-text\/:secret",\s*cashPayTextWebhook\)/);
});

test("⚠️ it fires on the SEND label only — a Generate press must not text", () => {
  // Both triggers watch the same column, so each route checks which one fired
  // rather than trusting monday's own filter.
  assert.match(textBody, /CASH_PAY_ACTION_SEND_LABEL/);
  assert.ok(!textBody.includes("CASH_PAY_ACTION_GENERATE_LABEL"),
    "the text route must not key on the mint trigger");
});

test("⚠️⚠️ it NEVER mints — nothing to send is a refusal", () => {
  // A send that also minted would let one press produce a link the rep has
  // never seen and a text quoting it in the same breath.
  assert.ok(!textBody.includes("paymentLinks.create"), "the text route must not create a link");
  assert.match(textBody, /if \(!order\.cashPayLink\)/, "a missing link must refuse");
  assert.match(textBody, /if \(!order\.phone\)/, "a missing phone must refuse");
});

test("⚠️ a refusal writes Text failed, never Link failed", () => {
  assert.match(textBody, /CASH_PAY_ACTION_INDEX\.TEXT_FAILED/);
  assert.ok(!textBody.includes("CASH_PAY_ACTION_INDEX.FAILED"),
    "Link failed would send a rep to re-generate a link that is fine");
});

test("⚠️ the sent date is stamped BEFORE the trigger is cleared", () => {
  // The card reads the stamp as "it went out" and the cleared trigger as "the
  // service is done". Clearing first leaves a window showing neither, and a rep
  // presses again.
  const stampAt = textBody.indexOf("stampCashPayLinkSent(order.itemId");
  const clearAt = textBody.indexOf("setCashPayAction(order.itemId, null)", stampAt);
  assert.ok(stampAt >= 0, "the stamp must happen");
  assert.ok(clearAt > stampAt, "clear must follow the stamp");
});

test("⚠️⚠️ it uses the board-agnostic sender, NEVER smsQueue", () => {
  // smsQueue is hardcoded to the Secondary Claims board — writeSmsStatus would
  // put this order's status on a claims row.
  assert.ok(!src.includes('require("../smsQueue")'), "smsQueue is the wrong board");
  assert.match(src, /require\("\.\.\/ringcentral"\)/);
  assert.match(textBody, /await sendSMS\(order\.phone/);
});

test("the wording lives beside coins' own, and is not duplicated here", () => {
  // Josh: "the text should mirror what coins form does". One home for all three.
  assert.match(textBody, /buildCashPayMessage\(order\.name/);
  assert.ok(!src.includes("function cashPayText"), "the local copy must be gone");
});
