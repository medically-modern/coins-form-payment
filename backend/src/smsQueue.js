// ─── SMS Queue System ───
// Uses Redis list as a FIFO queue. Webhook pushes jobs, worker processes
// them sequentially with a delay between sends to respect rate limits.
// After sending, polls RingCentral for delivery status and writes to Monday.

const { redis, logEvent } = require("./redis");
const { sendSMS, getMessageStatus } = require("./ringcentral");
const { COLUMNS } = require("./config");

const QUEUE_KEY = "pay-secondary:sms-queue";
const PROCESSING_KEY = "pay-secondary:sms-processing";
const DELAY_BETWEEN_SENDS_MS = 2000; // 2s between texts
const DELIVERY_CHECK_DELAY_MS = 10000; // check delivery after 10s
const MAX_DELIVERY_CHECKS = 6; // max 6 checks (60s total)

let isProcessing = false;

// ─── Monday write helpers (imported lazily to avoid circular deps) ───

let _writeStatusLabel = null;
function getWriteStatusLabel() {
  if (!_writeStatusLabel) {
    const monday = require("./monday");
    _writeStatusLabel = monday.writeStatusLabel || (async (itemId, colId, label) => {
      const { mondayQuery } = monday;
      // fallback direct write
    });
  }
  return _writeStatusLabel;
}

async function writeSmsStatus(itemId, label) {
  try {
    const monday = require("./monday");
    const BOARD_ID = require("./config").SECONDARY_BOARD_ID;
    const query = `mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) {
      change_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) { id }
    }`;
    // Use mondayQuery directly
    const MONDAY_TOKEN = process.env.MONDAY_TOKEN;
    const res = await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: MONDAY_TOKEN,
        "API-Version": "2024-10",
      },
      body: JSON.stringify({
        query,
        variables: {
          boardId: BOARD_ID,
          itemId: String(itemId),
          columnId: COLUMNS.SMS_STATUS,
          value: JSON.stringify({ label }),
        },
      }),
    });
    const data = await res.json();
    if (data.errors) {
      console.error(`[sms-queue] Failed to write SMS status for ${itemId}:`, data.errors);
    }
  } catch (err) {
    console.error(`[sms-queue] Error writing SMS status for ${itemId}:`, err.message);
  }
}

// ─── Enqueue a text ───

async function enqueueSMS(job) {
  // job: { itemId, phone, message, patientName, paymentToken, textType }
  await redis.rpush(QUEUE_KEY, JSON.stringify({
    ...job,
    enqueuedAt: new Date().toISOString(),
  }));

  // Write "Queued" to Monday
  await writeSmsStatus(job.itemId, "Queued");

  console.log(`[sms-queue] Enqueued ${job.textType} text for item ${job.itemId} (${job.patientName})`);

  // Kick off processing if not already running
  processQueue();
}

// ─── Process queue sequentially ───

async function processQueue() {
  if (isProcessing) return;
  isProcessing = true;

  try {
    while (true) {
      const raw = await redis.lpop(QUEUE_KEY);
      if (!raw) break;

      let job;
      try {
        job = JSON.parse(raw);
      } catch {
        console.error("[sms-queue] Invalid job in queue:", raw);
        continue;
      }

      console.log(`[sms-queue] Processing ${job.textType} text for item ${job.itemId} (${job.patientName})`);

      try {
        // Send the SMS
        const result = await sendSMS(job.phone, job.message);
        const messageId = result.id;

        // Write "Sent" to Monday
        await writeSmsStatus(job.itemId, "Sent");

        // Mark as sent in Redis (dedup)
        const smsSentKey = `pay-secondary:sms-sent:${job.itemId}:${job.textType}`;
        await redis.set(smsSentKey, new Date().toISOString(), "EX", 86400 * 90);

        // Write sent date to Monday
        const today = new Date().toISOString().split("T")[0];
        const monday = require("./monday");
        await monday.writeDate(job.itemId, COLUMNS.PAY_LINK_SENT_DATE, today);

        if (job.paymentToken) {
          await logEvent(job.paymentToken, "sms_sent", {
            itemId: job.itemId,
            phone: job.phone.slice(-4),
            textType: job.textType,
            messageId,
          });
        }

        console.log(`[sms-queue] SMS sent for item ${job.itemId} (messageId: ${messageId})`);

        // Schedule delivery status check
        if (messageId) {
          checkDeliveryStatus(job.itemId, messageId, 1);
        }
      } catch (err) {
        console.error(`[sms-queue] Failed to send SMS for item ${job.itemId}:`, err.message);
        await writeSmsStatus(job.itemId, "Failed");

        if (job.paymentToken) {
          await logEvent(job.paymentToken, "sms_failed", {
            itemId: job.itemId,
            error: err.message,
          });
        }
      }

      // Delay between sends
      await new Promise((r) => setTimeout(r, DELAY_BETWEEN_SENDS_MS));
    }
  } finally {
    isProcessing = false;
  }
}

// ─── Check delivery status via RingCentral ───

async function checkDeliveryStatus(itemId, messageId, attempt) {
  setTimeout(async () => {
    try {
      const status = await getMessageStatus(messageId);
      console.log(`[sms-queue] Delivery status for item ${itemId}: ${status} (attempt ${attempt})`);

      if (status === "Delivered") {
        await writeSmsStatus(itemId, "Delivered");
      } else if (status === "DeliveryFailed" || status === "SendingFailed") {
        await writeSmsStatus(itemId, "Failed");
      } else if (attempt < MAX_DELIVERY_CHECKS) {
        // Still pending — check again
        checkDeliveryStatus(itemId, messageId, attempt + 1);
      } else {
        // Max checks reached — leave as "Sent"
        console.log(`[sms-queue] Max delivery checks reached for item ${itemId}, status: ${status}`);
      }
    } catch (err) {
      console.error(`[sms-queue] Error checking delivery for item ${itemId}:`, err.message);
    }
  }, DELIVERY_CHECK_DELAY_MS);
}

module.exports = {
  enqueueSMS,
  processQueue,
};
