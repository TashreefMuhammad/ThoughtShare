// Validates data/messages.json before every deploy.
// If you paste broken JSON, the deploy stops and your live site keeps the last good version.
import { readFileSync } from "node:fs";

const FILE = process.argv[2] || "data/messages.json";
const fail = (msg) => { console.error(`::error file=${FILE}::${msg}`); process.exit(1); };

let data;
try {
  data = JSON.parse(readFileSync(FILE, "utf8"));
} catch (e) {
  fail(`Not valid JSON: ${e.message}`);
}

const list = Array.isArray(data) ? data : data?.messages;
if (!Array.isArray(list)) fail('Expected { "messages": [ ... ] } or a plain array.');

const ids = new Set();
list.forEach((m, i) => {
  const where = `messages[${i}]`;
  if (!m || typeof m !== "object") fail(`${where} is not an object.`);
  if (typeof m.text !== "string" || !m.text.trim()) fail(`${where} has no "text".`);
  if (m.id != null) {
    if (ids.has(String(m.id))) fail(`${where} repeats id "${m.id}".`);
    ids.add(String(m.id));
  }
  if (m.date != null && isNaN(new Date(m.date))) fail(`${where} has an invalid "date" (${m.date}). Use YYYY-MM-DD.`);
  if (m.featured != null && typeof m.featured !== "boolean") fail(`${where} "featured" must be true or false.`);
});

console.log(`${FILE}: ${list.length} message(s), valid.`);
