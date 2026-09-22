// ─── Cash Pay: reads and writes against the New Order Board ───
//
// ⚠️ SEPARATE FROM `../monday.js` ON PURPOSE. That module hardcodes
// `SECONDARY_BOARD_ID` into every write, which is right for what it does and
// cannot serve a second board. Parameterising it would put the order board one
// typo away from every pay-secondary write; this file cannot reach the
// Secondary Claims board at all.
//
// ⚠️ Monday returns **HTTP 200 with an `errors[]` body** on a rejected write —
// nothing throws (CLAUDE.md §6). `query()` reads `errors[]` and throws, so a
// failed write cannot report success.

const { ORDER_BOARD_ID, ORDER_COLUMNS, ORDER_STATUS_INDEX } = require("./config");

const API_URL = "https://api.monday.com/v2";
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

const numericId = (id, label = "ID") => {
  const s = String(id);
  if (!/^\d+$/.test(s)) throw new Error(`Invalid ${label}: must be numeric, got "${s}"`);
  return s;
};

async function query(gql, variables = {}, attempt = 1) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: process.env.MONDAY_TOKEN,
      "API-Version": "2024-10",
    },
    body: JSON.stringify({ query: gql, variables }),
  });

  if (res.status === 429 || res.status >= 500) {
    if (attempt > MAX_RETRIES) throw new Error(`Monday API error after ${MAX_RETRIES} retries (${res.status})`);
    const delay = BASE_DELAY_MS * 2 ** (attempt - 1) + Math.random() * 500;
    console.warn(`[cash-pay/monday] ${res.status}, retrying in ${Math.round(delay)}ms (${attempt}/${MAX_RETRIES})`);
    await new Promise((r) => setTimeout(r, delay));
    return query(gql, variables, attempt + 1);
  }

  const data = await res.json();
  if (data.errors) throw new Error(`Monday API error: ${JSON.stringify(data.errors)}`);
  return data.data;
}

const WRITE = `mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) {
  change_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) { id }
}`;

const write = (itemId, columnId, value) =>
  query(WRITE, { boardId: ORDER_BOARD_ID, itemId: numericId(itemId, "item ID"), columnId, value: JSON.stringify(value) });

/** Read the columns this flow cares about off one order. */
async function getOrder(itemId) {
  const id = numericId(itemId, "item ID");
  const ids = Object.values(ORDER_COLUMNS).map((c) => `"${c}"`).join(", ");
  const data = await query(`{
    items(ids: [${id}]) {
      id name
      board { id }
      column_values(ids: [${ids}]) { id text }
    }
  }`);

  const item = data?.items?.[0];
  if (!item) return null;
  /* ⚠️ `items(ids:)` is BOARD-AGNOSTIC — it returns any item on the account,
     whatever board you had in mind. Without this check a stale or hand-typed
     id would be read through the order board's column map: every field blank
     or wrong, nothing erroring, and a payment link minted against somebody
     else's record. */
  if (String(item.board?.id) !== ORDER_BOARD_ID) return null;

  const by = Object.fromEntries((item.column_values ?? []).map((c) => [c.id, c.text ?? ""]));
  return {
    itemId: item.id,
    name: item.name ?? "",
    orderStatus:       by[ORDER_COLUMNS.ORDER_STATUS] ?? "",
    primaryInsurance:  by[ORDER_COLUMNS.PRIMARY_INSURANCE] ?? "",
    phone:             by[ORDER_COLUMNS.PRIMARY_PHONE] ?? "",
    cahOrderNumber:    by[ORDER_COLUMNS.CAH_ORDER_NUMBER] ?? "",
    cashPayLink:       by[ORDER_COLUMNS.CASH_PAY_LINK] ?? "",
    cashPayAmount:     by[ORDER_COLUMNS.CASH_PAY_AMOUNT] ?? "",
    cashPayLinkSent:   by[ORDER_COLUMNS.CASH_PAY_LINK_SENT] ?? "",
    cashPayPaidDate:   by[ORDER_COLUMNS.CASH_PAY_PAID_DATE] ?? "",
    stripeChargeId:    by[ORDER_COLUMNS.STRIPE_CHARGE_ID] ?? "",
  };
}

/** The link and what it was minted for. Amount FIRST — see below. */
async function storeCashPayLink(itemId, { url, totalCents }) {
  /* ⚠️ Amount before link, deliberately. The Command Center reads the link as
     "a link exists, stop offering Generate" and the amount as "this is the
     price now"; a half-failure that leaves a link with no amount shows a rep a
     payment they cannot name, where the reverse leaves an amount with no link
     and Generate still offered, which is the recoverable one. */
  await write(itemId, ORDER_COLUMNS.CASH_PAY_AMOUNT, String((totalCents / 100).toFixed(2)));
  await write(itemId, ORDER_COLUMNS.CASH_PAY_LINK, url);
}

/* ⚠️ Nothing here writes **Cash Pay Link Sent** `date_mm7d7wxe`. That column
   belongs to the board automation that sends the text (see `./index.js` on why
   the text is not this service's job), and a helper with no caller is the dead
   code that later gets wired up by somebody assuming it was meant to be. */

/**
 * Record a cash payment: the charge, the day, and the status the ordering gate
 * reads.
 *
 * ⚠️ The STATUS goes LAST. Order Status → Paid Cash is what tells the Command
 * Center's ordering gate this order may be placed with Cardinal; writing it
 * before the charge id would open that gate against an order whose payment
 * columns are still empty, which is the exact thing the gate exists to stop.
 */
async function recordCashPayment(itemId, { chargeId, date }) {
  await write(itemId, ORDER_COLUMNS.STRIPE_CHARGE_ID, String(chargeId));
  await write(itemId, ORDER_COLUMNS.CASH_PAY_PAID_DATE, { date });
  await write(itemId, ORDER_COLUMNS.ORDER_STATUS, { index: ORDER_STATUS_INDEX.PAID_CASH });
}

module.exports = { getOrder, storeCashPayLink, recordCashPayment };
