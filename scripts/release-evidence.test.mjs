import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";
import { CanaryError } from "./postdeploy-canary.mjs";
import {
  PROGRESS_SERVICE_WRITES_CAPABILITY,
  RELEASE_EVIDENCE_SCHEMA,
  RELEASE_EVIDENCE_VERSION,
  captureReleaseEvidence,
  parseReleaseEvidenceEnvironment,
  validateReleaseEvidence,
} from "./release-evidence.mjs";
import { expectedVersionMessage } from "./verify-worker-version.mjs";

/* global Response */

const ACCOUNT_ID = "a".repeat(32);
const TOKEN = "cloudflare-token-that-must-stay-private";
const BUILD_ID = "b".repeat(40);
const VERSION_ID = "12345678-1234-1234-1234-123456789abc";
const DEPLOYMENT_ID = "87654321-4321-4321-4321-cba987654321";
const DEPLOYED_AT = "2026-08-07T18:00:00.000Z";
const environment = {
  CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
  CLOUDFLARE_API_TOKEN: TOKEN,
  FIRELIGHT_RELEASE_ENVIRONMENT: "production",
  FIRELIGHT_RELEASE_WORKER_NAME: "firelight-production",
  FIRELIGHT_RELEASE_BUILD_ID: BUILD_ID,
};

function assertCode(expectedCode) {
  return (error) => {
    assert.ok(error instanceof CanaryError);
    assert.equal(error.code, expectedCode);
    assert.equal(error.message.includes(TOKEN), false);
    return true;
  };
}

function deployments() {
  return {
    deployments: [{
      id: DEPLOYMENT_ID,
      created_on: DEPLOYED_AT,
      source: "wrangler",
      strategy: "percentage",
      versions: [{ version_id: VERSION_ID, percentage: 100 }],
    }],
  };
}

function versionSummary() {
  return { id: VERSION_ID, number: 7, metadata: { source: "wrangler" } };
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

function envelope(result) {
  return { success: true, errors: [], messages: [], result };
}

test("release evidence environment pins the exact account, Worker, and build", () => {
  const parsed = parseReleaseEvidenceEnvironment(environment);
  assert.equal(parsed.workerName, "firelight-production");
  assert.equal(parsed.buildId, BUILD_ID);
  assert.throws(
    () => parseReleaseEvidenceEnvironment({
      ...environment,
      FIRELIGHT_RELEASE_WORKER_NAME: "firelight-staging",
    }),
    assertCode("FIRELIGHT_RELEASE_WORKER_MISMATCH"),
  );
  const artifactConfiguration = parseReleaseEvidenceEnvironment({
    ...environment,
    CLOUDFLARE_API_TOKEN: undefined,
    FIRELIGHT_RELEASE_EVIDENCE_PATH: "/tmp/firelight-release-evidence.json",
  }, { requirePath: true, requireApiToken: false });
  assert.equal("apiToken" in artifactConfiguration, false);
  assert.equal(
    artifactConfiguration.evidencePath,
    "/tmp/firelight-release-evidence.json",
  );
});

test("capture binds the latest 100% deployment to verified version metadata", async () => {
  const configuration = parseReleaseEvidenceEnvironment(environment);
  const calls = [];
  const evidence = await captureReleaseEvidence(configuration, async (input) => {
    const url = new URL(String(input));
    calls.push(`${url.pathname}${url.search}`);
    const result = url.pathname.endsWith("/deployments")
      ? deployments()
      : url.searchParams.has("deployable")
        ? { items: [versionSummary()] }
        : versionDetail();
    return new Response(JSON.stringify(envelope(result)));
  });
  assert.deepEqual(evidence, {
    schema: RELEASE_EVIDENCE_SCHEMA,
    version: RELEASE_EVIDENCE_VERSION,
    accountId: ACCOUNT_ID,
    environment: "production",
    workerName: "firelight-production",
    buildId: BUILD_ID,
    progressServiceWrites: PROGRESS_SERVICE_WRITES_CAPABILITY,
    versionId: VERSION_ID,
    deploymentId: DEPLOYMENT_ID,
    deployedAt: DEPLOYED_AT,
  });
  assert.equal(calls.filter((path) => path.endsWith("/deployments")).length, 2);
});

test("artifact validation rejects a self-asserted or cross-environment tuple", () => {
  const configuration = parseReleaseEvidenceEnvironment(environment);
  const evidence = {
    schema: RELEASE_EVIDENCE_SCHEMA,
    version: RELEASE_EVIDENCE_VERSION,
    accountId: ACCOUNT_ID,
    environment: "production",
    workerName: "firelight-production",
    buildId: BUILD_ID,
    progressServiceWrites: PROGRESS_SERVICE_WRITES_CAPABILITY,
    versionId: VERSION_ID,
    deploymentId: DEPLOYMENT_ID,
    deployedAt: DEPLOYED_AT,
  };
  assert.equal(validateReleaseEvidence(evidence, configuration), evidence);
  assert.throws(
    () => validateReleaseEvidence({ ...evidence, buildId: "c".repeat(40) }, configuration),
    assertCode("RELEASE_EVIDENCE_MISMATCH"),
  );
  assert.throws(
    () => validateReleaseEvidence({
      ...evidence,
      progressServiceWrites: "browser-direct-v1",
    }, configuration),
    assertCode("RELEASE_EVIDENCE_MISMATCH"),
  );
  const { progressServiceWrites: _capability, ...legacyEvidence } = evidence;
  assert.equal(_capability, PROGRESS_SERVICE_WRITES_CAPABILITY);
  assert.throws(
    () => validateReleaseEvidence({ ...legacyEvidence, version: 1 }, configuration),
    assertCode("RELEASE_EVIDENCE_MISMATCH"),
  );
});
