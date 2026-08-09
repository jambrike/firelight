import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";
import {
  CANONICAL_REPOSITORY,
  webStagingArtifactName,
} from "./capture-web-staging-evidence.mjs";
import { CanaryError } from "./postdeploy-canary.mjs";
import {
  buildWorkflowRunUrl,
  parseStagingEvidence,
  parseStagingEvidenceEnvironment,
  verifyStagingEvidence,
} from "./verify-staging-evidence.mjs";

/* global AbortSignal, Response */

const SHA = "b".repeat(40);
const TOKEN = "github-token-that-must-remain-private";
const RUN_ID = 123456789;
const RUN_NUMBER = 42;
const RUN_ATTEMPT = 2;
const REPOSITORY_ID = 987654321;
const WORKFLOW_REF =
  `${CANONICAL_REPOSITORY}/.github/workflows/deploy-production.yml@refs/heads/main`;
const environment = {
  GITHUB_ACTIONS: "true",
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_API_URL: "https://api.github.com",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REPOSITORY: CANONICAL_REPOSITORY,
  GITHUB_REF: "refs/heads/main",
  GITHUB_WORKFLOW_REF: WORKFLOW_REF,
  GITHUB_WORKFLOW_SHA: SHA,
  GITHUB_SHA: SHA,
  GITHUB_TOKEN: TOKEN,
  FIRELIGHT_STAGING_RUN_ID: String(RUN_ID),
};

function assertCanaryCode(expectedCode) {
  return (error) => {
    assert.ok(error instanceof CanaryError);
    assert.equal(error.code, expectedCode);
    assert.equal(error.message.includes(TOKEN), false);
    return true;
  };
}

function successfulRun(overrides = {}) {
  return {
    id: RUN_ID,
    run_number: RUN_NUMBER,
    run_attempt: RUN_ATTEMPT,
    head_sha: SHA,
    head_branch: "main",
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    path: ".github/workflows/deploy-staging.yml@main",
    repository: {
      id: REPOSITORY_ID,
      full_name: CANONICAL_REPOSITORY,
    },
    ...overrides,
  };
}

test("staging run verification accepts only the canonical production context", () => {
  assert.deepEqual(parseStagingEvidenceEnvironment(environment), {
    apiUrl: "https://api.github.com",
    owner: "jambrike",
    repository: "firelight",
    sha: SHA,
    token: TOKEN,
    expectedRunId: RUN_ID,
  });
  for (const [name, value, code] of [
    ["GITHUB_ACTIONS", "false", "INVALID_GITHUB_ACTIONS"],
    ["GITHUB_REPOSITORY", "fork/firelight", "INVALID_GITHUB_REPOSITORY"],
    ["GITHUB_REF", "refs/heads/release", "INVALID_GITHUB_REF"],
    ["GITHUB_WORKFLOW_SHA", "c".repeat(40), "INVALID_GITHUB_WORKFLOW_SHA"],
    ["FIRELIGHT_STAGING_RUN_ID", "0", "INVALID_FIRELIGHT_STAGING_RUN_ID"],
  ]) {
    assert.throws(
      () => parseStagingEvidenceEnvironment({ ...environment, [name]: value }),
      assertCanaryCode(code),
    );
  }
});

test("workflow URL pins one explicit staging run ID", () => {
  const configuration = parseStagingEvidenceEnvironment(environment);
  const url = new URL(buildWorkflowRunUrl(configuration));
  assert.equal(
    url.pathname,
    `/repos/jambrike/firelight/actions/runs/${RUN_ID}`,
  );
  assert.equal(url.search, "");
  assert.equal(url.href.includes(TOKEN), false);
});

test("staging run metadata must bind the exact SHA, workflow, and repository", () => {
  const configuration = parseStagingEvidenceEnvironment(environment);
  assert.deepEqual(parseStagingEvidence(successfulRun(), configuration), {
    runId: RUN_ID,
    runNumber: RUN_NUMBER,
    runAttempt: RUN_ATTEMPT,
    headSha: SHA,
    repositoryId: REPOSITORY_ID,
    artifactName: webStagingArtifactName(RUN_ID, RUN_ATTEMPT),
  });

  for (const overrides of [
    { id: RUN_ID + 1 },
    { head_sha: "c".repeat(40) },
    { head_branch: "feature" },
    { event: "push" },
    { status: "in_progress" },
    { conclusion: "failure" },
    { path: ".github/workflows/ci.yml@main" },
    {
      repository: { id: REPOSITORY_ID, full_name: "fork/firelight" },
    },
  ]) {
    assert.throws(
      () => parseStagingEvidence(successfulRun(overrides), configuration),
      assertCanaryCode("STAGING_RUN_MISMATCH"),
    );
  }
});

test("staging run verification sends one bounded authenticated API request", async () => {
  const configuration = parseStagingEvidenceEnvironment(environment);
  let requests = 0;
  const result = await verifyStagingEvidence(configuration, async (input, init) => {
    requests += 1;
    assert.equal(String(input), buildWorkflowRunUrl(configuration));
    assert.equal(init.method, "GET");
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(init.headers.Accept, "application/vnd.github+json");
    assert.equal(init.headers["X-GitHub-Api-Version"], "2026-03-10");
    assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
    return new Response(JSON.stringify(successfulRun()), {
      headers: { "Content-Type": "application/json" },
    });
  });
  assert.equal(result.runId, RUN_ID);
  assert.equal(result.artifactName, webStagingArtifactName(RUN_ID, RUN_ATTEMPT));
  assert.equal(requests, 1);
});

test("GitHub failures expose only stable codes", async () => {
  const configuration = parseStagingEvidenceEnvironment(environment);
  await assert.rejects(
    verifyStagingEvidence(
      configuration,
      async () => new Response(`credential ${TOKEN} rejected`, { status: 403 }),
    ),
    assertCanaryCode("GITHUB_AUTH_FAILED"),
  );
});
