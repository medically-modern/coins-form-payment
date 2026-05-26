/**
 * Create the payment-specific columns on the Subscription Board.
 *
 * Run once: MONDAY_TOKEN=<token> node src/scripts/create-columns.js
 *
 * After running, update config.js COLUMNS with the returned column IDs.
 */

const BOARD_ID = "18407459988";
const MONDAY_TOKEN = process.env.MONDAY_TOKEN;

if (!MONDAY_TOKEN) {
  console.error("Set MONDAY_TOKEN env var");
  process.exit(1);
}

async function gql(query) {
  const res = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: MONDAY_TOKEN,
      "API-Version": "2024-10",
    },
    body: JSON.stringify({ query }),
  });
  const data = await res.json();
  if (data.errors) {
    console.error("GraphQL errors:", JSON.stringify(data.errors, null, 2));
    throw new Error("GraphQL error");
  }
  return data.data;
}

async function createColumn(title, type, defaults = "") {
  const defaultsArg = defaults ? `, defaults: ${JSON.stringify(JSON.stringify(defaults))}` : "";
  const query = `mutation { create_column(board_id: ${BOARD_ID}, title: "${title}", column_type: ${type}${defaultsArg}) { id title } }`;
  const data = await gql(query);
  const col = data.create_column;
  console.log(`  Created: ${col.title} → ${col.id}`);
  return col.id;
}

async function main() {
  console.log("Creating payment columns on Subscription Board...\n");

  const ids = {};

  ids.PAYMENT_TOKEN = await createColumn("Payment Token", "text");
  ids.PAYMENT_LINK = await createColumn("Payment Link", "text");
  ids.PAYMENT_STATUS = await createColumn("Payment Status", "status", {
    labels: { "0": "Pending", "1": "Paid", "2": "Failed" },
  });
  ids.PAYMENT_AMOUNT = await createColumn("Payment Amount", "numbers");
  ids.PAYMENT_TIMESTAMP = await createColumn("Payment Timestamp", "text");
  ids.PAYMENT_STRIPE_ID = await createColumn("Stripe Payment ID", "text");

  console.log("\n✅ Done! Update config.js COLUMNS with these IDs:\n");
  for (const [key, id] of Object.entries(ids)) {
    console.log(`  ${key}: "${id}",`);
  }
}

main().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
