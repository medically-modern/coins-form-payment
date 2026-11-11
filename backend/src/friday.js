/* The Friday forward's one instance in this service (src/fridayForward.js, the module every writer of the boards Friday copies
   carries): every mutation Monday ACCEPTED is handed to Friday afterwards, as sent, on a timer that never throws and never
   delays Monday's answer. OFF unless FRIDAY_FORWARD=1 with FRIDAY_URL and FRIDAY_API_KEY (Railway variables, never in this
   public tree); FRIDAY_BOARD_IDS names the boards: the New Order Board (cash pay, ./cashPay/monday.js) since 2026-11-06 and the
   Secondary Claims Board (./monday.js, ./smsQueue.js) since 2026-11-11. One instance, so the writes leave in the order Monday
   took them. test/fridayForwardWiring.test.js pins every Monday write path to it. */
const { createFridayForward } = require("./fridayForward");

const fridayForward = createFridayForward({ env: process.env, log: console.log, service: "coins-form-payment" });

module.exports = { fridayForward };
