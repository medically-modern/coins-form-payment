// ─── RingCentral SMS Integration ───
// Authenticates via JWT grant, sends SMS to patients with payment links.
// Access token is cached in memory and refreshed when expired.

const RC_SERVER = process.env.RC_SERVER || "https://platform.ringcentral.com";
const RC_CLIENT_ID = process.env.RC_CLIENT_ID;
const RC_CLIENT_SECRET = process.env.RC_CLIENT_SECRET;
const RC_JWT = process.env.RC_JWT;
const RC_FROM_NUMBER = process.env.RC_FROM_NUMBER || "+13475037148";

let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  // Return cached token if still valid (with 60s buffer)
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) {
    return cachedToken;
  }

  const credentials = Buffer.from(`${RC_CLIENT_ID}:${RC_CLIENT_SECRET}`).toString("base64");

  const res = await fetch(`${RC_SERVER}/restapi/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: RC_JWT,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`RC auth failed (${res.status}): ${err}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;

  console.log("[ringcentral] Access token refreshed");
  return cachedToken;
}

// ─── Normalize phone to E.164 (+1XXXXXXXXXX) ───

function normalizePhone(raw) {
  if (!raw) return null;
  // Strip everything except digits
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.startsWith("+")) return raw.replace(/[^\d+]/g, "");
  return null;
}

// ─── Send SMS ───

async function sendSMS(toNumber, messageText) {
  const to = normalizePhone(toNumber);
  if (!to) throw new Error(`Invalid phone number: ${toNumber}`);

  if (!RC_CLIENT_ID || !RC_JWT) {
    throw new Error("RingCentral credentials not configured");
  }

  const token = await getAccessToken();

  const res = await fetch(`${RC_SERVER}/restapi/v1.0/account/~/extension/~/sms`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      from: { phoneNumber: normalizePhone(RC_FROM_NUMBER) },
      to: [{ phoneNumber: to }],
      text: messageText,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    // If token expired mid-request, clear cache and throw
    if (res.status === 401) {
      cachedToken = null;
      tokenExpiresAt = 0;
    }
    throw new Error(`RC SMS failed (${res.status}): ${err}`);
  }

  const data = await res.json();
  console.log(`[ringcentral] SMS sent to ${to} (messageId: ${data.id})`);
  return data;
}

// ─── Build payment text message ───

function buildPaymentMessage(patientName, paymentLink, amount) {
  const firstName = patientName.split(/[\s,]+/)[0];
  const amountStr = amount ? ` of $${parseFloat(amount).toFixed(2)}` : "";
  return [
    `Hi ${firstName}, this is Medically Modern. You have a patient responsibility balance from your order. View your statement below.`,
    ``,
    `${paymentLink}`,
  ].join("\n");
}

module.exports = {
  sendSMS,
  normalizePhone,
  buildPaymentMessage,
};
