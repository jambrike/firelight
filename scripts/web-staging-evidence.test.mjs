import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CANONICAL_REPOSITORY,
  WEB_STAGING_EVIDENCE_FILENAME,
  buildWebStagingEvidence,
  captureWebStagingEvidence,
  parseWebStagingCaptureEnvironment,
  serializeWebStagingEvidence,
  sha256,
  validateWebStagingEvidence,
  webStagingArtifactName,
} from "./capture-web-staging-evidence.mjs";
import { CanaryError } from "./postdeploy-canary.mjs";
import {
  parseDownloadedWebStagingEvidence,
  parseWebStagingVerificationEnvironment,
  verifyDownloadedWebStagingEvidence,
} from "./verify-web-staging-evidence.mjs";

const COMMIT_SHA = "a".repeat(40);
const PROJECT_IDENTITY_SHA256 = "b".repeat(64);
const PROJECT_REF_IDENTITY_SHA256 = "d".repeat(64);
const ORGANIZATION_IDENTITY_SHA256 = "c".repeat(64);
const RUN_ID = 123456789;
const RUN_NUMBER = 42;
const RUN_ATTEMPT = 2;
const ARTIFACT_NAME = webStagingArtifactName(RUN_ID, RUN_ATTEMPT);
const STAGING_WORKFLOW_REF =
  `${CANONICAL_REPOSITORY}/.github/workflows/deploy-staging.yml@refs/heads/main`;
const PRODUCTION_WORKFLOW_REF =
  `${CANONICAL_REPOSITORY}/.github/workflows/deploy-production.yml@refs/heads/main`;

function assertCode(expectedCode) {
  return (error) => {
    assert.ok(error instanceof CanaryError);
    assert.equal(error.code, expectedCode);
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
    GITHUB_JOB: "migrate-and-deploy",
    GITHUB_WORKFLOW_REF: STAGING_WORKFLOW_REF,
    GITHUB_WORKFLOW_SHA: COMMIT_SHA,
    GITHUB_SHA: COMMIT_SHA,
    GITHUB_RUN_ID: String(RUN_ID),
    GITHUB_RUN_NUMBER: String(RUN_NUMBER),
    GITHUB_RUN_ATTEMPT: String(RUN_ATTEMPT),
    RUNNER_TEMP: runnerTemp,
    FIRELIGHT_SUPABASE_PROJECT_IDENTITY_SHA256: PROJECT_IDENTITY_SHA256,
    FIRELIGHT_SUPABASE_PROJECT_REF_IDENTITY_SHA256:
      PROJECT_REF_IDENTITY_SHA256,
    FIRELIGHT_SUPABASE_ORGANIZATION_IDENTITY_SHA256:
      ORGANIZATION_IDENTITY_SHA256,
    FIRELIGHT_WEB_STAGING_EVIDENCE_PATH: join(
      runnerTemp,
      WEB_STAGING_EVIDENCE_FILENAME,
    ),
  };
}

function evidenceConfiguration() {
  return {
    commitSha: COMMIT_SHA,
    projectIdentitySha256: PROJECT_IDENTITY_SHA256,
    projectRefIdentitySha256: PROJECT_REF_IDENTITY_SHA256,
    organizationIdentitySha256: ORGANIZATION_IDENTITY_SHA256,
    runId: RUN_ID,
    runNumber: RUN_NUMBER,
    runAttempt: RUN_ATTEMPT,
    artifactName: ARTIFACT_NAME,
  };
}

function verificationEnvironment(runnerTemp, evidenceSha256) {
  return {
    GITHUB_ACTIONS: "true",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_API_URL: "https://api.github.com",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REPOSITORY: CANONICAL_REPOSITORY,
    GITHUB_REF: "refs/heads/main",
    GITHUB_WORKFLOW_REF: PRODUCTION_WORKFLOW_REF,
    GITHUB_WORKFLOW_SHA: COMMIT_SHA,
    GITHUB_SHA: COMMIT_SHA,
    RUNNER_TEMP: runnerTemp,
    FIRELIGHT_STAGING_EVIDENCE_SHA256: evidenceSha256,
    FIRELIGHT_STAGING_RUN_ID: String(RUN_ID),
    FIRELIGHT_STAGING_RUN_NUMBER: String(RUN_NUMBER),
    FIRELIGHT_STAGING_RUN_ATTEMPT: String(RUN_ATTEMPT),
    FIRELIGHT_WEB_STAGING_EVIDENCE_PATH: join(
      runnerTemp,
      "firelight-web-staging-evidence",
      WEB_STAGING_EVIDENCE_FILENAME,
    ),
  };
}

test("capture accepts only the canonical staging acceptance context", () => {
  const parsed = parseWebStagingCaptureEnvironment(
    captureEnvironment("/runner/temp"),
  );
  assert.deepEqual(parsed, {
    ...evidenceConfiguration(),
    runnerTemp: "/runner/temp",
    evidencePath: `/runner/temp/${WEB_STAGING_EVIDENCE_FILENAME}`,
  });
  for (const [name, value, code] of [
    ["GITHUB_REPOSITORY", "fork/firelight", "INVALID_GITHUB_REPOSITORY"],
    ["GITHUB_JOB", "database-target", "INVALID_GITHUB_JOB"],
    ["GITHUB_REF", "refs/heads/release", "INVALID_GITHUB_REF"],
    ["GITHUB_WORKFLOW_SHA", "d".repeat(40), "INVALID_GITHUB_WORKFLOW_SHA"],
    [
      "FIRELIGHT_SUPABASE_PROJECT_IDENTITY_SHA256",
      "B".repeat(64),
      "INVALID_FIRELIGHT_SUPABASE_PROJECT_IDENTITY_SHA256",
    ],
    [
      "FIRELIGHT_SUPABASE_PROJECT_REF_IDENTITY_SHA256",
      "D".repeat(64),
      "INVALID_FIRELIGHT_SUPABASE_PROJECT_REF_IDENTITY_SHA256",
    ],
  ]) {
    assert.throws(
      () => parseWebStagingCaptureEnvironment({
        ...captureEnvironment("/runner/temp"),
        [name]: value,
      }),
      assertCode(code),
    );
  }
});

test("capture writes one exclusive private canonical evidence file", async () => {
  const runnerTemp = await mkdtemp(join(tmpdir(), "firelight-web-evidence-"));
  try {
    const configuration = parseWebStagingCaptureEnvironment(
      captureEnvironment(runnerTemp),
    );
    const result = await captureWebStagingEvidence(configuration);
    const bytes = await readFile(configuration.evidencePath);
    const fileStats = await stat(configuration.evidencePath);
    assert.equal(fileStats.mode & 0o777, 0o600);
    assert.equal(result.evidenceSha256, sha256(bytes));
    assert.equal(result.artifactName, ARTIFACT_NAME);
    assert.deepEqual(JSON.parse(bytes.toString("utf8")), result.evidence);
    assert.equal(
      result.evidence.supabaseProjectIdentitySha256,
      PROJECT_IDENTITY_SHA256,
    );
    assert.equal(
      result.evidence.supabaseProjectRefIdentitySha256,
      PROJECT_REF_IDENTITY_SHA256,
    );
    assert.equal(
      result.evidence.supabaseOrganizationIdentitySha256,
      ORGANIZATION_IDENTITY_SHA256,
    );
    await assert.rejects(
      captureWebStagingEvidence(configuration),
      assertCode("WEB_STAGING_EVIDENCE_WRITE_FAILED"),
    );
  } finally {
    await rm(runnerTemp, { recursive: true, force: true });
  }
});

test("versioned evidence rejects cross-run, cross-project, or extra claims", () => {
  const configuration = evidenceConfiguration();
  const evidence = buildWebStagingEvidence(configuration);
  assert.equal(validateWebStagingEvidence(evidence, configuration), evidence);
  for (const mutation of [
    { version: 3 },
    { commitSha: "d".repeat(40) },
    { environment: "production" },
    { repository: "fork/firelight" },
    { supabaseProjectIdentitySha256: "f".repeat(64) },
    { supabaseProjectRefIdentitySha256: "f".repeat(64) },
    { supabaseOrganizationIdentitySha256: "e".repeat(64) },
    { runId: RUN_ID + 1 },
    { artifactName: "web-staging-evidence-latest" },
    { surprise: true },
  ]) {
    assert.throws(
      () => validateWebStagingEvidence(
        { ...evidence, ...mutation },
        configuration,
      ),
      assertCode("WEB_STAGING_EVIDENCE_MISMATCH"),
    );
  }
});

test("production verification requires the exact run, hash, and download path", () => {
  const parsed = parseWebStagingVerificationEnvironment(
    verificationEnvironment("/runner/temp", "d".repeat(64)),
  );
  assert.equal(parsed.runId, RUN_ID);
  assert.equal(parsed.runAttempt, RUN_ATTEMPT);
  assert.equal(parsed.artifactName, ARTIFACT_NAME);
  assert.equal(parsed.expectedEvidenceSha256, "d".repeat(64));
  for (const [name, value, code] of [
    [
      "FIRELIGHT_STAGING_EVIDENCE_SHA256",
      "D".repeat(64),
      "INVALID_FIRELIGHT_STAGING_EVIDENCE_SHA256",
    ],
    ["FIRELIGHT_STAGING_RUN_ID", "0", "INVALID_FIRELIGHT_STAGING_RUN_ID"],
    [
      "FIRELIGHT_WEB_STAGING_EVIDENCE_PATH",
      "/runner/temp/other.json",
      "INVALID_FIRELIGHT_WEB_STAGING_EVIDENCE_PATH",
    ],
  ]) {
    assert.throws(
      () => parseWebStagingVerificationEnvironment({
        ...verificationEnvironment("/runner/temp", "d".repeat(64)),
        [name]: value,
      }),
      assertCode(code),
    );
  }
});

test("downloaded evidence binds canonical bytes to the explicit hash and run", () => {
  const evidence = buildWebStagingEvidence(evidenceConfiguration());
  const bytes = serializeWebStagingEvidence(evidence);
  const configuration = parseWebStagingVerificationEnvironment(
    verificationEnvironment("/runner/temp", sha256(bytes)),
  );
  const result = parseDownloadedWebStagingEvidence(bytes, configuration);
  assert.equal(result.evidenceSha256, sha256(bytes));
  assert.equal(result.projectIdentitySha256, PROJECT_IDENTITY_SHA256);
  assert.equal(
    result.projectRefIdentitySha256,
    PROJECT_REF_IDENTITY_SHA256,
  );
  assert.equal(
    result.organizationIdentitySha256,
    ORGANIZATION_IDENTITY_SHA256,
  );
  assert.throws(
    () => parseDownloadedWebStagingEvidence(
      bytes,
      { ...configuration, expectedEvidenceSha256: "f".repeat(64) },
    ),
    assertCode("WEB_STAGING_EVIDENCE_HASH_MISMATCH"),
  );
  const noncanonical = Buffer.from(` ${JSON.stringify(evidence)}\n`, "utf8");
  assert.throws(
    () => parseDownloadedWebStagingEvidence(
      noncanonical,
      { ...configuration, expectedEvidenceSha256: sha256(noncanonical) },
    ),
    assertCode("WEB_STAGING_EVIDENCE_NONCANONICAL"),
  );
});

test("filesystem verification rejects symlink-shaped paths and accepts one file", async () => {
  const runnerTemp = await mkdtemp(join(tmpdir(), "firelight-web-download-"));
  try {
    const evidence = buildWebStagingEvidence(evidenceConfiguration());
    const bytes = serializeWebStagingEvidence(evidence);
    const configuration = parseWebStagingVerificationEnvironment(
      verificationEnvironment(runnerTemp, sha256(bytes)),
    );
    await mkdir(join(runnerTemp, "firelight-web-staging-evidence"));
    await writeFile(configuration.evidencePath, bytes, { mode: 0o600 });
    const result = await verifyDownloadedWebStagingEvidence(configuration);
    assert.equal(result.projectIdentitySha256, PROJECT_IDENTITY_SHA256);
    assert.equal(
      result.projectRefIdentitySha256,
      PROJECT_REF_IDENTITY_SHA256,
    );
  } finally {
    await rm(runnerTemp, { recursive: true, force: true });
  }
});
