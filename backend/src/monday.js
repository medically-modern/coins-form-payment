const { SECONDARY_BOARD_ID, COLUMNS, SUBITEM_COLUMNS } = require("./config");

const MONDAY_TOKEN = process.env.MONDAY_TOKEN;
const API_URL = "https://api.monday.com/v2";

// ─── Input validation ───

function validateNumericId(id, label = "ID") {
  const str = String(id);
  if (!/^\d+$/.test(str)) throw new Error(`Invalid ${label}: must be numeric, got "${str}"`);
  return str;
}

function validateColumnId(id) {
  const str = String(id);
  if (!/^[a-z0-9_]+$/.test(str)) throw new Error(`Invalid column ID: got "${str}"`);
  return str;
}

// ─── Monday GraphQL client with retry ───

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

async function mondayQuery(query, variables = {}, _attempt = 1) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: MONDAY_TOKEN,
      "API-Version": "2024-10",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (res.status === 429 || res.status >= 500) {
    if (_attempt > MAX_RETRIES) throw new Error(`Monday API error after ${MAX_RETRIES} retries (${res.status})`);
    const delay = BASE_DELAY_MS * Math.pow(2, _attempt - 1) + Math.random() * 500;
    console.warn(`[monday] ${res.status}, retrying in ${Math.round(delay)}ms (attempt ${_attempt}/${MAX_RETRIES})`);
    await new Promise((r) => setTimeout(r, delay));
    return mondayQuery(query, variables, _attempt + 1);
  }

  const data = await res.json();
  if (data.errors) {
    throw new Error(`Monday API error: ${JSON.stringify(data.errors)}`);
  }
  return data.data;
}

// ─── Write helpers ───

const WRITE_MUTATION = `mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) {
  change_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) { id }
}`;

async function writeText(itemId, columnId, text) {
  await mondayQuery(WRITE_MUTATION, {
    boardId: SECONDARY_BOARD_ID, itemId, columnId, value: JSON.stringify(text),
  });
}

async function writeDate(itemId, columnId, dateStr) {
  // dateStr should be YYYY-MM-DD
  await mondayQuery(WRITE_MUTATION, {
    boardId: SECONDARY_BOARD_ID, itemId, columnId, value: JSON.stringify({ date: dateStr }),
  });
}

async function writeNumber(itemId, columnId, num) {
  await mondayQuery(WRITE_MUTATION, {
    boardId: SECONDARY_BOARD_ID, itemId, columnId,
    value: JSON.stringify(String(parseFloat(num) || 0)),
  });
}

async function writeLongText(itemId, columnId, text) {
  await mondayQuery(WRITE_MUTATION, {
    boardId: SECONDARY_BOARD_ID, itemId, columnId,
    value: JSON.stringify({ text }),
  });
}

async function writeStatusLabel(itemId, columnId, label) {
  await mondayQuery(WRITE_MUTATION, {
    boardId: SECONDARY_BOARD_ID, itemId, columnId,
    value: JSON.stringify({ label }),
  });
}

// ─── Get item by Monday item ID (with subitems for ERA line items) ───

async function getItemById(itemId) {
  const safeId = validateNumericId(itemId, "item ID");

  // Build list of parent column IDs to fetch
  const parentColIds = Object.values(COLUMNS)
    .filter(id => id !== "name")
    .map(id => `"${validateColumnId(id)}"`)
    .join(", ");

  // Build list of subitem column IDs to fetch
  const subColIds = Object.values(SUBITEM_COLUMNS)
    .map(id => `"${validateColumnId(id)}"`)
    .join(", ");

  const data = await mondayQuery(`{
    items(ids: [${safeId}]) {
      id name
      group { id title }
      column_values(ids: [${parentColIds}]) {
        id text type
        column { id title }
      }
      subitems {
        id name
        column_values(ids: [${subColIds}]) {
          id text type
          column { id title }
        }
      }
    }
  }`);

  return data.items?.[0] || null;
}

// ─── Find item by pay link token (reverse lookup via column search) ───

async function findItemByToken(token) {
  const safeBoard = validateNumericId(SECONDARY_BOARD_ID, "board ID");
  const safeCol = validateColumnId(COLUMNS.PAY_LINK_TOKEN);

  const data = await mondayQuery(`{
    items_page_by_column_values(
      board_id: ${safeBoard},
      limit: 1,
      columns: [{column_id: "${safeCol}", column_values: ["${token.replace(/"/g, "")}"]}]
    ) {
      items { id name }
    }
  }`);

  return data.items_page_by_column_values?.items?.[0] || null;
}

// ─── Transform Monday item into patient-safe payment data ───

function transformToPaymentData(item) {
  const col = (id) => {
    const c = item.column_values.find((cv) => cv.id === id);
    return c?.text || "";
  };

  // Parse subitems into ERA line items
  const lineItems = (item.subitems || []).map((sub) => {
    const subCol = (id) => {
      const c = sub.column_values.find((cv) => cv.id === id);
      return c?.text || "";
    };

    const coinsurance = parseFloat(subCol(SUBITEM_COLUMNS.COINSURANCE_AMOUNT)) || 0;
    const deductible = parseFloat(subCol(SUBITEM_COLUMNS.DEDUCTIBLE_AMOUNT)) || 0;

    return {
      name: sub.name,
      hcpcCode: subCol(SUBITEM_COLUMNS.HCPC_CODE),
      modifiers: subCol(SUBITEM_COLUMNS.MODIFIERS),
      coinsuranceAmount: coinsurance,
      deductibleAmount: deductible,
      patientOwes: coinsurance + deductible,
      secondaryPaidLine: parseFloat(subCol(SUBITEM_COLUMNS.SECONDARY_PAID_LINE)) || 0,
      quantity: subCol(SUBITEM_COLUMNS.CLAIM_QUANTITY) || subCol(SUBITEM_COLUMNS.ORDER_QUANTITY),
    };
  });

  // Total patient owes = sum of coinsurance + deductible across line items
  const totalPatientOwes = lineItems.reduce((sum, li) => sum + li.patientOwes, 0);

  // Check if already paid
  const stripeChargeId = col(COLUMNS.STRIPE_CHARGE_ID);
  const paidAmount = parseFloat(col(COLUMNS.PATIENT_PAID_AMOUNT)) || 0;
  const isPaid = !!stripeChargeId || paidAmount > 0;

  return {
    itemId: item.id,
    name: item.name,
    dob: col(COLUMNS.DOB),
    dos: col(COLUMNS.DOS),
    phone: col(COLUMNS.PHONE),

    // Insurance
    primaryPayor: col(COLUMNS.PRIMARY_PAYOR),
    primaryMemberId: col(COLUMNS.PRIMARY_MEMBER_ID),
    secondaryPayer: col(COLUMNS.SECONDARY_PAYER),
    secondaryMemberId: col(COLUMNS.SECONDARY_MEMBER_ID),

    // ERA summary
    primaryPaidAmount: parseFloat(col(COLUMNS.PRIMARY_PAID_AMOUNT)) || 0,
    primaryPrAmount: parseFloat(col(COLUMNS.PRIMARY_PR_AMOUNT)) || 0,
    secondaryPaid: parseFloat(col(COLUMNS.SECONDARY_PAID)) || 0,
    secondaryPaidDate: col(COLUMNS.SECONDARY_PAID_DATE),

    // Line items (ERA breakdown)
    lineItems,
    totalPatientOwes,

    // Payment state
    isPaid,
    paidAmount,
    paidDate: col(COLUMNS.PATIENT_PAID_DATE),
    stripeChargeId,

    // Status
    secondaryStatus: col(COLUMNS.SECONDARY_STATUS),
    submissionType: col(COLUMNS.SUBMISSION_TYPE),
  };
}

// ─── Get patient payment data by Monday item ID ───

async function getPatientPaymentData(itemId) {
  const item = await getItemById(itemId);
  if (!item) return null;
  return transformToPaymentData(item);
}

// ─── Store payment link in Monday ───

async function storePaymentLinkInMonday(itemId, token, link) {
  const safeId = validateNumericId(itemId, "item ID");
  const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

  await Promise.all([
    writeText(safeId, COLUMNS.PAY_LINK_TOKEN, token),
    writeText(safeId, COLUMNS.PAY_LINK_URL, link),
    writeDate(safeId, COLUMNS.PAY_LINK_SENT_DATE, today),
    writeStatusLabel(safeId, COLUMNS.SECONDARY_STATUS, "Sent to Patient"),
  ]);

  console.log(`[monday] Payment link stored for item ${itemId}`);
}

// ─── Record payment in Monday (from Stripe webhook) ───

async function recordPaymentInMonday(itemId, { amount, stripeChargeId }) {
  const safeId = validateNumericId(itemId, "item ID");
  const today = new Date().toISOString().split("T")[0];

  await Promise.all([
    writeNumber(safeId, COLUMNS.PATIENT_PAID_AMOUNT, amount),
    writeDate(safeId, COLUMNS.PATIENT_PAID_DATE, today),
    writeText(safeId, COLUMNS.STRIPE_CHARGE_ID, stripeChargeId),
    writeStatusLabel(safeId, COLUMNS.SECONDARY_STATUS, "Review"),
  ]);

  console.log(`[monday] Payment recorded for item ${itemId}: $${amount}, charge=${stripeChargeId}`);
}

module.exports = {
  getItemById,
  findItemByToken,
  getPatientPaymentData,
  transformToPaymentData,
  storePaymentLinkInMonday,
  recordPaymentInMonday,
  writeLongText,
};
