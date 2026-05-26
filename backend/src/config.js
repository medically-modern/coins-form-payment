// ─── Board & Column Configuration ───
// Maps Monday.com Subscription Board columns to payment data model

const SUBSCRIPTION_BOARD_ID = "18407459988";

// Column IDs — Subscription Board
const COLUMNS = {
  // Patient identity
  PATIENT_UID:      "text_mm3af3zt",

  // Demographics
  PHONE:            "phone_mkp0q3cw",
  EMAIL:            "email_mkp01rrw",

  // Insurance
  PRIMARY_INS:      "color_mm254qxj",
  MEMBER_ID_1:      "text_mkvp6zfg",
  SECONDARY_INS:    "color_mm25cr82",
  MEMBER_ID_2:      "text_mm25cpx6",

  // Subscription / product info
  SUBSCRIPTION:     "color_mm273mv8",     // Sensors / Supplies / Sensors & Supplies
  SENSORS_TYPE:     "color_mkxmdscr",
  SUPPLIES_TYPE:    "color_mkxmnheg",
  INFUSION_SET_1:   "color_mkxm50f9",
  INF_QTY_1:        "numeric_mkw839ks",
  INFUSION_SET_2:   "color_mkxmx5wk",
  INF_QTY_2:        "numeric_mkwac234",

  // Benefits / Stedi eligibility (for OOP estimator)
  DEDUCTIBLE:             "text_mm3gbped",
  DEDUCTIBLE_REMAINING:   "text_mm3g32ja",
  STEDI_COINSURANCE:      "text_mm3gphed",
  OOP_MAX:                "text_mm3gh0q3",
  OOP_MAX_REMAINING:      "text_mm3gs345",

  // ─── PAYMENT-SPECIFIC COLUMNS (new — must be created on the board) ───
  PAYMENT_TOKEN:          "text_payment_token",       // Text — payment token
  PAYMENT_LINK:           "text_payment_link",        // Text — payment link URL
  PAYMENT_STATUS:         "color_payment_status",     // Status — Pending / Paid / Failed
  PAYMENT_AMOUNT:         "numeric_payment_amount",   // Number — amount paid
  PAYMENT_TIMESTAMP:      "text_payment_timestamp",   // Text — ISO timestamp of payment
  PAYMENT_STRIPE_ID:      "text_payment_stripe_id",   // Text — Stripe payment intent ID (future)
};

// Auth configuration
const AUTH = {
  TOKEN_BYTES: 32,                    // 32 bytes = 64 hex chars
  TOKEN_TTL: 86400 * 30,             // 30 days — payment links last longer than reorder links
  JWT_EXPIRY: "24h",                  // 24-hour session
  RATE_LIMIT_AUTH: 50,
  RATE_LIMIT_AUTH_WINDOW: 3600,       // 1 hour
};

module.exports = {
  SUBSCRIPTION_BOARD_ID,
  COLUMNS,
  AUTH,
};
