const { SUBSCRIPTION_BOARD_ID, COLUMNS } = require("./config");

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
    boardId: SUBSCRIPTION_BOARD_ID, itemId, columnId, value: JSON.stringify(text),
  });
}

async function writeStatusIndex(itemId, columnId, index) {
  await mondayQuery(WRITE_MUTATION, {
    boardId: SUBSCRIPTION_BOARD_ID, itemId, columnId, value: JSON.stringify({ index }),
  });
}

async function writeNumber(itemId, columnId, num) {
  await mondayQuery(WRITE_MUTATION, {
    boardId: SUBSCRIPTION_BOARD_ID, itemId, columnId,
    value: JSON.stringify(String(parseFloat(num) || 0)),
  });
}

// ─── Find patient by UID ───

async function findPatientByUid(uid) {
  const safeBoard = validateNumericId(SUBSCRIPTION_BOARD_ID, "board ID");
  const safeCol = validateColumnId(COLUMNS.PATIENT_UID);

  const data = await mondayQuery(`{
    items_page_by_column_values(
      board_id: ${safeBoard},
      limit: 1,
      columns: [{column_id: "${safeCol}", column_values: ["${uid.replace(/"/g, "")}"]}]
    ) {
      items {
        id name group { id title }
        column_values { id type text value }
      }
    }
  }`);

  return data.items_page_by_column_values?.items?.[0] || null;
}

// ─── Find patient by phone ───

async function findPatientByPhone(phone) {
  const digits = phone.replace(/\D/g, "");
  const safeBoard = validateNumericId(SUBSCRIPTION_BOARD_ID, "board ID");
  const safePhoneCol = validateColumnId(COLUMNS.PHONE);

  const data = await mondayQuery(`{
    items_page_by_column_values(
      board_id: ${safeBoard},
      limit: 10,
      columns: [{column_id: "${safePhoneCol}", column_values: ["${digits}"]}]
    ) {
      items {
        id name group { id title }
        column_values(ids: ["${safePhoneCol}", "${validateColumnId(COLUMNS.PATIENT_UID)}"]) {
          id text value
        }
      }
    }
  }`);

  const items = data.items_page_by_column_values?.items || [];
  if (items.length === 0) return null;

  const match = items.find((item) => {
    const uidCol = item.column_values.find((c) => c.id === COLUMNS.PATIENT_UID);
    return uidCol?.text;
  }) || items[0];

  const uidCol = match.column_values.find((c) => c.id === COLUMNS.PATIENT_UID);
  const phoneCol = match.column_values.find((c) => c.id === COLUMNS.PHONE);

  return {
    itemId: match.id,
    name: match.name,
    uid: uidCol?.text || null,
    phone: phoneCol?.text || digits,
  };
}

// ─── Get patient OOP data for the payment form ───

async function getPatientPaymentData(uid) {
  const item = await findPatientByUid(uid);
  if (!item) return null;

  const col = (id) => {
    const c = item.column_values.find((cv) => cv.id === id);
    return c?.text || "";
  };

  const isServing = (val) => val && val !== "Not Serving" && val.trim() !== "";

  // Derive "serving" from subscription + what products are active
  const subscription = col(COLUMNS.SUBSCRIPTION);
  const sensorsType = col(COLUMNS.SENSORS_TYPE);
  const suppliesType = col(COLUMNS.SUPPLIES_TYPE);

  const hasCgm = isServing(sensorsType);
  const hasPump = isServing(suppliesType);

  let serving = "";
  if (hasCgm && hasPump) serving = "Supplies + CGM";
  else if (hasCgm) serving = "CGM";
  else if (hasPump) serving = "Supplies Only";

  return {
    itemId: item.id,
    name: item.name,

    // Insurance (for OOP estimator)
    primaryInsurance: col(COLUMNS.PRIMARY_INS),
    secondaryInsurance: col(COLUMNS.SECONDARY_INS),

    // Product info (for OOP estimator)
    serving,
    subscription,
    sensorsType: hasCgm ? sensorsType : null,
    suppliesType: hasPump ? suppliesType : null,
    infusionSet1: isServing(col(COLUMNS.INFUSION_SET_1)) ? col(COLUMNS.INFUSION_SET_1) : null,
    qtyInf1: col(COLUMNS.INF_QTY_1) || "0",
    infusionSet2: isServing(col(COLUMNS.INFUSION_SET_2)) ? col(COLUMNS.INFUSION_SET_2) : null,
    qtyInf2: col(COLUMNS.INF_QTY_2) || "0",

    // Benefits / Stedi (for OOP estimator)
    deductible: col(COLUMNS.DEDUCTIBLE),
    deductibleRemaining: col(COLUMNS.DEDUCTIBLE_REMAINING),
    stediCoinsurance: col(COLUMNS.STEDI_COINSURANCE),
    oopMax: col(COLUMNS.OOP_MAX),
    oopMaxRemaining: col(COLUMNS.OOP_MAX_REMAINING),

    // Referral source (needed for CareCentrix check)
    referralSource: "",
  };
}

// ─── Store payment token + link in Monday ───

async function storePaymentLinkInMonday(uid, token, link) {
  const item = await findPatientByUid(uid);
  if (!item) throw new Error("Patient not found");
  const itemId = validateNumericId(item.id, "item ID");

  await Promise.all([
    writeText(itemId, COLUMNS.PAYMENT_TOKEN, token),
    writeText(itemId, COLUMNS.PAYMENT_LINK, link),
  ]);

  console.log(`[monday] Payment link stored for UID ${uid}`);
}

// ─── Record payment in Monday (future — for Stripe webhook) ───

async function recordPaymentInMonday(uid, { amount, stripeId, status = "Paid" }) {
  const item = await findPatientByUid(uid);
  if (!item) throw new Error("Patient not found");
  const itemId = validateNumericId(item.id, "item ID");

  const writes = [
    writeText(itemId, COLUMNS.PAYMENT_TIMESTAMP, new Date().toISOString()),
  ];

  // Write payment data to Monday columns

  if (amount) writes.push(writeNumber(itemId, COLUMNS.PAYMENT_AMOUNT, amount));
  if (stripeId) writes.push(writeText(itemId, COLUMNS.PAYMENT_STRIPE_ID, stripeId));
  writes.push(writeStatusIndex(itemId, COLUMNS.PAYMENT_STATUS, status === "Paid" ? 0 : 1));

  await Promise.all(writes);
  console.log(`[monday] Payment recorded for UID ${uid}: $${amount}, stripe=${stripeId}`);
}

module.exports = {
  findPatientByUid,
  findPatientByPhone,
  getPatientPaymentData,
  storePaymentLinkInMonday,
  recordPaymentInMonday,
};
