import assert from "node:assert/strict";
import test from "node:test";
import { CanaryError } from "./postdeploy-canary.mjs";
import { generateSupabaseProjectAnchors } from "./generate-supabase-project-anchors.mjs";
import { serializeReleaseEnvironmentAnchors } from "./verify-release-environment-anchors.mjs";

const STAGING_REF = "abcdefghijklmnopqrst";
const PRODUCTION_REF = "zyxwvutsrqponmlkjihg";
const ORGANIZATION_ID = "org_firelight_pilot";
const environment = {
  FIRELIGHT_STAGING_SUPABASE_PROJECT_REF: STAGING_REF,
  FIRELIGHT_PRODUCTION_SUPABASE_PROJECT_REF: PRODUCTION_REF,
  SUPABASE_ORGANIZATION_ID: ORGANIZATION_ID,
};

test("anchor generation emits only canonical domain-separated hashes", () => {
  const serialized = serializeReleaseEnvironmentAnchors(
    generateSupabaseProjectAnchors(environment),
  );
  assert.equal(serialized.endsWith("\n"), true);
  assert.equal(serialized.includes(STAGING_REF), false);
  assert.equal(serialized.includes(PRODUCTION_REF), false);
  assert.equal(serialized.includes(ORGANIZATION_ID), false);
  assert.match(serialized, /firelight\.supabase-project-anchors/u);
  assert.match(serialized, /[0-9a-f]{64}/u);
});

test("anchor generation rejects a same-project or malformed mapping", () => {
  assert.throws(
    () =>
      generateSupabaseProjectAnchors({
        ...environment,
        FIRELIGHT_STAGING_SUPABASE_PROJECT_REF: PRODUCTION_REF,
      }),
    (error) =>
      error instanceof CanaryError &&
      error.code === "SUPABASE_PROJECT_REF_COLLISION",
  );
  assert.throws(
    () =>
      generateSupabaseProjectAnchors({
        ...environment,
        FIRELIGHT_STAGING_SUPABASE_PROJECT_REF: "short",
      }),
    (error) =>
      error instanceof CanaryError &&
      error.code === "INVALID_FIRELIGHT_STAGING_SUPABASE_PROJECT_REF",
  );
});
