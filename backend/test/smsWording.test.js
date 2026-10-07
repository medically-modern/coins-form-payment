// Run: npm test  (node --test, no dependency added)
//
// The three texts a patient can get from this service — the balance, the
// balance reminder and the cash pay link. All three close by inviting a reply
// (Brandon, 2026-09-25: "Feel free to text us with any questions!"), and all
// three keep the link alone on its line so nothing gets folded into the URL.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildPaymentMessage, buildFollowUpMessage, buildCashPayMessage,
} = require("../src/ringcentral");

const LINK = "https://medically-modern.github.io/coins-form-payment?token=abc123";
const CLOSING = "Feel free to text us with any questions!";

const texts = {
  balance: buildPaymentMessage("Jane Doe", LINK, "42.10"),
  reminder: buildFollowUpMessage("Jane Doe", LINK),
  cashPay: buildCashPayMessage("Jane Doe", LINK, "120"),
};

for (const [name, text] of Object.entries(texts)) {
  test(`${name} text ends with the questions line, after a blank line`, () => {
    const lines = text.split("\n");
    assert.equal(lines[lines.length - 1], CLOSING);
    assert.equal(lines[lines.length - 2], "");
  });

  test(`${name} text keeps the link alone on its own line`, () => {
    assert.ok(text.split("\n").includes(LINK));
  });

  test(`${name} text stays plain GSM-7 (no curly quotes or dashes)`, () => {
    assert.ok(/^[\x0A\x20-\x7E]*$/.test(text), "non-ASCII character in an SMS body");
  });
}
