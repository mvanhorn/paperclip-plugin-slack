import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function loadDotenv(path) {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotenv(resolve(process.cwd(), ".env"));

const token = process.env.SLACK_APP_TOKEN;
if (!token) {
  console.error("Socket Mode smoke: missing SLACK_APP_TOKEN.");
  process.exit(2);
}

const res = await fetch("https://slack.com/api/apps.connections.open", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/x-www-form-urlencoded",
  },
});

const body = await res.json();
if (!body.ok || typeof body.url !== "string" || !body.url.startsWith("wss://")) {
  console.error("Socket Mode smoke: failed.", {
    ok: body.ok,
    error: body.error,
    hasWssUrl: typeof body.url === "string" && body.url.startsWith("wss://"),
  });
  process.exit(1);
}

console.log("Socket Mode smoke: ok, received wss URL.");
