import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";
import { CanaryError } from "./postdeploy-canary.mjs";
import {
  buildDeploymentsUrl,
  buildVersionDetailUrl,
  buildVersionsInventoryUrl,
  expectedVersionMessage,
  parseWorkerVersionEnvironment,
  validateDeploymentHistory,
  validateVersionDetail,
  validateVersionInventory,
  verifyWorkerVersion,
} from "./verify-worker-version.mjs";

/* global Response */

const ACCOUNT_ID = "a".repeat(32);
const TOKEN = "cloudflare-token-that-must-remain-private";
const VERSION_ID = "12345678-1234-1234-1234-123456789abc";
const BUILD_ID = "b".repeat(40);
const DEPLOYMENT_ID = "87654321-4321-4321-4321-cba987654321";
const DEPLOYED_AT = "2026-08-07T18:00:00.000Z";
const environment = {
  CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
  CLOUDFLARE_API_TOKEN: TOKEN,
  ROLLBACK_ENVIRONMENT: "production",
  ROLLBACK_WORKER_NAME: "firelight-production",
  ROLLBACK_VERSION_ID: VERSION_ID,
  ROLLBACK_EXPECTED_BUILD_ID: BUILD_ID,
};

function assertCode(expectedCode) {
  return (error) => {
    assert.ok(error instanceof CanaryError);
    assert.equal(error.code, expectedCode);
    assert.equal(error.message.includes(TOKEN), false);
    return true;
  };
}

function versionSummary(overrides = {}) {
  return {
    id: VERSION_ID,
    number: 17,
    metadata: { source: "wrangler" },
    ...overrides,
  };
}

function versionDetail(overrides = {}) {
  return {
    ...versionSummary(),
    annotations: {
      "workers/tag": BUILD_ID,
      "workers/message": expectedVersionMessage("production", BUILD_ID),
    },
    resources: {
      bindings: [
        { name: "ENVIRONMENT", type: "plain_text", text: "production" },
        { name: "BUILD_ID", type: "plain_text", text: BUILD_ID },
        { name: "SUPABASE_URL", type: "secret_text" },
      ],
    },
    ...overrides,
  };
}

function envelope(result) {
  return { success: true, errors: [], messages: [], result };
}

function deploymentHistory(overrides = {}) {
  return {
    deployments: [
      {
        id: DEPLOYMENT_ID,
        created_on: DEPLOYED_AT,
        source: "wrangler",
        strategy: "percentage",
        versions: [{ version_id: VERSION_ID, percentage: 100 }],
        ...overrides,
      },
    ],
  };
}

test("rollback environment pins the Worker name to the selected environment", () => {
  assert.deepEqual(parseWorkerVersionEnvironment(environment), {
    accountId: ACCOUNT_ID,
    apiToken: TOKEN,
    expectedEnvironment: "production",
    workerName: "firelight-production",
    versionId: VERSION_ID,
    expectedBuildId: BUILD_ID,
    expectedMessage: `firelight-release:production:${BUILD_ID}`,
  });
  assert.throws(
    () => parseWorkerVersionEnvironment({
      ...environment,
      ROLLBACK_WORKER_NAME: "firelight-staging",
    }),
    assertCode("ROLLBACK_WORKER_MISMATCH"),
  );
  assert.throws(
    () => parseWorkerVersionEnvironment({
      ...environment,
      ROLLBACK_VERSION_ID: VERSION_ID.toUpperCase(),
    }),
    assertCode("INVALID_ROLLBACK_VERSION_ID"),
  );
});

test("Cloudflare inventory and detail URLs target only the exact Worker", () => {
  const configuration = parseWorkerVersionEnvironment(environment);
  const inventory = new URL(buildVersionsInventoryUrl(configuration));
  assert.equal(inventory.origin, "https://api.cloudflare.com");
  assert.equal(
    inventory.pathname,
    `/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/firelight-production/versions`,
  );
  assert.equal(inventory.searchParams.get("deployable"), "true");
  assert.equal(inventory.href.includes(TOKEN), false);
  assert.equal(
    buildVersionDetailUrl(configuration),
    `${inventory.origin}${inventory.pathname}/${VERSION_ID}`,
  );
  assert.equal(
    buildDeploymentsUrl(configuration),
    `${inventory.origin}/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/firelight-production/deployments`,
  );
});

test("inventory and detail require persisted release metadata and bindings", () => {
  assert.deepEqual(
    validateVersionInventory({ items: [versionSummary()] }, VERSION_ID),
    { versionNumber: 17 },
  );
  const configuration = parseWorkerVersionEnvironment(environment);
  assert.deepEqual(validateVersionDetail(versionDetail(), configuration), {
    versionNumber: 17,
  });
  assert.deepEqual(validateDeploymentHistory(deploymentHistory(), VERSION_ID), {
    deploymentId: DEPLOYMENT_ID,
    deployedAt: DEPLOYED_AT,
  });

  assert.throws(
    () => validateVersionInventory({ items: [] }, VERSION_ID),
    assertCode("ROLLBACK_VERSION_NOT_IN_INVENTORY"),
  );
  for (const detail of [
    versionDetail({ annotations: { "workers/tag": "c".repeat(40) } }),
    versionDetail({ resources: { bindings: [
      { name: "ENVIRONMENT", type: "plain_text", text: "staging" },
      { name: "BUILD_ID", type: "plain_text", text: BUILD_ID },
    ] } }),
    versionDetail({ metadata: { source: "dash" } }),
  ]) {
    assert.throws(
      () => validateVersionDetail(detail, configuration),
      assertCode("WORKER_VERSION_IDENTITY_MISMATCH"),
    );
  }
  assert.throws(
    () => validateDeploymentHistory(
      deploymentHistory({ versions: [{ version_id: VERSION_ID, percentage: 50 }] }),
      VERSION_ID,
    ),
    assertCode("WORKER_VERSION_WAS_NOT_FULLY_DEPLOYED"),
  );
});

test("worker verifier performs bounded authenticated inventory and detail reads", async () => {
  const configuration = parseWorkerVersionEnvironment(environment);
  const paths = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(String(input));
    paths.push(`${url.pathname}${url.search}`);
    assert.equal(init.method, "GET");
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(init.headers.Accept, "application/json");
    assert.equal(init.redirect, "error");
    const result = url.pathname.endsWith("/deployments")
      ? deploymentHistory()
      : url.searchParams.has("deployable")
        ? { items: [versionSummary()] }
        : versionDetail();
    return new Response(JSON.stringify(envelope(result)));
  };
  assert.deepEqual(await verifyWorkerVersion(configuration, fetchImpl), {
    environment: "production",
    workerName: "firelight-production",
    versionId: VERSION_ID,
    versionNumber: 17,
    buildId: BUILD_ID,
    deploymentId: DEPLOYMENT_ID,
    deployedAt: DEPLOYED_AT,
  });
  assert.deepEqual(paths, [
    `/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/firelight-production/versions?deployable=true`,
    `/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/firelight-production/versions/${VERSION_ID}`,
    `/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/firelight-production/deployments`,
  ]);
});

test("Cloudflare failures use stable codes without exposing provider details", async () => {
  const configuration = parseWorkerVersionEnvironment(environment);
  await assert.rejects(
    verifyWorkerVersion(
      configuration,
      async () => new Response(JSON.stringify({
        success: false,
        errors: [{ message: `bad ${TOKEN}` }],
        messages: [],
        result: {},
      }), { status: 403 }),
    ),
    assertCode("CLOUDFLARE_AUTH_FAILED"),
  );
});
