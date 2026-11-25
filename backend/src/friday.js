/* The Friday forward's one instance in this service (src/fridayForward.js, the module every writer of the boards Friday copies
   carries): every mutation Monday ACCEPTED is handed to Friday afterwards, as sent, on a timer that never throws and never
   delays Monday's answer. OFF unless FRIDAY_FORWARD=1 with FRIDAY_URL and FRIDAY_API_KEY (Railway variables, never in this
   public tree); FRIDAY_BOARD_IDS names the boards: the New Order Board (cash pay, ./cashPay/monday.js) since 2026-11-06 and the
   Secondary Claims Board (./monday.js, ./smsQueue.js) since 2026-11-11. One instance, so the writes leave in the order Monday
   took them. test/fridayForwardWiring.test.js pins every Monday write path to it. */
const { createFridayForward } = require("./fridayForward");
const { createFridayShadow } = require("./fridayShadow");

const fridayForward = createFridayForward({ env: process.env, log: console.log, service: "coins-form-payment" });

/* The Friday read shadow's one instance (src/fridayShadow.js, the same file every service that reads Monday carries): after a
   READ through either Monday client (./monday.js, ./cashPay/monday.js) has Monday's answer, the read and that answer are handed
   to Friday's /v2/shadow, which runs it on Friday and keeps how the two compare (counts and paths, never a value). Started on a
   later turn of the event loop, never awaited, never throws, never retried: it cannot delay, change or fail a Monday read, and
   it never touches a payment. Only the final answer of a client's retries, never a mutation. OFF unless FRIDAY_SHADOW=1 (it
   reuses FRIDAY_URL / FRIDAY_API_KEY). test/fridayShadowWiring.test.js pins both clients to it. */
const fridayShadow = createFridayShadow({ env: process.env, log: console.log, reader: "coins-form-payment" });

module.exports = { fridayForward, fridayShadow };
