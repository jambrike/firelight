import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";
import { CanaryError } from "./postdeploy-canary.mjs";
import {
  COMPILER_CONNECTION_FINGERPRINT_DOMAIN,
  COMPILER_PROTOCOL_VERSION,
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
const COMPILER_HOST =
  "abcdefghij.lambda-url.eu-west-1.on.aws";
const COMPILER_TOKEN = "compiler-token-that-must-stay-private";
const COMPILER_BUILD_ID = "c".repeat(40);
const COMPILER_IMAGE_DIGEST = `sha256:${"d".repeat(64)}`;
const ANCHOR_SET_SHA256 = "e".repeat(64);
const PROJECT_REF_IDENTITY_SHA256 = "f".repeat(64);
const ORGANIZATION_IDENTITY_SHA256 = "1".repeat(64);
const environment = {
  CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
  CLOUDFLARE_API_TOKEN: TOKEN,
  FIRELIGHT_RELEASE_ENVIRONMENT: "production",
  FIRELIGHT_RELEASE_WORKER_NAME: "firelight-production",
  FIRELIGHT_RELEASE_BUILD_ID: BUILD_ID,
  COMPILER_SERVICE_URL: `https://${COMPILER_HOST}/`,
  COMPILER_SERVICE_ORIGIN: `https://${COMPILER_HOST}`,
  COMPILER_SERVICE_HOST: COMPILER_HOST,
  COMPILER_SERVICE_TOKEN: COMPILER_TOKEN,
  COMPILER_SERVICE_BUILD_ID: COMPILER_BUILD_ID,
  COMPILER_SERVICE_IMAGE_DIGEST: COMPILER_IMAGE_DIGEST,
  FIRELIGHT_SUPABASE_ANCHOR_SET_SHA256: ANCHOR_SET_SHA256,
  FIRELIGHT_SUPABASE_PROJECT_REF_IDENTITY_SHA256:
    PROJECT_REF_IDENTITY_SHA256,
  FIRELIGHT_SUPABASE_ORGANIZATION_IDENTITY_SHA256:
    ORGANIZATION_IDENTITY_SHA256,
};

function assertCode(expectedCode) {
  return (error) => {
    assert.ok(error instanceof CanaryError);
    assert.equal(error.code, expectedCode);
    assert.equal(error.message.includes(TOKEN), false);
    assert.equal(error.message.includes(COMPILER_TOKEN), false);
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
  assert.equal(parsed.compilerProtocolVersion, COMPILER_PROTOCOL_VERSION);
  assert.match(parsed.compilerConnectionSha256, /^[0-9a-f]{64}$/u);
  assert.match(COMPILER_CONNECTION_FINGERPRINT_DOMAIN, /\.v1$/u);
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
  }, {
    requirePath: true,
    requireApiToken: false,
    requireCompilerDeploymentIdentity: false,
  });
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
    const body = url.searchParams.has("deployable")
      ? {
          ...envelope(result),
          errors: null,
          messages: null,
          result_info: { page: 1, per_page: 20 },
        }
      : envelope(result);
    return new Response(JSON.stringify(body));
  });
  assert.deepEqual(evidence, {
    schema: RELEASE_EVIDENCE_SCHEMA,
    version: RELEASE_EVIDENCE_VERSION,
    accountId: ACCOUNT_ID,
    environment: "production",
    workerName: "firelight-production",
    buildId: BUILD_ID,
    compilerProtocolVersion: COMPILER_PROTOCOL_VERSION,
    compilerConnectionSha256: configuration.compilerConnectionSha256,
    compilerBuildId: COMPILER_BUILD_ID,
    compilerImageDigest: COMPILER_IMAGE_DIGEST,
    supabaseAnchorSetSha256: ANCHOR_SET_SHA256,
    supabaseProjectRefIdentitySha256: PROJECT_REF_IDENTITY_SHA256,
    supabaseOrganizationIdentitySha256: ORGANIZATION_IDENTITY_SHA256,
    progressServiceWrites: PROGRESS_SERVICE_WRITES_CAPABILITY,
    versionId: VERSION_ID,
    deploymentId: DEPLOYMENT_ID,
    deployedAt: DEPLOYED_AT,
  });
  assert.equal(calls.filter((path) => path.endsWith("/deployments")).length, 2);
  const serialized = JSON.stringify(evidence);
  for (const secret of [TOKEN, COMPILER_TOKEN]) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.equal(serialized.includes(COMPILER_HOST), false);
});

test("artifact validation binds current logical targets but retains compiler deployment audit metadata", () => {
  const configuration = parseReleaseEvidenceEnvironment(environment);
  const evidence = {
    schema: RELEASE_EVIDENCE_SCHEMA,
    version: RELEASE_EVIDENCE_VERSION,
    accountId: ACCOUNT_ID,
    environment: "production",
    workerName: "firelight-production",
    buildId: BUILD_ID,
    compilerProtocolVersion: COMPILER_PROTOCOL_VERSION,
    compilerConnectionSha256: configuration.compilerConnectionSha256,
    compilerBuildId: COMPILER_BUILD_ID,
    compilerImageDigest: COMPILER_IMAGE_DIGEST,
    supabaseAnchorSetSha256: ANCHOR_SET_SHA256,
    supabaseProjectRefIdentitySha256: PROJECT_REF_IDENTITY_SHA256,
    supabaseOrganizationIdentitySha256: ORGANIZATION_IDENTITY_SHA256,
    progressServiceWrites: PROGRESS_SERVICE_WRITES_CAPABILITY,
    versionId: VERSION_ID,
    deploymentId: DEPLOYMENT_ID,
    deployedAt: DEPLOYED_AT,
  };
  assert.equal(validateReleaseEvidence(evidence, configuration), evidence);
  assert.equal(
    validateReleaseEvidence(evidence, {
      ...configuration,
      compilerBuildId: "9".repeat(40),
      compilerImageDigest: `sha256:${"8".repeat(64)}`,
    }),
    evidence,
  );
  assert.throws(
    () => validateReleaseEvidence({ ...evidence, buildId: "c".repeat(40) }, configuration),
    assertCode("RELEASE_EVIDENCE_MISMATCH"),
  );
  assert.throws(
    () =>
      validateReleaseEvidence(
        { ...evidence, compilerProtocolVersion: 2 },
        configuration,
      ),
    assertCode("RELEASE_EVIDENCE_MISMATCH"),
  );
  assert.throws(
    () =>
      validateReleaseEvidence(
        { ...evidence, compilerConnectionSha256: "2".repeat(64) },
        configuration,
      ),
    assertCode("RELEASE_EVIDENCE_MISMATCH"),
  );
  assert.throws(
    () =>
      validateReleaseEvidence(
        { ...evidence, supabaseAnchorSetSha256: "3".repeat(64) },
        configuration,
      ),
    assertCode("RELEASE_EVIDENCE_MISMATCH"),
  );
  assert.throws(
    () =>
      validateReleaseEvidence(
        { ...evidence, supabaseProjectRefIdentitySha256: "4".repeat(64) },
        configuration,
      ),
    assertCode("RELEASE_EVIDENCE_MISMATCH"),
  );
  assert.throws(
    () =>
      validateReleaseEvidence(
        { ...evidence, supabaseOrganizationIdentitySha256: "5".repeat(64) },
        configuration,
      ),
    assertCode("RELEASE_EVIDENCE_MISMATCH"),
  );
  assert.throws(
    () => validateReleaseEvidence({
      ...evidence,
      compilerBuildId: "0".repeat(40),
    }, configuration),
    assertCode("RELEASE_EVIDENCE_MISMATCH"),
  );
  assert.throws(
    () => validateReleaseEvidence({
      ...evidence,
      progressServiceWrites: "browser-direct-v1",
    }, configuration),
    assertCode("RELEASE_EVIDENCE_MISMATCH"),
  );
  const {
    progressServiceWrites: _capability,
    compilerProtocolVersion: _protocol,
    ...legacyEvidence
  } = evidence;
  assert.equal(_capability, PROGRESS_SERVICE_WRITES_CAPABILITY);
  assert.equal(_protocol, COMPILER_PROTOCOL_VERSION);
  assert.throws(
    () => validateReleaseEvidence({ ...legacyEvidence, version: 1 }, configuration),
    assertCode("RELEASE_EVIDENCE_MISMATCH"),
  );
});

test("compiler connection fingerprints are canonical, secret-free outputs", () => {
  const parsed = parseReleaseEvidenceEnvironment(environment);
  const equivalent = parseReleaseEvidenceEnvironment({
    ...environment,
    COMPILER_SERVICE_URL: `https://${COMPILER_HOST}`,
  });
  const rotatedCredential = parseReleaseEvidenceEnvironment({
    ...environment,
    COMPILER_SERVICE_TOKEN: `${COMPILER_TOKEN}-rotated`,
  });
  assert.equal(
    equivalent.compilerConnectionSha256,
    parsed.compilerConnectionSha256,
  );
  assert.notEqual(
    rotatedCredential.compilerConnectionSha256,
    parsed.compilerConnectionSha256,
  );
  assert.equal(parsed.compilerConnectionSha256.includes(COMPILER_TOKEN), false);
  assert.equal(parsed.compilerConnectionSha256.includes(COMPILER_HOST), false);

  for (const invalidEnvironment of [
    { COMPILER_SERVICE_URL: `http://${COMPILER_HOST}/` },
    { COMPILER_SERVICE_ORIGIN: `https://${COMPILER_HOST}/unexpected` },
    { COMPILER_SERVICE_HOST: "compiler.example.com" },
    { COMPILER_SERVICE_TOKEN: "short" },
  ]) {
    assert.throws(
      () => parseReleaseEvidenceEnvironment({
        ...environment,
        ...invalidEnvironment,
      }),
      assertCode("COMPILER_CONNECTION_INVALID"),
    );
  }
  assert.throws(
    () => parseReleaseEvidenceEnvironment({
      ...environment,
      COMPILER_SERVICE_BUILD_ID: "0".repeat(40),
    }),
    assertCode("INVALID_COMPILER_SERVICE_BUILD_ID"),
  );
});

test("release evidence, Worker gateway, and compiler probe share one protocol", async () => {
  const [workerGateway, compilerService] = await Promise.all([
    readFile(new URL("../worker/compiler-gateway.ts", import.meta.url), "utf8"),
    readFile(new URL("../compiler-service/app.py", import.meta.url), "utf8"),
  ]);
  assert.match(
    workerGateway,
    new RegExp(
      `const COMPILER_PROTOCOL_VERSION = ${String(COMPILER_PROTOCOL_VERSION)};`,
      "u",
    ),
  );
  assert.match(
    compilerService,
    new RegExp(
      `COMPILER_PROTOCOL_VERSION = ${String(COMPILER_PROTOCOL_VERSION)}\\n`,
      "u",
    ),
  );
});
