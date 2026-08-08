import assert from "node:assert/strict";
import test from "node:test";
import { CanaryError } from "./postdeploy-canary.mjs";
import {
  hashProjectRef,
  parseDatabaseTargetEnvironment,
  verifyDatabaseTarget,
} from "./verify-database-target.mjs";

/* global Response */

const PROJECT_REF = "abcdefghijklmnopqrst";
const OTHER_PROJECT_REF = "zyxwvutsrqponmlkjihg";
const PROJECT_REF_HASH = hashProjectRef(PROJECT_REF);
const baseEnvironment = {
  FIRELIGHT_BASE_URL: "https://staging.firelight.ie",
  FIRELIGHT_EXPECTED_ENVIRONMENT: "staging",
  SUPABASE_PROJECT_REF: PROJECT_REF,
};

function assertCode(expectedCode) {
  return (error) => {
    assert.ok(error instanceof CanaryError);
    assert.equal(error.code, expectedCode);
    assert.equal(error.message.includes(PROJECT_REF), false);
    return true;
  };
}

function runtimeConfig(projectRef = PROJECT_REF) {
  return {
    data: {
      apiVersion: "v1",
      supabase: {
        url: `https://${projectRef}.supabase.co`,
        publishableKey: "public-key",
      },
    },
  };
}

test("database target environment pins canonical hosts and evidence", () => {
  assert.deepEqual(parseDatabaseTargetEnvironment(baseEnvironment), {
    baseUrl: "https://staging.firelight.ie",
    expectedEnvironment: "staging",
    projectRef: PROJECT_REF,
    projectRefHash: PROJECT_REF_HASH,
    bootstrapApproved: false,
  });
  assert.equal(
    parseDatabaseTargetEnvironment({
      ...baseEnvironment,
      FIRELIGHT_DATABASE_BOOTSTRAP_CONFIRMATION: "BOOTSTRAP_STAGING_DATABASE",
      FIRELIGHT_EXPECTED_PROJECT_REF_HASH: PROJECT_REF_HASH,
    }).bootstrapApproved,
    true,
  );
  assert.throws(
    () => parseDatabaseTargetEnvironment({
      ...baseEnvironment,
      FIRELIGHT_BASE_URL: "https://firelight.ie",
    }),
    assertCode("FIRELIGHT_BASE_URL_MISMATCH"),
  );
  assert.throws(
    () => parseDatabaseTargetEnvironment({
      ...baseEnvironment,
      FIRELIGHT_DATABASE_BOOTSTRAP_CONFIRMATION: "BOOTSTRAP_PRODUCTION_DATABASE",
    }),
    assertCode("INVALID_FIRELIGHT_DATABASE_BOOTSTRAP_CONFIRMATION"),
  );
  assert.throws(
    () => parseDatabaseTargetEnvironment({
      ...baseEnvironment,
      FIRELIGHT_EXPECTED_PROJECT_REF_HASH: "f".repeat(64),
    }),
    assertCode("SUPABASE_PROJECT_EVIDENCE_MISMATCH"),
  );
});

test("deployed config must contain the exact expected Supabase hostname", async () => {
  const configuration = parseDatabaseTargetEnvironment(baseEnvironment);
  const fetchImpl = async (input, init) => {
    assert.equal(String(input), "https://staging.firelight.ie/api/config");
    assert.equal(init.method, "GET");
    assert.equal(init.headers.Accept, "application/json");
    assert.equal(init.redirect, "error");
    return new Response(JSON.stringify(runtimeConfig()));
  };
  assert.deepEqual(await verifyDatabaseTarget(configuration, fetchImpl), {
    environment: "staging",
    projectRefHash: PROJECT_REF_HASH,
    mode: "matched",
    reason: "DEPLOYED_CONFIG_MATCHED",
  });
});

test("bootstrap approval never overrides a deployed project mismatch", async () => {
  const configuration = parseDatabaseTargetEnvironment({
    ...baseEnvironment,
    FIRELIGHT_DATABASE_BOOTSTRAP_CONFIRMATION: "BOOTSTRAP_STAGING_DATABASE",
  });
  await assert.rejects(
    verifyDatabaseTarget(
      configuration,
      async () => new Response(JSON.stringify(runtimeConfig(OTHER_PROJECT_REF))),
    ),
    assertCode("DEPLOYED_SUPABASE_PROJECT_MISMATCH"),
  );
});

test("bootstrap requires explicit approval and only accepts an uninitialized endpoint", async () => {
  const normal = parseDatabaseTargetEnvironment(baseEnvironment);
  await assert.rejects(
    verifyDatabaseTarget(normal, async () => new Response("missing", { status: 404 })),
    assertCode("DEPLOYED_CONFIG_UNAVAILABLE"),
  );

  const bootstrap = parseDatabaseTargetEnvironment({
    ...baseEnvironment,
    FIRELIGHT_DATABASE_BOOTSTRAP_CONFIRMATION: "BOOTSTRAP_STAGING_DATABASE",
  });
  assert.deepEqual(
    await verifyDatabaseTarget(
      bootstrap,
      async () => new Response("missing", { status: 404 }),
    ),
    {
      environment: "staging",
      projectRefHash: PROJECT_REF_HASH,
      mode: "bootstrap",
      reason: "HTTP_404",
    },
  );
  await assert.rejects(
    verifyDatabaseTarget(
      bootstrap,
      async () => new Response("static prototype html"),
    ),
    assertCode("INVALID_DEPLOYED_CONFIG"),
  );
  await assert.rejects(
    verifyDatabaseTarget(bootstrap, async () => {
      throw new Error("network unavailable");
    }),
    assertCode("NETWORK_REQUEST_FAILED"),
  );
  await assert.rejects(
    verifyDatabaseTarget(
      bootstrap,
      async () => new Response("unavailable", { status: 503 }),
    ),
    assertCode("DEPLOYED_CONFIG_UNAVAILABLE"),
  );
});

test("database target failures expose only stable codes", async () => {
  const configuration = parseDatabaseTargetEnvironment(baseEnvironment);
  await assert.rejects(
    verifyDatabaseTarget(configuration, async () => {
      throw new Error(`failed for ${PROJECT_REF}`);
    }),
    assertCode("NETWORK_REQUEST_FAILED"),
  );
});
