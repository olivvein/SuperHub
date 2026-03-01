#!/usr/bin/env node

const hubUrl = process.env.HUB_URL || "http://127.0.0.1:7777";
const token = process.env.HUB_TOKEN;

const headers = {};
if (token) {
  headers["X-Hub-Token"] = token;
}

const response = await fetch(`${hubUrl.replace(/\/$/, "")}/api/diagnostics`, {
  headers
});

if (!response.ok) {
  const body = await response.text();
  console.error(`Diagnostics request failed: HTTP ${response.status}`);
  console.error(body);
  process.exit(1);
}

const payload = await response.json();
console.log(JSON.stringify(payload, null, 2));
