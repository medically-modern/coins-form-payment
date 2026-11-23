// ─── Push alerts (ntfy) ───
//
// NTFY_URL is the server, NTFY_TOPIC the topic: set them on Railway as
// references to the Command Center gateway's, as Friday does, so alerts land
// in the feed Josh already reads. The topic is a bearer secret, so it lives in
// the environment only (this repo is PUBLIC). Unset, `notify` does nothing and
// says so once at boot, so a local run neither crashes nor pretends it alerted.
//
// Never put a patient's name, phone or amount in an alert.

const ntfyConfigured = () => Boolean(process.env.NTFY_URL && process.env.NTFY_TOPIC);

// Every push carries exactly one severity tag so the Command Center alerts page
// can sort it: lvl-error (a person must act), lvl-warn (needs a look),
// lvl-info (recovered / informational). Pass `level` where the priority would
// say something else; otherwise it follows the priority (5 error, 4 warn).
const LEVELS = new Set(["error", "warn", "info"]);
function levelFor(priority, level) {
  if (LEVELS.has(level)) return level;
  const p = String(priority).toLowerCase();
  if (p === "5" || p === "max" || p === "urgent") return "error";
  if (p === "4" || p === "high") return "warn";
  return "info";
}
const tagsWithLevel = (tags, priority, level) =>
  [tags, `lvl-${levelFor(priority, level)}`].filter(Boolean).join(",");

async function notify({ title, body = "", priority = "default", tags = "warning", level }) {
  if (!ntfyConfigured()) return false;
  const url = `${process.env.NTFY_URL.replace(/\/+$/, "")}/${encodeURIComponent(process.env.NTFY_TOPIC)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Title: String(title).replace(/[^\x20-\x7e]/g, "?").slice(0, 120),
      Priority: String(priority),
      Tags: tagsWithLevel(tags, priority, level),
    },
    body: String(body).slice(0, 2000),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`ntfy HTTP ${res.status}`);
  return true;
}

module.exports = { notify, ntfyConfigured, levelFor, tagsWithLevel };
