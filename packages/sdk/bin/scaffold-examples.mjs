#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(__filename), "..");
const sourceDir = path.join(packageRoot, "examples");

const args = process.argv.slice(2);
const force = args.includes("--force");
const positional = args.filter((arg) => !arg.startsWith("-"));
const targetArg = positional[0] || "superhub-examples";
const targetDir = path.resolve(process.cwd(), targetArg);

if (!fs.existsSync(sourceDir)) {
  console.error(`[superhub-examples] source not found: ${sourceDir}`);
  process.exit(1);
}

const targetExists = fs.existsSync(targetDir);
if (targetExists && !force) {
  const entries = await fsp.readdir(targetDir);
  if (entries.length > 0) {
    console.error(`[superhub-examples] target not empty: ${targetDir}`);
    console.error("[superhub-examples] rerun with --force to overwrite");
    process.exit(1);
  }
}

if (targetExists && force) {
  await fsp.rm(targetDir, { recursive: true, force: true });
}

await fsp.mkdir(path.dirname(targetDir), { recursive: true });
await fsp.cp(sourceDir, targetDir, { recursive: true });

console.log(`[superhub-examples] copied examples to: ${targetDir}`);
console.log("[superhub-examples] next steps:");
console.log(`  1) cp "${path.join(targetDir, ".env.example")}" "${path.join(targetDir, ".env")}"`);
console.log(`  2) source "${path.join(targetDir, ".env")}"`);
console.log(`  3) npx tsx "${path.join(targetDir, "node/iss-monitor.ts")}"`);
