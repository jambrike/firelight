import { readFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const REQUIRED_WORKER_SECRETS = Object.freeze([
  "COMPILER_SERVICE_ORIGIN",
  "COMPILER_SERVICE_HOST",
  "COMPILER_SERVICE_TOKEN",
  "COMPILER_SERVICE_URL",
  "KIT_CODE_PEPPER",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_PROJECT_REF",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_URL",
]);

export function secretNamesFromInventory(value) {
  if (!Array.isArray(value)) {
    throw new TypeError("The Worker secret inventory must be a JSON array.");
  }

  const names = new Set();
  for (const entry of value) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("name" in entry) ||
      typeof entry.name !== "string" ||
      entry.name.length === 0
    ) {
      throw new TypeError("The Worker secret inventory has an invalid entry.");
    }
    names.add(entry.name);
  }

  return names;
}

export function missingRequiredSecrets(inventory) {
  const names = secretNamesFromInventory(inventory);
  return REQUIRED_WORKER_SECRETS.filter((name) => !names.has(name));
}

async function main() {
  const inventoryPath = process.argv[2];
  if (!inventoryPath) {
    throw new TypeError(
      "Usage: node scripts/verify-worker-secrets.mjs <wrangler-secret-inventory.json>",
    );
  }

  const source = await readFile(inventoryPath, "utf8");
  const inventory = JSON.parse(source);
  const missing = missingRequiredSecrets(inventory);
  if (missing.length > 0) {
    throw new Error(`Missing required Worker secrets: ${missing.join(", ")}.`);
  }

  process.stdout.write(
    `Verified ${String(REQUIRED_WORKER_SECRETS.length)} required Worker secret names.\n`,
  );
}

const entryPoint = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;

if (entryPoint === import.meta.url) {
  await main();
}
