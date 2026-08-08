import assert from "node:assert/strict";
import test from "node:test";
import { CanaryError } from "./postdeploy-canary.mjs";
import {
  buildSupabaseProjectUrl,
  parseSupabaseProjectEnvironment,
  projectIdentityHash,
  validateSupabaseProject,
  verifySupabaseProject,
} from "./verify-supabase-project.mjs";

/* global Response */

const PROJECT_REF = "abcdefghijklmnopqrst";
const TOKEN = "supabase-token-that-must-stay-private";
const baseEnvironment = {
  SUPABASE_ACCESS_TOKEN: TOKEN,
  SUPABASE_PROJECT_REF: PROJECT_REF,
  SUPABASE_ORGANIZATION_ID: "org_firelight_pilot",
  SUPABASE_PROJECT_NAME: "Firelight staging",
};

function assertCode(expectedCode) {
  return (error) => {
    assert.ok(error instanceof CanaryError);
    assert.equal(error.code, expectedCode);
    assert.equal(error.message.includes(TOKEN), false);
    return true;
  };
}

function projectBody(overrides = {}) {
  return {
    id: PROJECT_REF,
    ref: PROJECT_REF,
    organization_id: baseEnvironment.SUPABASE_ORGANIZATION_ID,
    organization_slug: "firelight",
    name: baseEnvironment.SUPABASE_PROJECT_NAME,
    region: "eu-west-1",
    status: "ACTIVE_HEALTHY",
    database: {
      host: `db.${PROJECT_REF}.supabase.co`,
      version: "17",
      postgres_engine: "17",
      release_channel: "ga",
    },
    ...overrides,
  };
}

test("project environment binds protected organization, name, and evidence", () => {
  const parsed = parseSupabaseProjectEnvironment(baseEnvironment);
  const expectedHash = projectIdentityHash({
    projectRef: PROJECT_REF,
    organizationId: baseEnvironment.SUPABASE_ORGANIZATION_ID,
    projectName: baseEnvironment.SUPABASE_PROJECT_NAME,
  });
  assert.equal(parsed.identityHash, expectedHash);
  assert.equal(parsed.expectedRegion, "eu-west-1");
  assert.equal(parsed.expectedDatabaseHost, `db.${PROJECT_REF}.supabase.co`);
  assert.equal(
    parseSupabaseProjectEnvironment({
      ...baseEnvironment,
      FIRELIGHT_EXPECTED_PROJECT_IDENTITY_HASH: expectedHash,
    }).identityHash,
    expectedHash,
  );
  assert.throws(
    () => parseSupabaseProjectEnvironment({
      ...baseEnvironment,
      FIRELIGHT_EXPECTED_PROJECT_IDENTITY_HASH: "f".repeat(64),
    }),
    assertCode("SUPABASE_PROJECT_IDENTITY_EVIDENCE_MISMATCH"),
  );
});

test("project validation requires exact ref, organization, name, region, and host", () => {
  const configuration = parseSupabaseProjectEnvironment(baseEnvironment);
  assert.deepEqual(validateSupabaseProject(projectBody(), configuration), {
    projectRef: PROJECT_REF,
    identityHash: configuration.identityHash,
  });
  for (const body of [
    projectBody({ ref: "zyxwvutsrqponmlkjihg" }),
    projectBody({ organization_id: "other_organization" }),
    projectBody({ name: "Firelight production" }),
    projectBody({ region: "us-east-1" }),
    projectBody({ database: { host: "db.attacker.example" } }),
  ]) {
    assert.throws(
      () => validateSupabaseProject(body, configuration),
      assertCode("SUPABASE_PROJECT_IDENTITY_MISMATCH"),
    );
  }
});

test("Management API proof is bounded, authenticated, and exact-project scoped", async () => {
  const configuration = parseSupabaseProjectEnvironment(baseEnvironment);
  assert.equal(
    buildSupabaseProjectUrl(configuration),
    `https://api.supabase.com/v1/projects/${PROJECT_REF}`,
  );
  const result = await verifySupabaseProject(configuration, async (input, init) => {
    assert.equal(String(input), buildSupabaseProjectUrl(configuration));
    assert.equal(init.method, "GET");
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(init.redirect, "error");
    return new Response(JSON.stringify(projectBody()));
  });
  assert.equal(result.identityHash, configuration.identityHash);
});

test("Management API failures expose only stable codes", async () => {
  const configuration = parseSupabaseProjectEnvironment(baseEnvironment);
  await assert.rejects(
    verifySupabaseProject(
      configuration,
      async () => new Response(`rejected ${TOKEN}`, { status: 403 }),
    ),
    assertCode("SUPABASE_MANAGEMENT_AUTH_FAILED"),
  );
});
