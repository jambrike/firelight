import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { deflateRawSync } from "node:zlib";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { URL } from "node:url";
import {
  CANONICAL_REPOSITORY,
  COMPILER_STAGING_EVIDENCE_FILENAME,
  buildCompilerStagingEvidence,
  captureCompilerStagingEvidence,
  parseCompilerStagingCaptureEnvironment,
  serializeCompilerStagingEvidence,
  sha256,
  validateCompilerStagingEvidence,
} from "./capture-compiler-staging-evidence.mjs";
import { CanaryError } from "./postdeploy-canary.mjs";
import {
  buildCompilerRunArtifactsUrl,
  buildCompilerWorkflowRunUrl,
  extractCompilerStagingEvidenceBytes,
  parseCompilerStagingArtifact,
  parseCompilerStagingVerificationEnvironment,
  parseCompilerWorkflowRun,
  parseDownloadedCompilerStagingEvidence,
  verifyCompilerStagingEvidence,
} from "./verify-compiler-staging-evidence.mjs";

/* global AbortSignal, Response */

const COMMIT_SHA = "a".repeat(40);
const IMAGE_DIGEST = `sha256:${"b".repeat(64)}`;
const BACKEND_LOCATION_SHA256 = "1".repeat(64);
const AWS_ACCOUNT_ID_SHA256 = "9".repeat(64);
const STATE_KMS_KEY_SHA256 = "2".repeat(64);
const AUTH_SECRET_SHA256 = "3".repeat(64);
const VPC_CIDR_SHA256 = "4".repeat(64);
const TOKEN = "github-token-that-must-never-be-logged";
const RUN_ID = 123456789;
const RUN_NUMBER = 42;
const RUN_ATTEMPT = 2;
const ARTIFACT_ID = 987654321;
const REPOSITORY_ID = 456789123;
const ARTIFACT_NAME = `compiler-staging-evidence-${RUN_ID}-${RUN_ATTEMPT}`;
const WORKFLOW_REF = `${CANONICAL_REPOSITORY}/.github/workflows/deploy-compiler.yml@refs/heads/main`;

function assertCode(expectedCode) {
  return (error) => {
    assert.ok(error instanceof CanaryError);
    assert.equal(error.code, expectedCode);
    assert.equal(error.message.includes(TOKEN), false);
    return true;
  };
}

function captureEnvironment(runnerTemp) {
  return {
    GITHUB_ACTIONS: "true",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_API_URL: "https://api.github.com",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REPOSITORY: CANONICAL_REPOSITORY,
    GITHUB_REF: "refs/heads/main",
    GITHUB_JOB: "apply",
    GITHUB_WORKFLOW_REF: WORKFLOW_REF,
    GITHUB_WORKFLOW_SHA: COMMIT_SHA,
    GITHUB_SHA: COMMIT_SHA,
    GITHUB_RUN_ID: String(RUN_ID),
    GITHUB_RUN_NUMBER: String(RUN_NUMBER),
    GITHUB_RUN_ATTEMPT: String(RUN_ATTEMPT),
    RUNNER_TEMP: runnerTemp,
    FIRELIGHT_COMPILER_ENVIRONMENT: "staging",
    FIRELIGHT_COMPILER_IMAGE_DIGEST: IMAGE_DIGEST,
    FIRELIGHT_COMPILER_BACKEND_LOCATION_SHA256: BACKEND_LOCATION_SHA256,
    FIRELIGHT_COMPILER_AWS_ACCOUNT_ID_SHA256: AWS_ACCOUNT_ID_SHA256,
    FIRELIGHT_COMPILER_STATE_KMS_KEY_SHA256: STATE_KMS_KEY_SHA256,
    FIRELIGHT_COMPILER_AUTH_SECRET_SHA256: AUTH_SECRET_SHA256,
    FIRELIGHT_COMPILER_VPC_CIDR_SHA256: VPC_CIDR_SHA256,
    FIRELIGHT_COMPILER_STAGING_EVIDENCE_PATH: join(
      runnerTemp,
      COMPILER_STAGING_EVIDENCE_FILENAME,
    ),
  };
}

function verificationEnvironment(evidenceSha256) {
  return {
    GITHUB_ACTIONS: "true",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_API_URL: "https://api.github.com",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REPOSITORY: CANONICAL_REPOSITORY,
    GITHUB_REF: "refs/heads/main",
    GITHUB_WORKFLOW_REF: WORKFLOW_REF,
    GITHUB_WORKFLOW_SHA: COMMIT_SHA,
    GITHUB_SHA: COMMIT_SHA,
    GITHUB_TOKEN: TOKEN,
    FIRELIGHT_COMPILER_ENVIRONMENT: "production",
    FIRELIGHT_COMPILER_STAGING_RUN_ID: String(RUN_ID),
    FIRELIGHT_COMPILER_STAGING_EVIDENCE_SHA256: evidenceSha256,
  };
}

function configurationForEvidence() {
  return {
    commitSha: COMMIT_SHA,
    imageDigest: IMAGE_DIGEST,
    backendLocationSha256: BACKEND_LOCATION_SHA256,
    awsAccountIdSha256: AWS_ACCOUNT_ID_SHA256,
    stateKmsKeySha256: STATE_KMS_KEY_SHA256,
    authSecretSha256: AUTH_SECRET_SHA256,
    vpcCidrSha256: VPC_CIDR_SHA256,
    runId: RUN_ID,
    runNumber: RUN_NUMBER,
    runAttempt: RUN_ATTEMPT,
    artifactName: ARTIFACT_NAME,
  };
}

function successfulRun(overrides = {}) {
  return {
    id: RUN_ID,
    run_number: RUN_NUMBER,
    run_attempt: RUN_ATTEMPT,
    head_sha: COMMIT_SHA,
    head_branch: "main",
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    path: ".github/workflows/deploy-compiler.yml@main",
    repository: {
      id: REPOSITORY_ID,
      full_name: CANONICAL_REPOSITORY,
    },
    ...overrides,
  };
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ ((value & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function zipSingleFile(
  bytes,
  { filename = COMPILER_STAGING_EVIDENCE_FILENAME, compression = 8 } = {},
) {
  const filenameBytes = Buffer.from(filename, "utf8");
  const content = Buffer.from(bytes);
  const compressed = compression === 8 ? deflateRawSync(content) : content;
  const checksum = crc32(content);
  const flags = 0x0800;

  const local = Buffer.alloc(30 + filenameBytes.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(flags, 6);
  local.writeUInt16LE(compression, 8);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(filenameBytes.length, 26);
  filenameBytes.copy(local, 30);

  const centralOffset = local.length + compressed.length;
  const central = Buffer.alloc(46 + filenameBytes.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(flags, 8);
  central.writeUInt16LE(compression, 10);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(filenameBytes.length, 28);
  filenameBytes.copy(central, 46);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, compressed, central, eocd]);
}

function fixture() {
  const evidence = buildCompilerStagingEvidence(configurationForEvidence());
  const evidenceBytes = serializeCompilerStagingEvidence(evidence);
  const archive = zipSingleFile(evidenceBytes);
  const configuration = parseCompilerStagingVerificationEnvironment(
    verificationEnvironment(sha256(evidenceBytes)),
  );
  const run = parseCompilerWorkflowRun(successfulRun(), configuration);
  return { evidence, evidenceBytes, archive, configuration, run };
}

function artifactResponse(archive, overrides = {}) {
  return {
    total_count: 1,
    artifacts: [
      {
        id: ARTIFACT_ID,
        name: ARTIFACT_NAME,
        size_in_bytes: archive.length,
        expired: false,
        digest: `sha256:${sha256(archive)}`,
        archive_download_url: `https://api.github.com/repos/jambrike/firelight/actions/artifacts/${ARTIFACT_ID}/zip`,
        workflow_run: {
          id: RUN_ID,
          repository_id: REPOSITORY_ID,
          head_repository_id: REPOSITORY_ID,
          head_branch: "main",
          head_sha: COMMIT_SHA,
        },
        ...overrides,
      },
    ],
  };
}

test("capture accepts only the canonical trusted staging apply context", () => {
  const parsed = parseCompilerStagingCaptureEnvironment(
    captureEnvironment("/runner/temp"),
  );
  assert.deepEqual(parsed, {
    commitSha: COMMIT_SHA,
    imageDigest: IMAGE_DIGEST,
    backendLocationSha256: BACKEND_LOCATION_SHA256,
    awsAccountIdSha256: AWS_ACCOUNT_ID_SHA256,
    stateKmsKeySha256: STATE_KMS_KEY_SHA256,
    authSecretSha256: AUTH_SECRET_SHA256,
    vpcCidrSha256: VPC_CIDR_SHA256,
    runId: RUN_ID,
    runNumber: RUN_NUMBER,
    runAttempt: RUN_ATTEMPT,
    runnerTemp: "/runner/temp",
    evidencePath: `/runner/temp/${COMPILER_STAGING_EVIDENCE_FILENAME}`,
    artifactName: ARTIFACT_NAME,
  });

  for (const [name, value, code] of [
    ["GITHUB_ACTIONS", "false", "INVALID_GITHUB_ACTIONS"],
    ["GITHUB_REPOSITORY", "fork/firelight", "INVALID_GITHUB_REPOSITORY"],
    ["GITHUB_REF", "refs/heads/release", "INVALID_GITHUB_REF"],
    ["GITHUB_JOB", "plan", "INVALID_GITHUB_JOB"],
    [
      "FIRELIGHT_COMPILER_ENVIRONMENT",
      "production",
      "INVALID_FIRELIGHT_COMPILER_ENVIRONMENT",
    ],
    ["GITHUB_WORKFLOW_SHA", "c".repeat(40), "INVALID_GITHUB_WORKFLOW_SHA"],
  ]) {
    assert.throws(
      () =>
        parseCompilerStagingCaptureEnvironment({
          ...captureEnvironment("/runner/temp"),
          [name]: value,
        }),
      assertCode(code),
    );
  }
});

test("capture writes one exclusive 0600 JSON file and returns its exact hash", async () => {
  const runnerTemp = await mkdtemp(
    join(tmpdir(), "firelight-compiler-evidence-"),
  );
  try {
    const configuration = parseCompilerStagingCaptureEnvironment(
      captureEnvironment(runnerTemp),
    );
    const result = await captureCompilerStagingEvidence(configuration);
    const bytes = await readFile(configuration.evidencePath);
    const fileStats = await stat(configuration.evidencePath);
    assert.equal(fileStats.mode & 0o777, 0o600);
    assert.equal(result.evidenceSha256, sha256(bytes));
    assert.equal(result.artifactName, ARTIFACT_NAME);
    assert.deepEqual(JSON.parse(bytes.toString("utf8")), result.evidence);
    assert.equal(result.evidence.environment, "staging");
    assert.equal(result.evidence.repository, CANONICAL_REPOSITORY);
    assert.equal(result.evidence.commitSha, COMMIT_SHA);
    assert.equal(result.evidence.imageDigest, IMAGE_DIGEST);
    assert.equal(
      result.evidence.backendLocationSha256,
      BACKEND_LOCATION_SHA256,
    );
    assert.equal(result.evidence.awsAccountIdSha256, AWS_ACCOUNT_ID_SHA256);
    assert.equal(result.evidence.stateKmsKeySha256, STATE_KMS_KEY_SHA256);
    assert.equal(result.evidence.authSecretSha256, AUTH_SECRET_SHA256);
    assert.equal(result.evidence.vpcCidrSha256, VPC_CIDR_SHA256);
    assert.equal(result.evidence.runId, RUN_ID);

    await assert.rejects(
      captureCompilerStagingEvidence(configuration),
      assertCode("COMPILER_STAGING_EVIDENCE_WRITE_FAILED"),
    );
  } finally {
    await rm(runnerTemp, { recursive: true, force: true });
  }
});

test("evidence schema rejects cross-commit, cross-run, or mutable image claims", () => {
  const configuration = configurationForEvidence();
  const evidence = buildCompilerStagingEvidence(configuration);
  assert.equal(
    validateCompilerStagingEvidence(evidence, configuration),
    evidence,
  );
  for (const mutation of [
    { commitSha: "c".repeat(40) },
    { environment: "production" },
    { repository: "fork/firelight" },
    { imageDigest: "b".repeat(64) },
    { backendLocationSha256: "5".repeat(64) },
    { awsAccountIdSha256: "0".repeat(64) },
    { stateKmsKeySha256: "6".repeat(64) },
    { authSecretSha256: "7".repeat(64) },
    { vpcCidrSha256: "8".repeat(64) },
    { runId: RUN_ID + 1 },
    { artifactName: "compiler-staging-evidence-latest" },
    { surprise: true },
  ]) {
    assert.throws(
      () =>
        validateCompilerStagingEvidence(
          { ...evidence, ...mutation },
          configuration,
        ),
      assertCode("COMPILER_STAGING_EVIDENCE_MISMATCH"),
    );
  }
});

test("verification environment requires explicit run and evidence fingerprints", () => {
  const expectedHash = "d".repeat(64);
  const parsed = parseCompilerStagingVerificationEnvironment(
    verificationEnvironment(expectedHash),
  );
  assert.equal(parsed.expectedRunId, RUN_ID);
  assert.equal(parsed.expectedEvidenceSha256, expectedHash);
  assert.equal(parsed.commitSha, COMMIT_SHA);
  assert.equal(parsed.owner, "jambrike");

  assert.throws(
    () =>
      parseCompilerStagingVerificationEnvironment({
        ...verificationEnvironment(expectedHash),
        FIRELIGHT_COMPILER_STAGING_RUN_ID: "0",
      }),
    assertCode("INVALID_FIRELIGHT_COMPILER_STAGING_RUN_ID"),
  );
  assert.throws(
    () =>
      parseCompilerStagingVerificationEnvironment({
        ...verificationEnvironment(expectedHash),
        FIRELIGHT_COMPILER_STAGING_EVIDENCE_SHA256: "D".repeat(64),
      }),
    assertCode("INVALID_FIRELIGHT_COMPILER_STAGING_EVIDENCE_SHA256"),
  );
});

test("GitHub URLs pin the exact workflow, SHA, run, and artifact name", () => {
  const { configuration, run } = fixture();
  const runsUrl = new URL(buildCompilerWorkflowRunUrl(configuration));
  assert.equal(
    runsUrl.pathname,
    `/repos/jambrike/firelight/actions/runs/${RUN_ID}`,
  );
  assert.equal(runsUrl.search, "");
  const artifactsUrl = new URL(
    buildCompilerRunArtifactsUrl(configuration, run),
  );
  assert.equal(
    artifactsUrl.pathname,
    `/repos/jambrike/firelight/actions/runs/${RUN_ID}/artifacts`,
  );
  assert.equal(artifactsUrl.searchParams.get("name"), ARTIFACT_NAME);
  assert.equal(artifactsUrl.searchParams.get("per_page"), "2");
  assert.equal(runsUrl.href.includes(TOKEN), false);
});

test("the explicit workflow run must be one successful exact-SHA dispatch", () => {
  const { configuration } = fixture();
  assert.equal(
    parseCompilerWorkflowRun(successfulRun(), configuration).artifactName,
    ARTIFACT_NAME,
  );
  for (const overrides of [
    { id: RUN_ID + 1 },
    { head_sha: "c".repeat(40) },
    { head_branch: "release" },
    { event: "push" },
    { conclusion: "failure" },
    { path: ".github/workflows/ci.yml@main" },
    { repository: { id: REPOSITORY_ID, full_name: "fork/firelight" } },
  ]) {
    assert.throws(
      () => parseCompilerWorkflowRun(successfulRun(overrides), configuration),
      assertCode("COMPILER_STAGING_RUN_MISMATCH"),
    );
  }
});

test("artifact metadata must be unique, live, immutable, and owned by the run", () => {
  const { archive, configuration, run } = fixture();
  const artifact = parseCompilerStagingArtifact(
    artifactResponse(archive),
    configuration,
    run,
  );
  assert.equal(artifact.artifactId, ARTIFACT_ID);
  assert.equal(artifact.archiveSha256, sha256(archive));

  for (const overrides of [
    { expired: true },
    { digest: null },
    { name: "compiler-staging-evidence-latest" },
    {
      workflow_run: {
        id: RUN_ID + 1,
        repository_id: REPOSITORY_ID,
        head_repository_id: REPOSITORY_ID,
        head_branch: "main",
        head_sha: COMMIT_SHA,
      },
    },
    { archive_download_url: "https://example.test/archive.zip" },
  ]) {
    assert.throws(
      () =>
        parseCompilerStagingArtifact(
          artifactResponse(archive, overrides),
          configuration,
          run,
        ),
      assertCode("COMPILER_STAGING_ARTIFACT_MISMATCH"),
    );
  }
});

test("bounded ZIP parser accepts only the one canonical evidence file", () => {
  const { archive, evidenceBytes, configuration, run, evidence } = fixture();
  assert.deepEqual(extractCompilerStagingEvidenceBytes(archive), evidenceBytes);
  assert.equal(
    parseDownloadedCompilerStagingEvidence(
      extractCompilerStagingEvidenceBytes(archive),
      configuration,
      run,
    ).imageDigest,
    evidence.imageDigest,
  );
  assert.deepEqual(
    extractCompilerStagingEvidenceBytes(
      zipSingleFile(evidenceBytes, { compression: 0 }),
    ),
    evidenceBytes,
  );
  assert.throws(
    () =>
      extractCompilerStagingEvidenceBytes(
        zipSingleFile(evidenceBytes, { filename: "../evidence.json" }),
      ),
    assertCode("INVALID_COMPILER_STAGING_ARTIFACT_ZIP"),
  );

  const multipleEntries = Buffer.from(archive);
  multipleEntries.writeUInt16LE(2, multipleEntries.length - 14);
  multipleEntries.writeUInt16LE(2, multipleEntries.length - 12);
  assert.throws(
    () => extractCompilerStagingEvidenceBytes(multipleEntries),
    assertCode("INVALID_COMPILER_STAGING_ARTIFACT_ZIP"),
  );
});

test("verification performs four bounded requests without forwarding auth on redirect", async () => {
  const { archive, configuration } = fixture();
  const redirect =
    "https://productionresultssa0.blob.core.windows.net/actions-results/run/artifact.zip?sig=private-signed-value";
  let request = 0;
  const result = await verifyCompilerStagingEvidence(
    configuration,
    async (input, init) => {
      request += 1;
      const url = new URL(String(input));
      assert.ok(init.signal instanceof AbortSignal);
      if (request === 1) {
        assert.equal(init.redirect, "error");
        assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
        assert.equal(url.pathname.endsWith(`/actions/runs/${RUN_ID}`), true);
        return new Response(JSON.stringify(successfulRun()));
      }
      if (request === 2) {
        assert.equal(init.redirect, "error");
        assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
        assert.equal(url.searchParams.get("name"), ARTIFACT_NAME);
        return new Response(JSON.stringify(artifactResponse(archive)));
      }
      if (request === 3) {
        assert.equal(init.redirect, "manual");
        assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
        return new Response(null, {
          status: 302,
          headers: { Location: redirect },
        });
      }
      assert.equal(request, 4);
      assert.equal(url.href, redirect);
      assert.equal(init.redirect, "error");
      assert.equal("Authorization" in init.headers, false);
      return new Response(archive, {
        headers: { "Content-Length": String(archive.length) },
      });
    },
  );
  assert.deepEqual(result, {
    imageDigest: IMAGE_DIGEST,
    backendLocationSha256: BACKEND_LOCATION_SHA256,
    awsAccountIdSha256: AWS_ACCOUNT_ID_SHA256,
    stateKmsKeySha256: STATE_KMS_KEY_SHA256,
    authSecretSha256: AUTH_SECRET_SHA256,
    vpcCidrSha256: VPC_CIDR_SHA256,
    runId: RUN_ID,
    evidenceSha256: configuration.expectedEvidenceSha256,
  });
  assert.equal(request, 4);
});

test("redirect, archive, evidence, and API failures stay stable and redacted", async () => {
  const { archive, configuration } = fixture();

  await assert.rejects(
    verifyCompilerStagingEvidence(
      configuration,
      async () =>
        new Response(JSON.stringify({ message: `rejected ${TOKEN}` }), {
          status: 403,
        }),
    ),
    assertCode("GITHUB_AUTH_FAILED"),
  );

  let request = 0;
  await assert.rejects(
    verifyCompilerStagingEvidence(configuration, async () => {
      request += 1;
      if (request === 1) {
        return new Response(JSON.stringify(successfulRun()));
      }
      if (request === 2) {
        return new Response(JSON.stringify(artifactResponse(archive)));
      }
      return new Response(null, {
        status: 302,
        headers: {
          Location: `https://attacker.example/${TOKEN}?sig=secret`,
        },
      });
    }),
    assertCode("INVALID_ARTIFACT_REDIRECT"),
  );

  const wrongHashConfiguration = {
    ...configuration,
    expectedEvidenceSha256: "e".repeat(64),
  };
  const evidenceBytes = extractCompilerStagingEvidenceBytes(archive);
  assert.throws(
    () =>
      parseDownloadedCompilerStagingEvidence(
        evidenceBytes,
        wrongHashConfiguration,
        parseCompilerWorkflowRun(successfulRun(), wrongHashConfiguration),
      ),
    assertCode("COMPILER_STAGING_EVIDENCE_SHA256_MISMATCH"),
  );
});
