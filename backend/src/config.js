// ─── Board & Column Configuration ───
// Maps Monday.com Secondary Claims Board columns to payment data model
// Source of truth: Secondary Claims Board (18413019028)

const SECONDARY_BOARD_ID = "18413019028";
const SEND_INVOICE_GROUP_ID = "group_mm3ba7x1";

// Parent-level column IDs
const COLUMNS = {
  // Patient identity
  NAME:                   "name",
  DOB:                    "text_mkp3y5ax",
  PHONE:                  "phone_mm1znnww",
  GENDER:                 "color_mm1zy5f2",
  ADDRESS:                "location_mkxxpesw",

  // Insurance
  PRIMARY_PAYOR:          "color_mm3a93ek",
  PRIMARY_MEMBER_ID:      "text_mktat89m",
  SECONDARY_PAYER:        "color_mkxq1a2p",
  SECONDARY_MEMBER_ID:    "text_mm3a7ega",

  // Claim tracking
  DOS:                    "date_mkwr7spz",
  CLAIM_SENT_DATE:        "date_mm14rk8d",
  SUBMISSION_TYPE:        "color_mm3awg8g",
  SECONDARY_STATUS:       "color_mm3a5yak",
  CLAIM_TYPE:             "color_mm2nvk1p",

  // ERA / payment amounts (parent level)
  SECONDARY_PAID:         "numeric_mm3a2etk",
  SECONDARY_PAID_DATE:    "date_mm3apmee",
  RAW_PATIENT_RESPONSIBILITY: "numeric_mm1gdpjq",
  PRIMARY_PAID_AMOUNT:    "numeric_mm3as81b",
  PRIMARY_PR_AMOUNT:      "numeric_mm3ak2za",
  PRIMARY_PAID_DATE:      "date_mm3a9bdm",
  PATIENT_BILLED_DATE:    "date_mm3avzpm",
  CO_INSURANCE_ROLLUP:    "lookup_mm1g9mv5",

  // Doctor
  DOCTOR:                 "text_mkxr2r9b",
  DOCTOR_NPI:             "text_mkxr2r9b",

  // ─── PAYMENT COLUMNS (new — on Secondary Board) ───
  PAY_LINK_TOKEN:         "text_mm3q55qh",
  PAY_LINK_URL:           "text_mm3qag2c",
  PAY_LINK_SENT_DATE:     "date_mm3q88et",
  PATIENT_PAID_AMOUNT:    "numeric_mm3q2vpb",
  PATIENT_PAID_DATE:      "date_mm3qxwjs",
  STRIPE_CHARGE_ID:       "text_mm3qsjdf",
  PATIENT_MESSAGE:        "long_text_mm3yqgyt",
};

// Subitem column IDs (ERA line items)
const SUBITEM_COLUMNS = {
  HCPC_CODE:              "color_mm1cdvq8",
  MODIFIERS:              "dropdown_mm1z7je9",
  PAYMENT_STATUS:         "color_mm35f2e7",
  SECONDARY_PAID_LINE:    "numeric_mm11v6th",
  COINSURANCE_AMOUNT:     "numeric_mm11aqr1",
  DEDUCTIBLE_AMOUNT:      "numeric_mm1g3nvh",
  ORDER_QUANTITY:          "numeric_mm1czbyg",
  CLAIM_QUANTITY:          "numeric_mm20r76b",
};

// Auth configuration
const AUTH = {
  TOKEN_BYTES: 32,
  TOKEN_TTL: 86400 * 30,        // 30 days
  JWT_EXPIRY: "24h",
  RATE_LIMIT_AUTH: 50,
  RATE_LIMIT_AUTH_WINDOW: 3600,
};

// Company info (for receipt PDF)
const COMPANY = {
  name: "MID-ISLAND MEDICAL SUPPLY COMPANY",
  address: "2093 Wantagh Ave, Wantagh, NY 11793",
  npi: "1023042348",
  taxId: "11-3254896",
};

module.exports = {
  SECONDARY_BOARD_ID,
  SEND_INVOICE_GROUP_ID,
  COLUMNS,
  SUBITEM_COLUMNS,
  AUTH,
  COMPANY,
};
