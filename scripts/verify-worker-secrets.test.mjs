import assert from "node:assert/strict";
import test from "node:test";

import {
  REQUIRED_WORKER_SECRETS,
  missingRequiredSecrets,
  secretNamesFromInventory,
} from "./verify-worker-secrets.mjs";

const completeInventory = REQUIRED_WORKER_SECRETS.map((name) => ({
  name,
  type: "secret_text",
}));

test("accepts the complete Worker secret-name inventory", () => {
  assert.deepEqual(missingRequiredSecrets(completeInventory), []);
});

test("reports every missing required secret in stable order", () => {
  assert.deepEqual(
    missingRequiredSecrets(completeInventory.slice(2)),
    REQUIRED_WORKER_SECRETS.slice(0, 2),
  );
});

test("ignores additional named bindings without exposing values", () => {
  const inventory = [
    ...completeInventory,
    { name: "FUTURE_SECRET", type: "secret_text" },
  ];
  assert.deepEqual(missingRequiredSecrets(inventory), []);
});

test("rejects malformed Wrangler output", () => {
  assert.throws(
    () => secretNamesFromInventory({ name: "SUPABASE_URL" }),
    /JSON array/,
  );
  assert.throws(
    () => secretNamesFromInventory([{ type: "secret_text" }]),
    /invalid entry/,
  );
});
