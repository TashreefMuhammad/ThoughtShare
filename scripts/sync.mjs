// Pulls APPROVED thoughts from your Apps Script and writes data/messages.json.
// Used by .github/workflows/pages.yml. Needs two repository secrets:
//   THOUGHTSHARE_ENDPOINT   – your Apps Script web-app URL (ends in /exec)
//   THOUGHTSHARE_EXPORT_KEY – the sync key from the sheet menu
import { readFileSync, writeFileSync } from "node:fs";

const FILE = "data/messages.json";
const endpoint = (process.env.THOUGHTSHARE_ENDPOINT || "").trim();
const key = (process.env.THOUGHTSHARE_EXPORT_KEY || "").trim();

if (!endpoint || !key) {
  console.log("::warning::Sync skipped: add THOUGHTSHARE_ENDPOINT and THOUGHTSHARE_EXPORT_KEY secrets to enable it.");
  process.exit(0);
}

const url = new URL(endpoint);
url.searchParams.set("action", "export");
url.searchParams.set("key", key);

const res = await fetch(url, { redirect: "follow" });
const body = await res.text();
let data;
try {
  data = JSON.parse(body);
} catch {
  console.error("::error::Apps Script did not return JSON. Is the web app deployed with access set to 'Anyone'?");
  process.exit(1);
}
if (data.ok === false) {
  console.error(`::error::Apps Script refused the export: ${data.error || "unknown error"} (check the sync key).`);
  process.exit(1);
}
if (!Array.isArray(data.messages)) {
  console.error("::error::Unexpected response shape from Apps Script.");
  process.exit(1);
}

let current = null;
try { current = JSON.parse(readFileSync(FILE, "utf8")); } catch { /* first run */ }

const same = current && JSON.stringify(current.messages) === JSON.stringify(data.messages);
if (same) {
  console.log(`No changes (${data.messages.length} approved).`);
  process.exit(0);
}

writeFileSync(FILE, JSON.stringify({ updated: data.updated, messages: data.messages }, null, 2) + "\n");
console.log(`Wrote ${data.messages.length} approved thought(s) to ${FILE}.`);
