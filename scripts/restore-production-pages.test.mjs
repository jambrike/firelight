import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";
import { CanaryError } from "./postdeploy-canary.mjs";
import {
  parseRestoreProductionPagesEnvironment,
  restoreProductionPages,
} from "./restore-production-pages.mjs";
import { expectedVersionMessage } from "./verify-worker-version.mjs";

/* global Response */

const ACCOUNT_ID = "a".repeat(32);
const ZONE_ID = "b".repeat(32);
const TOKEN = "cloudflare-token-that-must-stay-private";
const VERSION_ID = "12345678-1234-1234-1234-123456789abc";
const DEPLOYMENT_ID = "87654321-4321-4321-4321-cba987654321";
const BUILD_ID = "c".repeat(40);
const ROUTE_ID = "d".repeat(32);
const environment = {
  CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
  CLOUDFLARE_ZONE_ID: ZONE_ID,
  CLOUDFLARE_API_TOKEN: TOKEN,
  FIRELIGHT_RESTORE_CONFIRMATION: "RESTORE_FIRELIGHT_IE_PAGES",
  FIRELIGHT_RESTORE_VERSION_ID: VERSION_ID,
  FIRELIGHT_RESTORE_EXPECTED_BUILD_ID: BUILD_ID,
};

function assertCode(expectedCode) {
  return (error) => {
    assert.ok(error instanceof CanaryError);
    assert.equal(error.code, expectedCode);
    assert.equal(error.message.includes(TOKEN), false);
    return true;
  };
}

function envelope(result) {
  return { success: true, errors: [], messages: [], result };
}

function deploymentHistory(versionId = VERSION_ID) {
  const deployments = [{
    id: DEPLOYMENT_ID,
    created_on: "2026-08-09T12:00:00.000Z",
    strategy: "percentage",
    versions: [{ version_id: versionId, percentage: 100 }],
  }];
  if (versionId !== VERSION_ID) {
    deployments.push({
      id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      created_on: "2026-08-08T12:00:00.000Z",
      strategy: "percentage",
      versions: [{ version_id: VERSION_ID, percentage: 100 }],
    });
  }
  return { deployments };
}

function versionSummary() {
  return { id: VERSION_ID, number: 9, metadata: { source: "wrangler" } };
}

function versionDetail() {
  return {
    ...versionSummary(),
    annotations: {
      "workers/tag": BUILD_ID,
      "workers/message": expectedVersionMessage("production", BUILD_ID),
    },
    resources: { bindings: [
      { name: "ENVIRONMENT", type: "plain_text", text: "production" },
      { name: "BUILD_ID", type: "plain_text", text: BUILD_ID },
    ] },
  };
}

function restoreFetch({
  currentVersion = VERSION_ID,
  routeScript = "firelight-production",
  extraWorkerRoute = false,
} = {}) {
  let routePresent = true;
  return async (input, init) => {
    const url = new URL(String(input));
    assert.equal(init.redirect, "error");
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    let result;
    if (url.pathname.endsWith("/versions") && url.searchParams.has("deployable")) {
      result = { items: [versionSummary()] };
    } else if (url.pathname.endsWith(`/versions/${VERSION_ID}`)) {
      result = versionDetail();
    } else if (url.pathname.endsWith("/deployments")) {
      result = deploymentHistory(currentVersion);
    } else if (url.pathname.endsWith(`/routes/${ROUTE_ID}`)) {
      assert.equal(init.method, "DELETE");
      routePresent = false;
      result = { id: ROUTE_ID };
    } else if (url.pathname.endsWith("/workers/routes")) {
      result = routePresent
        ? [
            { id: ROUTE_ID, pattern: "firelight.ie/*", script: routeScript },
            ...(extraWorkerRoute
              ? [{
                  id: "e".repeat(32),
                  pattern: "www.firelight.ie/*",
                  script: "firelight-production",
                }]
              : []),
          ]
        : [];
    } else {
      assert.fail(`Unexpected Cloudflare call: ${url.href}`);
    }
    return new Response(JSON.stringify(envelope(result)));
  };
}

test("restore environment requires the exact production tuple and confirmation", () => {
  const configuration = parseRestoreProductionPagesEnvironment(environment);
  assert.equal(configuration.workerName, "firelight-production");
  assert.equal(configuration.zoneId, ZONE_ID);
  assert.throws(
    () => parseRestoreProductionPagesEnvironment({
      ...environment,
      FIRELIGHT_RESTORE_CONFIRMATION: "RESTORE",
    }),
    assertCode("INVALID_FIRELIGHT_RESTORE_CONFIRMATION"),
  );
});

test("restore deletes only the exact route for the current verified version", async () => {
  const result = await restoreProductionPages(
    parseRestoreProductionPagesEnvironment(environment),
    restoreFetch(),
  );
  assert.deepEqual(result, {
    routeId: ROUTE_ID,
    deploymentId: DEPLOYMENT_ID,
    versionId: VERSION_ID,
  });
});

test("restore rejects a stale version or a route assigned to another Worker", async () => {
  const configuration = parseRestoreProductionPagesEnvironment(environment);
  await assert.rejects(
    restoreProductionPages(
      configuration,
      restoreFetch({ currentVersion: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }),
    ),
    assertCode("RESTORE_VERSION_IS_NOT_CURRENT"),
  );
  await assert.rejects(
    restoreProductionPages(
      configuration,
      restoreFetch({ routeScript: "some-other-worker" }),
    ),
    assertCode("PRODUCTION_ROUTE_MISMATCH"),
  );
  await assert.rejects(
    restoreProductionPages(
      configuration,
      restoreFetch({ extraWorkerRoute: true }),
    ),
    assertCode("PRODUCTION_ROUTE_MISMATCH"),
  );
});
